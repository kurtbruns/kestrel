import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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
  return { postId, sendId };
}

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
