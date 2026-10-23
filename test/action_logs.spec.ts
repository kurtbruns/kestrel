import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { DEV_TOKEN_ID } from "../src/auth/dev_token";
import { accessDeployment } from "./support/access";
import { frozenSend, resetDatabase, seedConfirmed, wedgedSend } from "./support/fixtures";
import { adminAuth, base, readJson } from "./support/http";
import { type LoggedLine, logged } from "./support/log";
import { fetchWith } from "./support/worker_env";

// Who acted, on the lines that log an action (SPEC §12): the principal's kind and the client a
// person came through, so what automation changed is one filter on `principal` and what Claude
// changed one on `client`. Never the email or the token's Client ID, which the record keeps.

/** Who acts, as the request's credential and `Kestrel-Client` say, and what the line carries. */
interface Who {
  name: string;
  auth: { email?: string; client?: string };
  fields: { principal: "human" | "service"; client?: string };
}

const EMAIL = "you@example.com";
const EVERYONE: Who[] = [
  {
    name: "a person in the editor",
    auth: { email: EMAIL, client: "editor" },
    fields: { principal: "human", client: "editor" },
  },
  {
    name: "a person via Claude",
    auth: { email: EMAIL, client: "claude" },
    fields: { principal: "human", client: "claude" },
  },
  {
    name: "a person through a client that names nothing",
    auth: { email: EMAIL },
    fields: { principal: "human" },
  },
  {
    name: "a service token",
    // A service token's request naming a client changes nothing: the token names the program.
    auth: { client: "claude-code" },
    fields: { principal: "service" },
  },
];

let spies: MockInstance[] = [];
const lines = (event: string): LoggedLine[] => logged(...spies).filter((l) => l.event === event);

beforeEach(async () => {
  await resetDatabase();
  spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function call(who: Who, method: string, path: string, body?: unknown): Promise<Response> {
  const headers = await adminAuth(who.auth);
  return SELF.fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** The line names who acted by kind and client, with no field left for the other, and nothing
 *  in it names the person or the token. */
function expectWho(line: LoggedLine | undefined, who: Who): void {
  expect(line).toMatchObject(who.fields);
  if (!("client" in who.fields)) {
    expect(line).not.toHaveProperty("client");
  }
  const text = JSON.stringify(line);
  expect(text).not.toContain(EMAIL.split("@")[0]);
  expect(text).not.toContain(DEV_TOKEN_ID);
}

describe("an action's line says who took it (SPEC §12)", () => {
  for (const who of EVERYONE) {
    for (const [act, path, body] of [
      ["schedule", "schedule", { fire_at: new Date(Date.now() + 3_600_000).toISOString() }],
      ["send_now", "send", undefined],
    ] as const) {
      it(`a ${act} by ${who.name}`, async () => {
        const draft = await call(who, "POST", "/api/posts", { subject: "S", markdown: "# Hi" });
        const postId: string = (await readJson(draft)).post.id;
        const res = await call(who, "POST", `/api/posts/${postId}/${path}`, body);
        expect(res.status).toBe(201);
        const sent = (await readJson(res)).send;
        const [line] = lines("send.scheduled");
        expect(line).toMatchObject({
          level: "info",
          sendId: sent.id,
          postId,
          act,
          fireAt: new Date(sent.fire_at).toISOString(),
        });
        expectWho(line, who);
      });
    }

    it(`a Resolve by ${who.name}`, async () => {
      const id = await wedgedSend();
      const res = await call(who, "POST", `/api/sends/${id}/resolve`, { resolution: "unsent" });
      expect(res.status).toBe(200);
      const { resolved, completed } = await readJson(res);
      const [line] = lines("send.resolved");
      expect(line).toMatchObject({
        level: "warn",
        sendId: id,
        resolution: "unsent",
        resolved,
        completed,
      });
      expect(resolved).toBeGreaterThan(0);
      expectWho(line, who);
    });

    it(`a reschedule by ${who.name}`, async () => {
      const send = await frozenSend(Date.now() + 3_600_000);
      const fire_at = new Date(Date.now() + 7_200_000).toISOString();
      expect(
        (await call(who, "POST", `/api/sends/${send.id}/reschedule`, { fire_at })).status,
      ).toBe(200);
      const [line] = lines("send.rescheduled");
      expect(line).toMatchObject({ sendId: send.id, postId: send.post_id });
      expectWho(line, who);
    });

    it(`a cancel by ${who.name}`, async () => {
      const send = await frozenSend(Date.now() + 3_600_000);
      expect((await call(who, "POST", `/api/sends/${send.id}/cancel`)).status).toBe(200);
      const [line] = lines("send.canceled");
      expect(line).toMatchObject({ sendId: send.id, postId: send.post_id });
      expectWho(line, who);
    });

    it(`an erase by ${who.name}`, async () => {
      await seedConfirmed("ada@example.com");
      expect((await call(who, "POST", "/api/subscribers/id-ada@example.com/erase")).status).toBe(
        200,
      );
      const [line] = lines("subscriber.erased");
      expect(line).toMatchObject({ deliveries: 0 });
      expectWho(line, who);
    });

    it(`a block by ${who.name}`, async () => {
      const res = await call(who, "POST", "/api/suppressions", { email: "spam@example.net" });
      expect(res.status).toBe(201);
      const [line] = lines("suppression.added");
      expect(line).toMatchObject({ source: "manual", count: 1 });
      expectWho(line, who);
    });

    it(`an import by ${who.name}`, async () => {
      const header =
        "email,status,opt_in,origin,suppression,subscribed_at,confirmed_at,unsubscribed_at,suppressed_at,evidence";
      const file = {
        name: "list.csv",
        text: `${header}\r\nleft@x.io,unsubscribed,unknown,sendy,,,,,,\r\n`,
      };
      const plan = await readJson(await call(who, "POST", "/api/imports/plan", { file }));
      const res = await call(who, "POST", "/api/imports", { file, plan_hash: plan.plan_hash });
      expect(res.status).toBe(201);
      const [line] = lines("import.committed");
      expect(line).toMatchObject({ rows: 1, unsubscribed: 1 });
      expectWho(line, who);
    });
  }

  it("a request that changes nothing logs no action", async () => {
    const who = EVERYONE[0]!;
    const send = await frozenSend(Date.now() + 3_600_000);
    await call(who, "POST", `/api/sends/${send.id}/cancel`);
    await call(who, "POST", `/api/sends/${send.id}/cancel`);
    await call(who, "POST", "/api/suppressions", { email: "spam@example.net" });
    await call(who, "POST", "/api/suppressions", { email: "spam@example.net" });
    await seedConfirmed("ada@example.com");
    expect((await call(who, "POST", "/api/subscribers/id-ada@example.com/erase")).status).toBe(200);
    expect((await call(who, "POST", "/api/subscribers/id-ada@example.com/erase")).status).toBe(200);
    expect(lines("send.canceled")).toHaveLength(1);
    expect(lines("suppression.added")).toHaveLength(1);
    expect(lines("subscriber.erased")).toHaveLength(1);
  });

  it("a service token's reads through Access log nothing about who called (SPEC §12)", async () => {
    const { vars, assertion } = await accessDeployment();
    const headers = await assertion({ common_name: "e367c0ffee5eb4.access" });
    expect((await fetchWith(vars, "/api/whoami", { headers })).status).toBe(200);
    expect((await fetchWith(vars, "/api/posts", { headers })).status).toBe(200);
    expect(logged(...spies)).toEqual([]);
  });
});
