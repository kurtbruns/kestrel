/**
 * The setup phases, one row of what anyone can do per action (SPEC §7, §9): not connected,
 * not proven yet, refusing, working in the SES sandbox, and working with production access.
 * Each phase is reached by its own path, through local development's simulated SES and the
 * real adapter's reading of its answers (SPEC §10), never by writing the state: refusing is a
 * test SES refused, working a test SES took.
 */

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderStatusView, SignupsState } from "../shared/provider";
import { refusalAdvice, SANDBOX_SEND_WARNING } from "../shared/sends";
import * as subscribers from "../src/db/subscribers";
import { clearFakeNotifications } from "../src/notify/fake";
import { resetSimulation } from "../src/providers/simulate";
import { resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, JSON_AUTH, readJson } from "./support/http";
import { fetchWith } from "./support/worker_env";

type Phase = "not_connected" | "unproven" | "refusing" | "sandbox" | "production";

/** An address the simulated sandbox mails: one at the sending domain, as a verified domain covers. */
const VERIFIED = "me@send.example.com";
/** An address it doesn't. */
const READER = "reader@example.org";

const VARS: Record<Phase, Record<string, string>> = {
  not_connected: { SIMULATE_SENDS: "not-connected" },
  unproven: { SIMULATE_SENDS: "ses:none", SIMULATE_ACCOUNT: "production" },
  refusing: { SIMULATE_SENDS: "ses:none:refuse=configuration", SIMULATE_ACCOUNT: "production" },
  sandbox: { SIMULATE_SENDS: "ses:none", SIMULATE_ACCOUNT: "sandbox" },
  production: { SIMULATE_SENDS: "ses:none", SIMULATE_ACCOUNT: "production" },
};

const PHASES = Object.keys(VARS) as Phase[];

/** A request to the instance in `phase`, as the editor or Claude makes it. */
function admin(phase: Phase, method: string, path: string, body?: unknown): Promise<Response> {
  return fetchWith(VARS[phase], path, {
    method,
    headers: body === undefined ? AUTH : JSON_AUTH,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const templateTest = (phase: Phase, to: string) =>
  admin(phase, "POST", "/api/settings/template/test", { to });

/** A reader's request to the public form, as JSON. */
const signUp = (phase: Phase, email: string) =>
  fetchWith(VARS[phase], "/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });

async function provider(phase: Phase): Promise<ProviderStatusView> {
  return readJson(await admin(phase, "GET", "/api/provider"));
}

/** Reach `phase` by its own path: a test SES takes, or one it refuses. */
async function reach(phase: Phase): Promise<void> {
  if (phase === "refusing" || phase === "sandbox" || phase === "production") {
    await templateTest(phase, VERIFIED);
  }
  // Where the publisher is told, for the notifications row.
  await notifyTo(VERIFIED);
}

/** Set where notifications go. */
async function notifyTo(address: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO settings (id, data, updated_at) VALUES (1, json_object('notifications', json_object('to', json_array(?))), 1)
     ON CONFLICT (id) DO UPDATE SET data = json_set(data, '$.notifications', json_object('to', json_array(?)))`,
  )
    .bind(address, address)
    .run();
}

beforeEach(async () => {
  await resetDatabase();
  resetSimulation();
  clearFakeNotifications();
});

afterEach(() => {
  clearFakeNotifications();
});

describe("what the API says in each phase (SPEC §9)", () => {
  const expected: Record<Phase, { state: string | null; signups: SignupsState }> = {
    not_connected: { state: null, signups: "not_open" },
    unproven: { state: "unproven", signups: "not_open" },
    refusing: { state: "refusing", signups: "paused" },
    sandbox: { state: "working", signups: "open" },
    production: { state: "working", signups: "open" },
  };
  it.each(PHASES)("%s", async (phase) => {
    await reach(phase);
    const p = await provider(phase);
    expect({ state: p.sending?.state ?? null, signups: p.signups }).toEqual(expected[phase]);
    if (phase === "refusing") {
      expect(p.sending?.refusal).toMatchObject({
        cause: "configuration",
        found_by: "test",
        advice: refusalAdvice("configuration"),
      });
    }
  });
});

describe("what anyone can do, by phase (SPEC §6, §7, §9)", () => {
  /** Each action's answer in each phase, as the target's grid says it. */
  const GRID: Record<string, Record<Phase, (phase: Phase) => Promise<void>>> = {
    "send a test email": {
      not_connected: async (p) => {
        const r = await templateTest(p, VERIFIED);
        expect(r.status).toBe(503);
        expect((await readJson(r)).error).toBe("provider_not_connected");
      },
      // It goes, and proves email works.
      unproven: async (p) => {
        expect((await readJson(await templateTest(p, VERIFIED))).sent).toBe(1);
        expect((await provider(p)).signups).toBe("open");
      },
      // Refused, with SES's words and the fix; still refusing.
      refusing: async (p) => {
        const r = await readJson(await templateTest(p, VERIFIED));
        expect(r.sent).toBe(0);
        expect(r.not_sent[0].message).toContain(refusalAdvice("configuration"));
        expect((await provider(p)).signups).toBe("paused");
      },
      // To verified addresses; another is refused for the sandbox, which refuses nothing else.
      sandbox: async (p) => {
        expect((await readJson(await templateTest(p, VERIFIED))).sent).toBe(1);
        const r = await readJson(await templateTest(p, READER));
        expect(r.sent).toBe(0);
        expect(r.not_sent[0].message).toContain(refusalAdvice("sandbox"));
        expect((await provider(p)).sending?.state).toBe("working");
      },
      production: async (p) => {
        expect((await readJson(await templateTest(p, READER))).sent).toBe(1);
      },
    },
    "schedule a post": {
      not_connected: async (p) => {
        const r = await schedule(p);
        expect(r.status).toBe(503);
      },
      unproven: async (p) => expect(await kinds(p)).toEqual(["untested"]),
      refusing: async (p) => expect(await kinds(p)).toEqual(["untested"]),
      sandbox: async (p) => {
        const r = await readJson(await schedule(p));
        expect(r.send.conditions.map((c: { kind: string }) => c.kind)).toEqual([
          "sandbox",
          "untested",
        ]);
        expect(r.send.conditions[0].message).toBe(SANDBOX_SEND_WARNING);
      },
      production: async (p) => expect(await kinds(p)).toEqual(["untested"]),
    },
    "add a subscriber": {
      not_connected: async (p) => {
        const r = await admin(p, "POST", "/api/subscribers", { email: READER });
        expect(r.status).toBe(503);
        expect((await readJson(r)).error).toBe("provider_not_connected");
      },
      // Its confirmation proves email works.
      unproven: async (p) => {
        expect((await admin(p, "POST", "/api/subscribers", { email: READER })).status).toBe(201);
        expect((await provider(p)).signups).toBe("open");
      },
      refusing: async (p) => {
        const r = await admin(p, "POST", "/api/subscribers", { email: READER });
        expect(r.status).toBe(502);
        const body = await readJson(r);
        expect(body.error).toBe("confirmation_not_sent");
        expect(body.message).toContain(refusalAdvice("configuration"));
      },
      sandbox: async (p) => {
        expect((await admin(p, "POST", "/api/subscribers", { email: VERIFIED })).status).toBe(201);
        const r = await admin(p, "POST", "/api/subscribers", { email: READER });
        expect(r.status).toBe(502);
        expect((await readJson(r)).message).toContain(refusalAdvice("sandbox"));
      },
      production: async (p) => {
        expect((await admin(p, "POST", "/api/subscribers", { email: READER })).status).toBe(201);
      },
    },
    "sign up through the public form": {
      not_connected: async (p) =>
        expect(await signupAnswer(p)).toEqual([503, "provider_not_connected"]),
      unproven: async (p) => expect(await signupAnswer(p)).toEqual([503, "signups_closed"]),
      refusing: async (p) => expect(await signupAnswer(p)).toEqual([503, "signups_closed"]),
      sandbox: async (p) => expect(await signupAnswer(p)).toEqual([200, "check_inbox"]),
      production: async (p) => expect(await signupAnswer(p)).toEqual([200, "check_inbox"]),
    },
    // Through the simulated SES, as on an instance without Cloudflare's email.
    "send a test notification": {
      not_connected: async (p) => {
        const r = await admin(p, "POST", "/api/settings/notifications/test");
        expect(r.status).toBe(503);
      },
      // It goes, and SES taking it proves email works.
      unproven: async (p) => {
        expect((await admin(p, "POST", "/api/settings/notifications/test")).status).toBe(200);
        expect((await provider(p)).signups).toBe("open");
      },
      // Refused, like every email: Cloudflare's email would still arrive.
      refusing: async (p) => {
        const r = await admin(p, "POST", "/api/settings/notifications/test");
        expect(r.status).toBe(502);
        expect((await readJson(r)).error).toBe("notify_failed");
      },
      // To a verified address; another is refused for the sandbox.
      sandbox: async (p) => {
        expect((await admin(p, "POST", "/api/settings/notifications/test")).status).toBe(200);
        await notifyTo(READER);
        const r = await admin(p, "POST", "/api/settings/notifications/test");
        expect(r.status).toBe(502);
        expect((await readJson(r)).message).toContain("not verified");
        expect((await provider(p)).sending?.state).toBe("working");
      },
      production: async (p) => {
        await notifyTo(READER);
        expect((await admin(p, "POST", "/api/settings/notifications/test")).status).toBe(200);
      },
    },
  };

  async function schedule(phase: Phase): Promise<Response> {
    const created = await readJson(
      await admin(phase, "POST", "/api/posts", { subject: "Owls", markdown: "# Owls" }),
    );
    return admin(phase, "POST", `/api/posts/${created.post.id}/schedule`, {
      fire_at: Date.now() + 86_400_000,
    });
  }

  async function kinds(phase: Phase): Promise<string[]> {
    const r = await schedule(phase);
    expect(r.status).toBe(201);
    return (await readJson(r)).send.conditions.map((c: { kind: string }) => c.kind);
  }

  async function signupAnswer(phase: Phase): Promise<[number, string]> {
    const r = await signUp(phase, READER);
    const body = await readJson(r);
    return [r.status, body.error ?? body.status];
  }

  for (const [action, row] of Object.entries(GRID)) {
    describe(action, () => {
      it.each(PHASES)("%s", async (phase) => {
        await reach(phase);
        await row[phase](phase);
      });
    });
  }
});

describe("the subscribe page answers every address alike (SPEC §7)", () => {
  const NEW = "new@example.org";
  const PENDING = "pending@example.org";
  const CONFIRMED = "confirmed@example.org";
  const SUPPRESSED = "suppressed@example.org";

  async function seedList(): Promise<void> {
    await seedConfirmed(CONFIRMED);
    await subscribers.ensureSubscriber(env.DB, PENDING);
    await env.DB.prepare(
      "INSERT INTO suppressions (email, reason, created_at) VALUES (?, 'bounce', ?)",
    )
      .bind(SUPPRESSED, Date.now())
      .run();
  }

  /** The page's answer, as JSON and as a page, with the publication's own words only. */
  async function answers(phase: Phase, email: string): Promise<string[]> {
    const json = await signUp(phase, email);
    const page = await fetchWith(VARS[phase], "/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: new URLSearchParams({ email }),
    });
    return [`${json.status} ${await json.text()}`, `${page.status} ${await page.text()}`];
  }

  it.each(PHASES)("%s", async (phase) => {
    await reach(phase);
    await seedList();
    const listed = [NEW, PENDING, CONFIRMED, SUPPRESSED];
    const first = await answers(phase, NEW);
    for (const email of listed) {
      expect(await answers(phase, email), email).toEqual(first);
    }
    const malformed = await answers(phase, "not an address");
    const open = phase === "sandbox" || phase === "production";
    if (open) {
      // A malformed address is refused for its form, which says nothing about the list.
      expect(malformed[0]).toMatch(/^400 /);
    } else {
      // Closed, the answer comes before the address is read, so even that is alike.
      expect(malformed).toEqual(first);
      expect(first[1]).toContain(
        phase === "refusing" ? "Signups are paused" : "Signups aren’t open yet",
      );
      expect(first[1]).not.toContain("<form");
    }
  });
});
