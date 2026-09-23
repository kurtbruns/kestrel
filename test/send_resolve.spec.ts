/**
 * Operator adjudication of a wedged send (SPEC §12, issue #71).
 *
 * On a non-idempotent provider a mid-batch transport error leaves recipients
 * `dispatched` — genuinely ambiguous — and the loop refuses to blind-retry them
 * (I4), so the send can never clear its completion gate and stays `sending`
 * forever. These tests cover the manual resolution that unwedges it: a lone
 * `dispatched` row can be driven to completion via the action, "unsent" vs
 * "accepted" behave correctly, and an already-`accepted` recipient is never
 * touched (I4).
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { clearFakeOutbox, fakeOutbox } from "../src/providers/fake";
import { runSend } from "../src/send/loop";
import { resolveStuckSend } from "../src/send/resolve";
import { freeze } from "../src/send/schedule";

const config = () => getConfig(env);

// A non-idempotent provider (SES) — the only kind that can wedge a send. Mirrors
// the override in integration_delivery.spec.ts; no real network (fetch is mocked).
const sesEnv = () =>
  ({
    ...env,
    PROVIDER: "ses",
    AWS_ACCESS_KEY_ID: "AKIARESOLVETEST",
    AWS_SECRET_ACCESS_KEY: "resolve-secret-key",
  }) as unknown as AppEnv;

async function seedConfirmed(email: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES (?, ?, 'confirmed', ?, ?, ?, ?)",
  )
    .bind(`id-${email}`, email, `cfm-${email}`, `uns-${email}`, now, now)
    .run();
}

/** A send moved to `sending` (as the lease does) but with no deliveries yet. */
async function sendingSend(): Promise<sends.SendRow> {
  const { post } = await posts.createPost(
    env.DB,
    { subject: "Wedged", markdown: "# Hi\n\nbody" },
    "t",
  );
  const send = await freeze(env, config(), post, Date.now() - 1000);
  await env.DB.prepare("UPDATE sends SET status = 'sending', started_at = ? WHERE id = ?")
    .bind(Date.now(), send.id)
    .run();
  return send;
}

async function insertDelivery(
  sendId: string,
  email: string,
  status: string,
  providerId?: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO deliveries (id, send_id, email, status, provider_id, attempts, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
  )
    .bind(`d-${email}`, sendId, email, status, providerId ?? null, Date.now())
    .run();
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
  ]);
  clearFakeOutbox();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolve a wedged send", () => {
  it("drives a lone dispatched row to completion, marked unsent (assumed not sent)", async () => {
    const send = await sendingSend();
    await insertDelivery(send.id, "amb@example.com", "dispatched");

    const res = await resolveStuckSend(env, send.id, "unsent", "tester@example.com");

    expect(res.resolved).toBe(1);
    expect(res.completed).toBe(true);
    expect(res.send.status).toBe("sent");
    // The send finished and the post closed, exactly as a clean send would.
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect((await posts.getPost(env.DB, send.post_id))!.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toMatchObject({ unsent: 1 });
    // Nothing was mailed by the resolution itself.
    expect(fakeOutbox().length).toBe(0);
  });

  it("drives a lone dispatched row to completion, marked accepted (assumed sent)", async () => {
    const send = await sendingSend();
    await insertDelivery(send.id, "amb@example.com", "dispatched");

    const res = await resolveStuckSend(env, send.id, "accepted", "tester@example.com");

    expect(res.resolved).toBe(1);
    expect(res.completed).toBe(true);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toMatchObject({ accepted: 1 });
    expect(fakeOutbox().length).toBe(0);
  });

  it("never touches an already-accepted recipient when resolving the ambiguous one (I4)", async () => {
    const send = await sendingSend();
    await insertDelivery(send.id, "done@example.com", "accepted", "ses-msg-done");
    await insertDelivery(send.id, "amb@example.com", "dispatched");

    const res = await resolveStuckSend(env, send.id, "unsent", "tester@example.com");

    expect(res.resolved).toBe(1); // only the dispatched row
    expect(res.completed).toBe(true);
    // The accepted recipient is untouched — same status, same provider id, no re-mail.
    const rollup = await sends.deliveryRollup(env.DB, send.id);
    expect(rollup).toMatchObject({ accepted: 1, unsent: 1 });
    const done = await env.DB.prepare(
      "SELECT status, provider_id FROM deliveries WHERE email = 'done@example.com'",
    ).first<{ status: string; provider_id: string }>();
    expect(done).toMatchObject({ status: "accepted", provider_id: "ses-msg-done" });
    expect(fakeOutbox().length).toBe(0);
  });

  it("stamps an audit note on the resolved rows for later inspection", async () => {
    const send = await sendingSend();
    await insertDelivery(send.id, "amb@example.com", "dispatched");

    await resolveStuckSend(env, send.id, "unsent", "tester@example.com");

    const row = await env.DB.prepare(
      "SELECT error FROM deliveries WHERE email = 'amb@example.com'",
    ).first<{ error: string }>();
    expect(row?.error).toContain("operator adjudication");
    expect(row?.error).toContain("tester@example.com");
  });

  it("does not complete a send that still has pending rows, but resolves the ambiguous ones", async () => {
    const send = await sendingSend();
    await insertDelivery(send.id, "amb@example.com", "dispatched");
    await insertDelivery(send.id, "todo@example.com", "pending");

    const res = await resolveStuckSend(env, send.id, "unsent", "tester@example.com");

    expect(res.resolved).toBe(1);
    expect(res.completed).toBe(false);
    // Still sending — the sweep will deliver the pending recipient on the next tick.
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sending");
    expect(await sends.countDeliveries(env.DB, send.id, "dispatched")).toBe(0);
    expect(await sends.countDeliveries(env.DB, send.id, "pending")).toBe(1);
  });

  it("rejects resolving a send with no ambiguous deliveries", async () => {
    const send = await sendingSend();
    await insertDelivery(send.id, "ok@example.com", "accepted", "ses-msg-ok");

    await expect(resolveStuckSend(env, send.id, "unsent", "t")).rejects.toThrow(/no ambiguous/);
  });

  it("rejects resolving a send that is not sending", async () => {
    const { post } = await posts.createPost(env.DB, { subject: "S", markdown: "# H\n\nb" }, "t");
    const send = await freeze(env, config(), post, Date.now() + 3_600_000); // still scheduled

    await expect(resolveStuckSend(env, send.id, "unsent", "t")).rejects.toThrow(/only a send/);
  });

  it("rejects resolving a missing send", async () => {
    await expect(resolveStuckSend(env, "nope", "unsent", "t")).rejects.toThrow();
  });
});

describe("a real SES transport error wedges the send, and resolve unwedges it", () => {
  it("stays sending on a mid-batch transport error, then completes via resolve", async () => {
    await seedConfirmed("a@example.com");
    const { post } = await posts.createPost(env.DB, { subject: "S", markdown: "# H\n\nb" }, "t");
    const send = await freeze(env, config(), post, Date.now() - 1000);

    // The outbound SES POST throws (request left, no response) — the ambiguous case.
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await runSend(sesEnv(), send.id);
    spy.mockRestore();

    // Wedged: sending, one dispatched row, nothing pending, nothing mailed.
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sending");
    expect(await sends.countDeliveries(env.DB, send.id, "dispatched")).toBe(1);
    expect(await sends.countDeliveries(env.DB, send.id, "pending")).toBe(0);
    expect(await sends.countDeliveries(env.DB, send.id, "accepted")).toBe(0);

    // Resuming does NOT clear it — a non-idempotent provider is never auto-retried.
    await runSend(sesEnv(), send.id);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sending");
    expect(await sends.countDeliveries(env.DB, send.id, "dispatched")).toBe(1);

    // The operator adjudicates: assume it never left; the send completes.
    const res = await resolveStuckSend(sesEnv(), send.id, "unsent", "tester@example.com");
    expect(res.completed).toBe(true);
    expect((await sends.getSend(env.DB, send.id))!.status).toBe("sent");
    expect(await sends.deliveryRollup(env.DB, send.id)).toMatchObject({ unsent: 1 });
  });
});
