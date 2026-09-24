import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { decodeSendCursor, encodeSendCursor } from "../shared/cursor";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { clearFakeOutbox, failFakeSendBatch } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { freeze } from "../src/send/schedule";
import { applyDeliveryEvents } from "../src/services/webhook_events";
import { adminAuth } from "./support/auth";

// Every change a reader could see of a send moves its `rev` along one app-wide sequence,
// and a list read hands back a cursor at that sequence (SPEC §8), so a client can later
// ask what changed since and miss nothing, whichever client made the change. A lease
// renewal is not such a change. List rows carry the same phase and attention as the
// send's `/progress`.

const config = () => getConfig(env);
const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

const tpl = (marker: string) =>
  `<div>{{ post.body }}<p>${marker} · {{ publication.name }}</p><a href="{{ email.unsubscribeUrl }}">Unsubscribe</a></div>`;

async function seedConfirmed(email: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
  )
    .bind(`id-${email}`, email, `cfm-${email}`, `uns-${email}`, now, now)
    .run();
}

/** A send frozen straight through `freeze`, so a test can place its fire time anywhere
 *  (the API refuses one inside the minimum lead). */
async function frozenSend(fireAt: number, subject = "Subj") {
  const { post } = await posts.createPost(env.DB, { subject, markdown: "# Hi\n\nbody" }, "test");
  return freeze(env, config(), post, fireAt);
}

async function rev(id: string): Promise<number> {
  const row = await sends.getSend(env.DB, id);
  if (!row) {
    throw new Error(`send ${id} not found`);
  }
  return row.rev;
}

/** The sequence now, read the way the list reads it. */
async function seq(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT MAX(COALESCE((SELECT MAX(rev) FROM sends), 0), COALESCE((SELECT MAX(rev) FROM send_tombstones), 0)) AS value",
  ).first<{ value: number }>();
  return row!.value;
}

async function listSends(query = ""): Promise<any> {
  const res = await SELF.fetch(`${base}/sends${query}`, { headers: AUTH });
  expect(res.status).toBe(200);
  return readJson(res);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deliveries"),
    env.DB.prepare("DELETE FROM notifications"),
    env.DB.prepare("DELETE FROM sends"),
    env.DB.prepare("DELETE FROM images"),
    env.DB.prepare("DELETE FROM post_revisions"),
    env.DB.prepare("DELETE FROM posts"),
    env.DB.prepare("DELETE FROM suppressions"),
    env.DB.prepare("DELETE FROM subscribers"),
    env.DB.prepare("DELETE FROM settings"),
  ]);
  clearFakeOutbox();
});

describe("a send's rev", () => {
  it("is stamped from the one sequence when a send is scheduled, above every rev before it", async () => {
    const before = await seq();
    const a = await frozenSend(Date.now() + 3_600_000, "A");
    const b = await frozenSend(Date.now() + 3_600_000, "B");
    expect(await rev(a.id)).toBeGreaterThan(before);
    expect(await rev(b.id)).toBeGreaterThan(await rev(a.id));
    expect(await seq()).toBe(await rev(b.id));
  });

  it("moves on a cancel and a reschedule through the API, past a change to another send", async () => {
    const a = await frozenSend(Date.now() + 3_600_000, "A");
    const b = await frozenSend(Date.now() + 3_600_000, "B");
    const bBefore = await rev(b.id);

    const moved = await SELF.fetch(`${base}/sends/${a.id}/reschedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: new Date(Date.now() + 7_200_000).toISOString() }),
    });
    expect(moved.status).toBe(200);
    const afterMove = await rev(a.id);
    expect(afterMove).toBeGreaterThan(bBefore);
    // The response carries the stamped row, so the client that acted knows the rev too.
    expect((await readJson(moved)).send.rev).toBe(afterMove);

    const canceled = await SELF.fetch(`${base}/sends/${b.id}/cancel`, {
      method: "POST",
      headers: AUTH,
    });
    expect(canceled.status).toBe(200);
    expect(await rev(b.id)).toBeGreaterThan(afterMove);
    expect(await rev(a.id)).toBe(afterMove); // a change to one send leaves the other alone
  });

  it("moves when a template change re-makes a scheduled send's email", async () => {
    const put = (body: unknown) =>
      SELF.fetch(`${base}/api/settings`, {
        method: "PUT",
        headers: JSON_AUTH,
        body: JSON.stringify(body),
      });
    expect((await put({ emailTemplate: tpl("v1") })).status).toBe(200);
    const a = await frozenSend(Date.now() + 3_600_000);
    const before = await rev(a.id);
    expect((await put({ emailTemplate: tpl("v2"), remake: [a.id] })).status).toBe(200);
    expect(await rev(a.id)).toBeGreaterThan(before);
  });

  it("moves as the send loop moves the counters, and as a webhook receipt lands", async () => {
    await seedConfirmed("a@example.com");
    const send = await frozenSend(Date.now() - 1000);
    const scheduled = await rev(send.id);
    await runSend(env, send.id);
    const sent = await rev(send.id);
    expect(sent).toBeGreaterThan(scheduled);
    expect((await sends.getSend(env.DB, send.id))?.c_accepted).toBe(1);

    await applyDeliveryEvents(env.DB, [
      { type: "delivered", providerId: `fake-${send.id}:a@example.com` },
    ]);
    expect((await sends.getSend(env.DB, send.id))?.c_delivered).toBe(1);
    expect(await rev(send.id)).toBeGreaterThan(sent);
  });

  it("moves when a send completes", async () => {
    await seedConfirmed("a@example.com");
    const send = await frozenSend(Date.now() - 1000);
    const lease = await sends.acquireLease(env.DB, send.id, Date.now(), 60_000);
    const before = await rev(send.id);
    // No recipient handed off, so only the completion itself (and its exactness pass)
    // writes the send. The source scan below is what holds each statement to its stamp.
    await sends.completeSend(env.DB, send.id, send.post_id, Date.now(), lease);
    expect((await sends.getSend(env.DB, send.id))?.status).toBe("sent");
    expect(await rev(send.id)).toBeGreaterThan(before);
  });

  it("does not move on a lease renewal, but does when the lease is taken or released", async () => {
    await seedConfirmed("a@example.com");
    const send = await frozenSend(Date.now() - 1000);
    const now = Date.now();
    const before = await rev(send.id);

    const lease = await sends.acquireLease(env.DB, send.id, now, 60_000);
    expect(lease).not.toBeNull();
    const taken = await rev(send.id);
    expect(taken).toBeGreaterThan(before); // scheduled → sending, and a lease now held

    const sequence = await seq();
    expect(await sends.renewLease(env.DB, send.id, lease!, now + 120_000)).toBe(true);
    expect(await sends.renewLease(env.DB, send.id, lease!, now + 180_000)).toBe(true);
    expect(await rev(send.id)).toBe(taken);
    expect(await seq()).toBe(sequence); // nothing else took a number either

    // Whether a lease is held tells a wedged send from one finishing its last batch.
    await sends.releaseLease(env.DB, send.id, lease!);
    expect(await rev(send.id)).toBeGreaterThan(taken);
  });

  it("does not move on a compare-and-swap that matches no row", async () => {
    const send = await frozenSend(Date.now() + 3_600_000);
    await sends.cancelStmt(env.DB, send.id, Date.now()).run();
    const canceled = await rev(send.id);
    const sequence = await seq();
    // A reschedule's CAS on a send that is no longer scheduled changes zero rows.
    const res = await sends.rescheduleStmt(env.DB, send.id, Date.now() + 7_200_000).run();
    expect(res.meta.changes).toBe(0);
    expect(await rev(send.id)).toBe(canceled);
    expect(await seq()).toBe(sequence);
  });

  it("takes a number for a delete, so it never falls back and the removal is itself a change", async () => {
    const kept = await frozenSend(Date.now() + 3_600_000, "kept");
    const gone = await frozenSend(Date.now() + 3_600_000, "gone");
    await sends.cancelStmt(env.DB, gone.id, Date.now()).run();
    await env.DB.prepare("UPDATE posts SET status = 'draft' WHERE id = ?").bind(gone.post_id).run();
    const top = await rev(gone.id);
    expect(top).toBe(await seq());

    await posts.deletePost(env.DB, gone.post_id);
    expect(await sends.getSend(env.DB, gone.id)).toBeNull();
    // A client whose cursor is at `top` listed the send; the sequence moving past it is
    // what tells that client something it listed may be gone.
    const removed = await seq();
    expect(removed).toBeGreaterThan(top);
    // The next change is numbered past the deleted send's, which a cursor may already hold.
    await sends.cancelStmt(env.DB, kept.id, Date.now()).run();
    expect(await rev(kept.id)).toBeGreaterThan(removed);
  });
});

// Every file under src/, as text: the check below reads the SQL where it is written.
const SOURCES = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("every write to sends", () => {
  it("stamps NEXT_REV, but for the lease renewal, and every delete leaves a tombstone first", () => {
    // Any verb that writes a table, in any case, with or without a schema or brackets.
    const writes =
      /\b(UPDATE(?:\s+OR\s+\w+)?|(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO|DELETE\s+FROM)\s+(?:main\.)?\[?sends\b\]?/gi;
    const stamp = /\brev\s*=\s*\$\{NEXT_REV\}/;
    let seen = 0;
    for (const [file, text] of Object.entries(SOURCES)) {
      // Comments can mention SQL (or the helpers) without running it; only code counts.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const match of code.matchAll(writes)) {
        seen += 1;
        const at = match.index ?? 0;
        // The statement runs to the end of the string literal it is written in, which the
        // quote opening it names (a template literal may hold `"` in an interpolation).
        const before = code.slice(0, at);
        const quote = before.lastIndexOf("`") > before.lastIndexOf('"') ? "`" : '"';
        const rest = code.slice(at);
        const statement = rest.slice(0, rest.indexOf(quote));
        const where = `${file}: ${statement.slice(0, 80)}`;
        const verb = (match[1] ?? "").toUpperCase();
        if (verb.startsWith("DELETE")) {
          // The tombstone is the statement just before, in the same batch.
          expect(before.slice(-120), where).toMatch(
            /tombstoneSendsStmt\(db, [^)]*\),\s*db\.prepare\(\s*["`]$/,
          );
        } else if (verb.startsWith("UPDATE")) {
          if (/^UPDATE sends SET locked_until = \? WHERE/.test(statement)) {
            continue; // the renewal, the one write that changes nothing a reader sees
          }
          // The SET list runs to the statement's last WHERE (a subquery in it has its own).
          const wheres = [...statement.matchAll(/\bWHERE\b/gi)];
          const set = statement.slice(0, wheres.at(-1)?.index ?? statement.length);
          expect(set, where).toMatch(stamp);
        } else {
          // An insert names `rev` among its columns and gives it NEXT_REV.
          const columns = statement.slice(statement.indexOf("("), statement.indexOf(")") + 1);
          expect(columns, where).toMatch(/\brev\b/);
          // biome-ignore lint/suspicious/noTemplateCurlyInString: matches the source text of the interpolation, not a value
          expect(statement.slice(statement.indexOf(")") + 1), where).toContain("${NEXT_REV}");
        }
      }
    }
    expect(seen).toBeGreaterThan(15); // the scan found the writes it is meant to check
  });
});

describe("migration 0003", () => {
  it("keeps send_rev_floor for the Worker still serving between migrate and deploy, and adds the tombstones", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('send_rev_floor', 'send_tombstones') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["send_rev_floor", "send_tombstones"]);
  });
});

describe("GET /sends", () => {
  it("returns a cursor, `<seq>.<at>` in decimal, at the sequence it read, which a later change passes", async () => {
    const a = await frozenSend(Date.now() + 3_600_000);
    const body = await listSends();
    expect(body.cursor).toMatch(/^\d+\.\d+$/); // the documented format any client may read
    const cursor = decodeSendCursor(body.cursor);
    expect(cursor).not.toBeNull();
    expect(cursor!.seq).toBe(await seq());
    expect(cursor!.at).toBeLessThanOrEqual(Date.now());
    expect(body.sends[0].rev).toBeLessThanOrEqual(cursor!.seq);

    await sends.cancelStmt(env.DB, a.id, Date.now()).run();
    expect(await rev(a.id)).toBeGreaterThan(cursor!.seq);
  });

  it("returns a cursor on an empty list", async () => {
    const body = await listSends();
    expect(body.sends).toEqual([]);
    expect(decodeSendCursor(body.cursor)?.seq).toBe(await seq());
  });

  it("rows carry the phase and attention their /progress reports, keeping every field", async () => {
    await seedConfirmed("a@example.com");
    await seedConfirmed("b@example.com");
    // scheduled, due, canceled, settling, and a send retrying a recipient
    const scheduled = await frozenSend(Date.now() + 3_600_000, "scheduled");
    const due = await frozenSend(Date.now() - 1000, "due");
    const canceled = await frozenSend(Date.now() + 3_600_000, "canceled");
    await sends.cancelStmt(env.DB, canceled.id, Date.now()).run();
    const settling = await frozenSend(Date.now() - 1000, "settling");
    await runSend(env, settling.id);
    const retrying = await frozenSend(Date.now() - 1000, "retrying");
    failFakeSendBatch(1);
    await runSend(env, retrying.id); // left sending, both recipients held in the queue
    // One of them in flight and the other retried: work remains, and the retry probe is
    // the only thing that tells `retrying` from `progressing`.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE deliveries SET status = 'dispatched' WHERE send_id = ? AND email = 'a@example.com'",
      ).bind(retrying.id),
      env.DB.prepare(
        "UPDATE deliveries SET attempts = 1 WHERE send_id = ? AND email = 'b@example.com'",
      ).bind(retrying.id),
      env.DB.prepare(
        "UPDATE sends SET c_pending = c_pending - 1, c_in_flight = c_in_flight + 1 WHERE id = ?",
      ).bind(retrying.id),
    ]);

    const { sends: rows } = await listSends();
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    const expected: Record<string, string> = {
      [scheduled.id]: "scheduled",
      [due.id]: "due",
      [canceled.id]: "canceled",
      [settling.id]: "settling",
      [retrying.id]: "retrying",
    };
    for (const [id, phase] of Object.entries(expected)) {
      const row: any = byId.get(id);
      const progress = await readJson(
        await SELF.fetch(`${base}/sends/${id}/progress`, { headers: AUTH }),
      );
      expect(row.phase).toBe(phase);
      expect(row.phase).toBe(progress.phase);
      expect(row.attention).toEqual(progress.attention);
      expect(row.stuck).toBe(progress.attention.stuck);
      expect(row.rev).toBe(await rev(id));
      // The existing fields stay, the internal probe and the frozen bodies stay out.
      const stored = await sends.getSend(env.DB, id);
      const { rendered_html: _h, rendered_text: _t, lease_token: _l, ...summary } = stored as any;
      expect(row).toMatchObject(summary);
      expect(row).not.toHaveProperty("has_retries");
      expect(row).not.toHaveProperty("rendered_html");
    }
  });
});

describe("the send cursor", () => {
  it("round-trips, and refuses what this server did not issue", () => {
    const cursor = { seq: 12345, at: 1_790_000_000_000 };
    expect(decodeSendCursor(encodeSendCursor(cursor))).toEqual(cursor);
    expect(decodeSendCursor(encodeSendCursor({ seq: 0, at: 0 }))).toEqual({ seq: 0, at: 0 });
    for (const bad of [
      "",
      "12",
      "a.b.c",
      "-1.5",
      "1.",
      ".1",
      "ZZ.1",
      "1 .2",
      "1a.2",
      "1.5e3",
      "99999999999999999999.1",
    ]) {
      expect(decodeSendCursor(bad)).toBeNull();
    }
  });
});
