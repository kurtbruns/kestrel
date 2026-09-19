import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recomputeSendCounters } from "../src/db/sends";
import { currentTemplateRevision } from "../src/services/template_history";
import { adminAuth } from "./support/auth";

// PR1 (#147/#148): the Drafts view scopes /posts to draft+scheduled via a comma status
// list, and a sent post opens the read-only record view backed by GET /sends/:id
// (outcome breakdown + published flag) and its CSV export.

const AUTH = await adminAuth();
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function createDraft(subject: string): Promise<string> {
  const r = await readJson(
    await SELF.fetch(`${base}/posts`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ subject, markdown: "# hi\n\nbody" }),
    }),
  );
  return r.post.id;
}

describe("Drafts filter — /posts?status=draft,scheduled", () => {
  it("matches draft + scheduled together but never sent", async () => {
    const marker = `dfilter-${uniq()}`;
    const draftId = await createDraft(`${marker} draft`);
    const schedId = await createDraft(`${marker} sched`);
    await SELF.fetch(`${base}/posts/${schedId}/schedule`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ fire_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
    });
    // A sent post inserted directly — the filter is what's under test, not the send loop.
    const now = Date.now();
    const sentId = `p-sent-${uniq()}`;
    await env.DB.prepare(
      "INSERT INTO posts (id, slug, subject, status, created_at, updated_at) VALUES (?, ?, ?, 'sent', ?, ?)",
    )
      .bind(sentId, `${marker}-sent`, `${marker} sent`, now, now)
      .run();

    const drafts = await readJson(
      await SELF.fetch(`${base}/posts?search=${marker}&status=draft,scheduled`, { headers: AUTH }),
    );
    expect(drafts.posts.map((p: any) => p.id).sort()).toEqual([draftId, schedId].sort());
    expect(drafts.page.total).toBe(2);

    const sent = await readJson(
      await SELF.fetch(`${base}/posts?search=${marker}&status=sent`, { headers: AUTH }),
    );
    expect(sent.posts.map((p: any) => p.id)).toEqual([sentId]);

    // No status → everything, so the comma list is a real narrowing, not a no-op.
    const all = await readJson(
      await SELF.fetch(`${base}/posts?search=${marker}`, { headers: AUTH }),
    );
    expect(all.page.total).toBe(3);
  });
});

interface SeedDelivery {
  email: string;
  status: string;
  event?: string | null;
  bounce_kind?: string | null;
}

async function seedSentSend(subject: string, slug: string, deliveries: SeedDelivery[]) {
  const now = Date.now();
  const postId = `p-${uniq()}`;
  const sendId = `s-${uniq()}`;
  await env.DB.prepare(
    "INSERT INTO posts (id, slug, subject, status, created_at, updated_at) VALUES (?, ?, ?, 'sent', ?, ?)",
  )
    .bind(postId, slug, subject, now, now)
    .run();
  const tpl = (await currentTemplateRevision(env.DB)).id; // every send pins a revision
  await env.DB.prepare(
    "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, recipient_count, template_revision, scheduled_at, started_at, completed_at) VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      sendId,
      postId,
      now - 1000,
      "<p>frozen</p>",
      "frozen",
      subject,
      deliveries.length,
      tpl,
      now - 2000,
      now - 1500,
      now - 1000,
    )
    .run();
  let i = 0;
  for (const d of deliveries) {
    await env.DB.prepare(
      "INSERT INTO deliveries (id, send_id, email, status, provider_id, error, attempts, updated_at, event, event_detail, event_at, bounce_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        `d-${sendId}-${i++}`,
        sendId,
        d.email,
        d.status,
        d.status === "accepted" ? `pid-${i}` : null,
        d.status === "unsent" ? "550 mailbox unavailable" : null,
        1,
        now,
        d.event ?? null,
        null,
        d.event ? now : null,
        d.bounce_kind ?? null,
      )
      .run();
  }
  // Seed the denormalized counters from the rows just as the real send path does at
  // completion (the exactness pass in completeSend), so the seeded row carries the same
  // c_* counters production would — what GET /sends/:id's `progress` now reads (#166).
  await recomputeSendCounters(env.DB, sendId);
  return { postId, sendId };
}

// #162: a post stays `scheduled` while its send is in flight, but it's no longer an
// editable/cancelable draft — the list carries the active send's id + status so the
// Drafts page can relabel/route it, and GET /posts points the editor at the live watch.
describe("in-flight post routing (#162)", () => {
  it("surfaces a sending post as active and routes it to the watch, not the editor", async () => {
    const marker = `inflight-${uniq()}`;
    const postId = await createDraft(`${marker} post`);
    const sched = await readJson(
      await SELF.fetch(`${base}/posts/${postId}/schedule`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ fire_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }),
      }),
    );
    const sendId = sched.send.id;
    // Flip the send in flight, as the sweep would (the post stays `scheduled`).
    await env.DB.prepare("UPDATE sends SET status = 'sending' WHERE id = ?").bind(sendId).run();

    // GET /posts/:id reports `sending` (not `scheduled`) so the editor redirects to the watch.
    const detail = await readJson(await SELF.fetch(`${base}/posts/${postId}`, { headers: AUTH }));
    expect(detail.sending).toEqual({ id: sendId });
    expect(detail.scheduled).toBeNull();

    // The list row carries the active send's id + status for the Drafts relabel/route.
    const list = await readJson(
      await SELF.fetch(`${base}/posts?search=${marker}&status=draft,scheduled`, { headers: AUTH }),
    );
    const row = list.posts.find((p: any) => p.id === postId);
    expect(row.active_send_status).toBe("sending");
    expect(row.active_send_id).toBe(sendId);
  });
});

describe("Sent list — delivery-failures filter (/sends?failures=only)", () => {
  it("narrows to sends with any bounce, complaint, or unsent recipient", async () => {
    const marker = `posts-${uniq()}`;
    const { sendId: clean } = await seedSentSend(`${marker} clean`, `${marker}-clean`, [
      { email: "a@example.com", status: "accepted", event: "delivered" },
      { email: "b@example.com", status: "accepted", event: "delivered" },
    ]);
    const { sendId: bounced } = await seedSentSend(`${marker} bounced`, `${marker}-bounced`, [
      { email: "c@example.com", status: "accepted", event: "delivered" },
      { email: "d@example.com", status: "accepted", event: "bounced", bounce_kind: "soft" },
    ]);
    // An unsent recipient alone is a delivery failure too — it's the third counter in the sum.
    const { sendId: unsent } = await seedSentSend(`${marker} unsent`, `${marker}-unsent`, [
      { email: "e@example.com", status: "accepted", event: "delivered" },
      { email: "f@example.com", status: "unsent" },
    ]);

    const all = await readJson(
      await SELF.fetch(`${base}/sends?search=${marker}`, { headers: AUTH }),
    );
    expect(all.page.total).toBe(3);

    const only = await readJson(
      await SELF.fetch(`${base}/sends?search=${marker}&failures=only`, { headers: AUTH }),
    );
    expect(only.page.total).toBe(2);
    const ids = only.sends.map((s: any) => s.id).sort();
    expect(ids).toEqual([bounced, unsent].sort());
    expect(ids).not.toContain(clean);

    // Any other value is ignored, not an error — the flag is `only` or absent.
    const junk = await readJson(
      await SELF.fetch(`${base}/sends?search=${marker}&failures=yes`, { headers: AUTH }),
    );
    expect(junk.page.total).toBe(3);
  });
});

describe("sent record view — GET /sends/:id", () => {
  it("returns outcome buckets that reconcile to the frozen audience, plus published", async () => {
    const slug = `rec-${uniq()}`;
    const deliveries: SeedDelivery[] = [
      ...Array.from({ length: 5 }, (_, n) => ({
        email: `ok${n}@example.com`,
        status: "accepted",
        event: "delivered",
      })),
      { email: "bounce@example.com", status: "accepted", event: "bounced" },
      { email: "spam@example.com", status: "accepted", event: "complained" },
      { email: "fail@example.com", status: "unsent" },
      { email: "skip@example.com", status: "skipped" },
      { email: "pending@example.com", status: "accepted" }, // accepted, no event yet
    ];
    const { sendId } = await seedSentSend("Record Test", slug, deliveries);

    const body = await readJson(await SELF.fetch(`${base}/sends/${sendId}`, { headers: AUTH }));
    const o = body.outcomes;
    expect(o).toMatchObject({
      recipients: 10,
      delivered: 5,
      bounced: 1,
      complained: 1,
      unsent: 1,
      skipped: 1,
      accepted: 1,
      in_flight: 0,
    });
    // Every recipient lands in exactly one bucket — the buckets sum to the audience.
    const sum =
      o.delivered + o.bounced + o.complained + o.unsent + o.skipped + o.accepted + o.in_flight;
    expect(sum).toBe(o.recipients);

    // `progress` is now the single-row buildSendProgress shape (off the c_* counters),
    // not the old per-row deliveryRollup (#166). Its counts read TRUE delivered — so a
    // list built on it agrees with the record's own breakdown, never counting a bounced
    // recipient as delivered (#90).
    const p = body.progress;
    expect(p.state).toBe("sent");
    expect(p.total).toBe(o.recipients);
    expect(p.counts).toMatchObject({
      delivered: o.delivered,
      bounced: o.bounced,
      complained: o.complained,
      unsent: o.unsent,
      skipped: o.skipped,
      accepted: o.accepted,
    });
    // The seed has 8 provider-accepted rows but only 5 confirmed-delivered — the exact gap
    // the old "Delivered = provider-accepted" column got wrong (#90). `delivered` is 5.
    expect(p.counts.delivered).toBe(5);

    expect(body.published).toBe(true);
    expect(body.archive_url).toContain(slug);
  });

  it("exports the per-recipient delivery record as CSV", async () => {
    const slug = `csv-${uniq()}`;
    const { sendId } = await seedSentSend("CSV Test", slug, [
      { email: "a@example.com", status: "accepted", event: "delivered" },
      { email: "b@example.com", status: "accepted", event: "bounced" },
      { email: "c@example.com", status: "unsent" },
    ]);

    const res = await SELF.fetch(`${base}/sends/${sendId}/deliveries.csv`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(`${slug}-deliveries.csv`);

    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe("email,status,event,event_at,error");
    expect(lines).toHaveLength(4); // header + 3 recipients
    expect(text).toContain("b@example.com,accepted,bounced,");
    expect(text).toContain("c@example.com,unsent,,");
  });

  it("requires auth", async () => {
    expect((await SELF.fetch(`${base}/sends/whatever/deliveries.csv`)).status).toBe(401);
  });
});

// #164: the record view shows the per-recipient rows in-app, not just as the CSV — a
// paginated, filterable JSON endpoint read DIRECTLY off `deliveries` (the source of
// truth), not the `c_*` counters. The default view is "failures" (bounced/complained/
// unsent), and a bounce splits soft vs hard on the per-send `bounce_kind` frozen at
// ingest (SPEC §8) — a fact of this send, not a read of the global suppression list.
describe("per-recipient record — GET /sends/:id/deliveries (#164)", () => {
  // Storage isn't isolated between tests in this file, and `suppressions.email` is a
  // global PK, so each record gets a unique address tag. The `fail/hard/soft/spam`
  // prefixes still sort the same way, so the default email-asc order is deterministic.
  async function seedRecord() {
    const tag = uniq();
    const e = {
      d1: `d1-${tag}@example.com`,
      d2: `d2-${tag}@example.com`,
      hard: `hard-${tag}@example.com`,
      soft: `soft-${tag}@example.com`,
      spam: `spam-${tag}@example.com`,
      fail: `fail-${tag}@example.com`,
      skip: `skip-${tag}@example.com`,
      wait: `wait-${tag}@example.com`,
    };
    // The soft/hard split is carried on the delivery row itself (`bounce_kind`), the way
    // the webhook ingest freezes it — not inferred from the mutable `suppressions` table.
    const { sendId } = await seedSentSend("Rows Test", `rows-${tag}`, [
      { email: e.d1, status: "accepted", event: "delivered" },
      { email: e.d2, status: "accepted", event: "delivered" },
      { email: e.hard, status: "accepted", event: "bounced", bounce_kind: "hard" },
      { email: e.soft, status: "accepted", event: "bounced", bounce_kind: "soft" },
      { email: e.spam, status: "accepted", event: "complained" },
      { email: e.fail, status: "unsent" },
      { email: e.skip, status: "skipped" },
      { email: e.wait, status: "accepted" }, // accepted, no event yet
    ]);
    return { sendId, e };
  }

  it("defaults to the failures view (bounced/complained/unsent), email-sorted", async () => {
    const { sendId, e } = await seedRecord();
    const body = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries`, { headers: AUTH }),
    );
    expect(body.view).toBe("failures");
    // Only the rows that went wrong, and in the default email-asc order (matches the CSV).
    expect(body.deliveries.map((d: any) => d.email)).toEqual([e.fail, e.hard, e.soft, e.spam]);
    expect(body.page).toMatchObject({ total: 4, sort: "email", dir: "asc" });
  });

  it("splits soft vs hard bounce on the per-send frozen kind", async () => {
    const { sendId, e } = await seedRecord();
    const body = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries`, { headers: AUTH }),
    );
    const byEmail = Object.fromEntries(body.deliveries.map((d: any) => [d.email, d]));
    expect(byEmail[e.hard]).toMatchObject({ event: "bounced", bounce_kind: "hard" });
    expect(byEmail[e.soft]).toMatchObject({ event: "bounced", bounce_kind: "soft" });
  });

  it("keeps the soft/hard label frozen — a later global suppression can't rewrite it", async () => {
    // The bug this replaces: reading the label from the global `suppressions` table let an
    // unrelated later suppression of the same address flip this frozen record's outcome
    // (SPEC §8). Suppress the soft-bounced address as another send would, then re-read: the
    // record still reports the soft bounce it recorded, because the label is a fact of the row.
    const { sendId, e } = await seedRecord();
    await env.DB.prepare(
      "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, 'bounce', 'hard bounce', ?)",
    )
      .bind(e.soft, Date.now())
      .run();
    const body = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries`, { headers: AUTH }),
    );
    const byEmail = Object.fromEntries(body.deliveries.map((d: any) => [d.email, d]));
    expect(byEmail[e.soft]).toMatchObject({ event: "bounced", bounce_kind: "soft" });
  });

  it("filters to delivered, and to a single bucket", async () => {
    const { sendId, e } = await seedRecord();
    const del = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries?view=delivered`, { headers: AUTH }),
    );
    expect(del.deliveries.map((d: any) => d.email)).toEqual([e.d1, e.d2]);
    expect(del.deliveries.every((d: any) => d.event === "delivered")).toBe(true);

    const unsent = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries?view=unsent`, { headers: AUTH }),
    );
    expect(unsent.deliveries.map((d: any) => d.email)).toEqual([e.fail]);
  });

  it("shows all recipients and paginates", async () => {
    const { sendId } = await seedRecord();
    const all = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries?view=all`, { headers: AUTH }),
    );
    expect(all.page.total).toBe(8);

    const p1 = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries?view=all&limit=3&offset=0`, {
        headers: AUTH,
      }),
    );
    expect(p1.deliveries).toHaveLength(3);
    expect(p1.page).toMatchObject({ total: 8, limit: 3, offset: 0 });

    const p3 = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries?view=all&limit=3&offset=6`, {
        headers: AUTH,
      }),
    );
    expect(p3.deliveries).toHaveLength(2); // the tail page: 8 − 6
  });

  it("searches by address and falls back to failures on an unknown view", async () => {
    const { sendId, e } = await seedRecord();
    const hit = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries?view=all&search=HARD-`, {
        headers: AUTH,
      }),
    );
    expect(hit.deliveries.map((d: any) => d.email)).toEqual([e.hard]);

    const bogus = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries?view=nonsense`, { headers: AUTH }),
    );
    expect(bogus.view).toBe("failures");
  });

  it("404s for an unknown send and requires auth", async () => {
    expect((await SELF.fetch(`${base}/sends/whatever/deliveries`)).status).toBe(401);
    expect((await SELF.fetch(`${base}/sends/nope/deliveries`, { headers: AUTH })).status).toBe(404);
  });
});
