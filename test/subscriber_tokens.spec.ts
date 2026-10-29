import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import * as sends from "../src/db/sends";
import { frozenSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { adminAuth, base, JSON_AUTH } from "./support/http";

// A subscriber's confirm and unsubscribe tokens are how the app proves the reader acted
// (SPEC I1, I2): whoever holds one can confirm or unsubscribe as that reader. So they stay on
// the server, and no answer the API gives, to the editor or to Claude, carries either.

beforeEach(resetDatabase);

const PENDING = "pending@example.com";
const CONFIRMED = "confirmed@example.com";
const COMPLAINED = "complained@example.com";
const HELD = "held@example.com";

/** Every token the database holds now, so a check covers each one a route might pass on. */
async function storedTokens(): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT confirm_token AS t FROM subscribers WHERE confirm_token IS NOT NULL UNION SELECT unsub_token FROM subscribers WHERE unsub_token IS NOT NULL",
  ).all<{ t: string }>();
  return results.map((r) => r.t);
}

/** A raw answer's text, held to carrying neither token's key nor any token's value: those
 *  stored before the calls, since an erasure wipes both, and those stored now. */
async function expectNoTokens(what: string, text: string, before: string[]): Promise<void> {
  expect(text, what).not.toMatch(/confirm_token|unsub_token/);
  for (const token of [...before, ...(await storedTokens())]) {
    expect(text.includes(token), `${what} carries a token`).toBe(false);
  }
}

/** A pending reader with a live confirmation, someone who reported spam, and confirmed
 *  readers a send run holds right now, each with known tokens. */
async function seedList(): Promise<void> {
  const now = Date.now();
  await seedConfirmed([CONFIRMED, COMPLAINED]);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO subscribers (id, email, status, confirm_token, confirm_sent_at, confirm_attempt_at, unsub_token, created_at) VALUES ('id-p', ?, 'pending', 'cfm-pending-secret', ?, ?, 'uns-pending-secret', ?)",
    ).bind(PENDING, now, now, now),
    env.DB.prepare(
      "UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ?, unsubscribe_cause = 'complaint' WHERE email = ?",
    ).bind(now, COMPLAINED),
  ]);
  await seedConfirmed(HELD);
  const send = await frozenSend(Date.now() - 1000);
  await sends.resolveAudience(env.DB, send.id, Date.now());
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE sends SET status = 'sending', locked_until = ?, lease_token = 'run' WHERE id = ?",
    ).bind(Date.now() + 60_000, send.id),
    env.DB.prepare(
      "UPDATE deliveries SET status = 'dispatched', dispatch_key = 'k' WHERE send_id = ?",
    ).bind(send.id),
  ]);
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${base}${path}`, {
    method,
    headers: JSON_AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A connector tool call's text, as Claude receives it. */
async function tool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await SELF.fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: {
      ...(await adminAuth({ email: "you@example.com", client: "editor" })),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

describe("a subscriber's tokens never leave the server (SPEC I1)", () => {
  it("leaves both tokens off every API answer that carries a subscriber", async () => {
    await seedList();
    const before = await storedTokens();
    expect(before).toContain("cfm-pending-secret");
    const answers: [string, Response, number][] = [
      ["list", await call("GET", "/api/subscribers"), 200],
      ["by email", await call("GET", `/api/subscribers?email=${PENDING}`), 200],
      ["by id", await call("GET", "/api/subscribers/id-p"), 200],
      ["export", await call("GET", "/api/subscribers/export"), 200],
      ["add, inside the cooldown", await call("POST", "/api/subscribers", { email: PENDING }), 200],
      ["add, created", await call("POST", "/api/subscribers", { email: "new@example.com" }), 201],
      ["add, signup_required", await call("POST", "/api/subscribers", { email: COMPLAINED }), 409],
      ["erase, run_in_progress", await call("POST", `/api/subscribers/id-${HELD}/erase`), 409],
      ["unsubscribe", await call("POST", "/api/subscribers/id-p/unsubscribe"), 200],
      ["erase", await call("POST", "/api/subscribers/id-p/erase"), 200],
    ];
    for (const [what, res, status] of answers) {
      const text = await res.text();
      expect(res.status, `${what}: ${text}`).toBe(status);
      await expectNoTokens(what, text, before);
    }
  });

  it("leaves both tokens off what the connector's tools hand Claude", async () => {
    await seedList();
    const before = await storedTokens();
    const answers: [string, string][] = [
      ["read the list", await tool("kestrel_api_read", { path: "/api/subscribers" })],
      ["read one", await tool("kestrel_api_read", { path: "/api/subscribers/id-p" })],
      [
        "read by email",
        await tool("kestrel_api_read", { path: `/api/subscribers?email=${PENDING}` }),
      ],
      ["search", await tool("search_subscribers", {})],
      ["get", await tool("get_subscriber", { email: PENDING })],
    ];
    for (const [what, text] of answers) {
      expect(text, what).toContain(PENDING);
      await expectNoTokens(what, text, before);
    }
  });
});
