// One subscriber's sends (SPEC §8): every send their address was in, read from the records a
// page at a time, and the import record a subscriber's `import_id` names.

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImportRecordResponse } from "../shared/imports";
import type { SubscriberDeliveriesResponse, SubscriberResponse } from "../shared/subscribers";
import { SUBSCRIBER_DELIVERIES_PAGE } from "../src/routes/subscribers";
import { resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";

const READER = "reader@example.com";

/** Sends of one post, each firing at its own time, `ago` milliseconds before now. */
async function sendsAt(agos: readonly number[]): Promise<string[]> {
  const now = Date.now();
  const ids = agos.map((_, i) => `s-${String(i).padStart(3, "0")}`);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO posts (id, slug, status, created_at, updated_at) VALUES ('p-1', 'p-1', 'sent', ?, ?)",
    ).bind(now, now),
    ...agos.map((ago, i) =>
      env.DB.prepare(
        "INSERT INTO sends (id, post_id, status, fire_at, rendered_html, rendered_text, subject, scheduled_at) VALUES (?, 'p-1', 'sent', ?, '', '', ?, ?)",
      ).bind(ids[i], now - ago, `Post ${i}`, now - ago),
    ),
  ]);
  return ids;
}

async function delivery(
  sendId: string,
  email: string,
  fields: { status?: string; event?: string; event_detail?: string; error?: string } = {},
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO deliveries (send_id, email, status, event, event_detail, event_at, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      sendId,
      email,
      fields.status ?? "accepted",
      fields.event ?? null,
      fields.event_detail ?? null,
      fields.event ? Date.now() : null,
      fields.error ?? null,
      Date.now(),
    )
    .run();
}

function deliveriesOf(id: string, after?: string): Promise<Response> {
  const q = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  return SELF.fetch(`${base}/api/subscribers/${id}/deliveries${q}`, { headers: AUTH });
}

beforeEach(resetDatabase);

describe("a subscriber's deliveries (SPEC §8)", () => {
  it("lists every send the address was in, newest first, each send's view beside the address's row", async () => {
    await seedConfirmed([READER, "other@example.com"]);
    const [older, newer, notTheirs] = await sendsAt([3_600_000, 60_000, 30_000]);
    await delivery(older!, READER, { event: "delivered" });
    await delivery(newer!, READER, { event: "bounced", event_detail: "550 no such user" });
    await delivery(notTheirs!, "other@example.com");

    const res = await deliveriesOf(`id-${READER}`);
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as SubscriberDeliveriesResponse;
    expect(body.next).toBe(null);
    expect(body.deliveries.map((d) => [d.send.id, d.send.subject])).toEqual([
      [newer, "Post 1"],
      [older, "Post 0"],
    ]);
    expect(body.deliveries[0]!.delivery).toMatchObject({
      email: READER,
      status: "accepted",
      event: "bounced",
      event_detail: "550 no such user",
    });
    expect(body.deliveries[1]!.delivery.event).toBe("delivered");
  });

  it("an unsent or skipped row says so, with the provider's words for an unsent one (SPEC §8)", async () => {
    await seedConfirmed(READER);
    const [a, b] = await sendsAt([120_000, 60_000]);
    await delivery(a!, READER, { status: "unsent", error: "Address rejected" });
    await delivery(b!, READER, { status: "skipped" });

    const body = (await readJson(
      await deliveriesOf(`id-${READER}`),
    )) as SubscriberDeliveriesResponse;
    expect(body.deliveries.map((d) => [d.delivery.status, d.delivery.error])).toEqual([
      ["skipped", null],
      ["unsent", "Address rejected"],
    ]);
  });

  it("pages with the server's page size: following next reads each send once, in order", async () => {
    await seedConfirmed(READER);
    const count = SUBSCRIBER_DELIVERIES_PAGE + 3;
    // Two sends share each fire time, so the send's id has to break the tie.
    const ids = await sendsAt(Array.from({ length: count }, (_, i) => 60_000 * Math.floor(i / 2)));
    for (const id of ids) {
      await delivery(id, READER);
    }

    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const body = (await readJson(
        await deliveriesOf(`id-${READER}`, after),
      )) as SubscriberDeliveriesResponse;
      seen.push(...body.deliveries.map((d) => d.send.id));
      after = body.next ?? undefined;
      pages++;
    } while (after !== undefined);

    expect(pages).toBe(2);
    expect(seen).toHaveLength(count);
    expect(new Set(seen).size).toBe(count);
    const fireAt = new Map(ids.map((id, i) => [id, -60_000 * Math.floor(i / 2)]));
    const order = [...ids].sort((x, y) => fireAt.get(y)! - fireAt.get(x)! || (x < y ? 1 : -1));
    expect(seen).toEqual(order);
  });

  it("refuses an after this server didn't issue, naming the field (API principle 7)", async () => {
    await seedConfirmed(READER);
    const res = await deliveriesOf(`id-${READER}`, "not-a-cursor");
    expect(res.status).toBe(400);
    expect((await readJson(res)) as { error: string; field: string }).toMatchObject({
      error: "bad_request",
      field: "after",
    });
  });

  it("an erased subscriber's past rows show a placeholder, so their sends list none (SPEC §7)", async () => {
    await seedConfirmed(READER);
    const [sendId] = await sendsAt([60_000]);
    await delivery(sendId!, READER, { event: "delivered" });
    const id = `id-${READER}`;
    expect(
      ((await readJson(await deliveriesOf(id))) as SubscriberDeliveriesResponse).deliveries,
    ).toHaveLength(1);

    const erased = await SELF.fetch(`${base}/api/subscribers/${id}/erase`, {
      method: "POST",
      headers: AUTH,
    });
    expect(erased.status).toBe(200);
    const body = (await readJson(await deliveriesOf(id))) as SubscriberDeliveriesResponse;
    expect(body).toEqual({ deliveries: [], next: null });
  });

  it("is 404 for an unknown subscriber, and needs auth", async () => {
    expect((await deliveriesOf("nobody")).status).toBe(404);
    const anon = await SELF.fetch(`${base}/api/subscribers/nobody/deliveries`);
    expect(anon.status).toBe(401);
  });
});

describe("a subscriber's suppression says since when (SPEC §7)", () => {
  it("carries the suppression's time beside its reason and detail", async () => {
    await seedConfirmed(READER);
    await SELF.fetch(`${base}/api/suppressions`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ email: READER, detail: "Asked by hand" }),
    });
    const stored = await env.DB.prepare("SELECT created_at FROM suppressions WHERE email = ?")
      .bind(READER)
      .first<{ created_at: number }>();
    const res = await SELF.fetch(`${base}/api/subscribers/id-${READER}`, { headers: AUTH });
    const { subscriber } = (await readJson(res)) as SubscriberResponse;
    expect(subscriber.suppression).toEqual({
      reason: "manual",
      detail: "Asked by hand",
      created_at: stored!.created_at,
    });
  });
});

describe("a subscriber says whether they receive posts (SPEC §7)", () => {
  it("is true only for a confirmed address with no suppression, the audience a send takes", async () => {
    await seedConfirmed([READER, "blocked@example.com"]);
    await SELF.fetch(`${base}/api/suppressions`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ email: "blocked@example.com" }),
    });
    for (const email of ["pending@example.com", "pending-blocked@example.com"]) {
      await SELF.fetch(`${base}/api/subscribers`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ email }),
      });
    }
    await SELF.fetch(`${base}/api/suppressions`, {
      method: "POST",
      headers: JSON_AUTH,
      body: JSON.stringify({ email: "pending-blocked@example.com" }),
    });
    // Someone who left is sent nothing, suppressed or not.
    await seedConfirmed("left@example.com");
    await SELF.fetch(`${base}/api/subscribers/id-left@example.com/unsubscribe`, {
      method: "POST",
      headers: AUTH,
    });
    const { subscribers } = await readJson(
      await SELF.fetch(`${base}/api/subscribers?sort=email&dir=asc`, { headers: AUTH }),
    );
    expect(
      subscribers.map((s: { email: string; receives_posts: boolean }) => [
        s.email,
        s.receives_posts,
      ]),
    ).toEqual([
      ["blocked@example.com", false],
      ["left@example.com", false],
      ["pending-blocked@example.com", false],
      ["pending@example.com", false],
      [READER, true],
    ]);
  });
});

describe("an import's record (SPEC §8)", () => {
  it("answers the record a subscriber's import_id names, and 404 for one that names none", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO imports (id, created_at, principal_kind, principal_email, attestation_version, file_name, file_sha256, plan_hash, counts, suppressions_added) VALUES ('imp-1', ?, 'human', 'you@example.com', 1, 'list.csv', 'abc', 'hash-1', '{}', 2)",
    )
      .bind(now)
      .run();

    const res = await SELF.fetch(`${base}/api/imports/imp-1`, { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as ImportRecordResponse;
    expect(body.import).toMatchObject({
      id: "imp-1",
      created_at: now,
      principal: { kind: "human", email: "you@example.com" },
      attestation_version: 1,
      file_name: "list.csv",
      suppressions_added: 2,
    });
    expect((await SELF.fetch(`${base}/api/imports/imp-2`, { headers: AUTH })).status).toBe(404);
  });

  it("still serves the import format at its own path", async () => {
    const res = await SELF.fetch(`${base}/api/imports/format`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(((await readJson(res)) as { format: string }).format).toBe("kestrel-subscribers/2");
  });
});
