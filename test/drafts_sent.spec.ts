import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recomputeSendCounters } from "../src/db/sends";
import { adminAuth } from "./support/auth";

// PR1 (#147/#148): the Drafts view scopes /posts to draft+scheduled via a comma status
// list, and a sent issue opens the read-only record view backed by GET /sends/:id
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
  await env.DB.prepare(
    "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, recipient_count, scheduled_at, started_at, completed_at) VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      sendId,
      postId,
      now - 1000,
      "<p>frozen</p>",
      "frozen",
      subject,
      deliveries.length,
      now - 2000,
      now - 1500,
      now - 1000,
    )
    .run();
  let i = 0;
  for (const d of deliveries) {
    await env.DB.prepare(
      "INSERT INTO deliveries (id, send_id, email, status, provider_id, error, attempts, updated_at, event, event_detail, event_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        `d-${sendId}-${i++}`,
        sendId,
        d.email,
        d.status,
        d.status === "accepted" ? `pid-${i}` : null,
        d.status === "failed" ? "550 mailbox unavailable" : null,
        1,
        now,
        d.event ?? null,
        null,
        d.event ? now : null,
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
    const postId = await createDraft(`${marker} issue`);
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
      { email: "fail@example.com", status: "failed" },
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
      failed: 1,
      skipped: 1,
      accepted: 1,
      in_flight: 0,
    });
    // Every recipient lands in exactly one bucket — the buckets sum to the audience.
    const sum =
      o.delivered + o.bounced + o.complained + o.failed + o.skipped + o.accepted + o.in_flight;
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
      failed: o.failed,
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
      { email: "c@example.com", status: "failed" },
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
    expect(text).toContain("c@example.com,failed,,");
  });

  it("requires auth", async () => {
    expect((await SELF.fetch(`${base}/sends/whatever/deliveries.csv`)).status).toBe(401);
  });
});

// #164: the record view shows the per-recipient rows in-app, not just as the CSV — a
// paginated, filterable JSON endpoint read DIRECTLY off `deliveries` (the source of
// truth), not the `c_*` counters. The default view is "issues" (bounced/complained/
// failed), and a bounce splits soft vs hard by whether the address is now suppressed.
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
    const { sendId } = await seedSentSend("Rows Test", `rows-${tag}`, [
      { email: e.d1, status: "accepted", event: "delivered" },
      { email: e.d2, status: "accepted", event: "delivered" },
      { email: e.hard, status: "accepted", event: "bounced" },
      { email: e.soft, status: "accepted", event: "bounced" },
      { email: e.spam, status: "accepted", event: "complained" },
      { email: e.fail, status: "failed" },
      { email: e.skip, status: "skipped" },
      { email: e.wait, status: "accepted" }, // accepted, no event yet
    ]);
    // A hard bounce suppresses the address (I1); the soft one does not — so the join is
    // what lets the record label the two apart, since the row itself stores no such flag.
    await env.DB.prepare(
      "INSERT INTO suppressions (email, reason, detail, created_at) VALUES (?, 'bounce', 'hard bounce', ?)",
    )
      .bind(e.hard, Date.now())
      .run();
    return { sendId, e };
  }

  it("defaults to the issues view (bounced/complained/failed), email-sorted", async () => {
    const { sendId, e } = await seedRecord();
    const body = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries`, { headers: AUTH }),
    );
    expect(body.view).toBe("issues");
    // Only the rows that went wrong, and in the default email-asc order (matches the CSV).
    expect(body.deliveries.map((d: any) => d.email)).toEqual([e.fail, e.hard, e.soft, e.spam]);
    expect(body.page).toMatchObject({ total: 4, sort: "email", dir: "asc" });
  });

  it("splits soft vs hard bounce by suppression", async () => {
    const { sendId, e } = await seedRecord();
    const body = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries`, { headers: AUTH }),
    );
    const byEmail = Object.fromEntries(body.deliveries.map((d: any) => [d.email, d]));
    expect(byEmail[e.hard]).toMatchObject({
      event: "bounced",
      suppressed: 1,
      suppressed_reason: "bounce",
    });
    expect(byEmail[e.soft]).toMatchObject({
      event: "bounced",
      suppressed: 0,
      suppressed_reason: null,
    });
  });

  it("filters to delivered, and to a single bucket", async () => {
    const { sendId, e } = await seedRecord();
    const del = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries?view=delivered`, { headers: AUTH }),
    );
    expect(del.deliveries.map((d: any) => d.email)).toEqual([e.d1, e.d2]);
    expect(del.deliveries.every((d: any) => d.event === "delivered")).toBe(true);

    const failed = await readJson(
      await SELF.fetch(`${base}/sends/${sendId}/deliveries?view=failed`, { headers: AUTH }),
    );
    expect(failed.deliveries.map((d: any) => d.email)).toEqual([e.fail]);
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

  it("searches by address and falls back to issues on an unknown view", async () => {
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
    expect(bogus.view).toBe("issues");
  });

  it("404s for an unknown send and requires auth", async () => {
    expect((await SELF.fetch(`${base}/sends/whatever/deliveries`)).status).toBe(401);
    expect((await SELF.fetch(`${base}/sends/nope/deliveries`, { headers: AUTH })).status).toBe(404);
  });
});
