/**
 * The publisher's End of a held or wedged send (SPEC §12): everyone not yet handed off is
 * recorded unsent by the publisher's decision, anyone in flight is settled as Resolve would,
 * and the send and its post finish. It only narrows the audience (I1), mails no one (I4), and
 * is offered only on a send that carries a halt or is wedged.
 */
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EndResponse, SendResponse } from "../shared/sends";
import {
  type DueNotification,
  dueNotifications,
  recordNotifications,
} from "../src/db/notifications";
import * as posts from "../src/db/posts";
import * as sends from "../src/db/sends";
import { getConfig } from "../src/env";
import { LEASE_TTL_MS } from "../src/lib/time";
import { composeNotification } from "../src/notify/compose";
import * as providers from "../src/providers";
import type {
  Recipient,
  RenderedEmail,
  SendBatchOptions,
  SendBatchResult,
} from "../src/providers/types";
import { sweep } from "../src/send/sweep";
import { BatchProvider } from "./support/batching";
import { addresses, dueSend, resetDatabase, seedConfirmed, wedgedSend } from "./support/fixtures";
import { AUTH, base, JSON_AUTH, readJson } from "./support/http";
import { allowErrorLogs } from "./support/log";

const MIN = 60_000;
const REFUSAL =
  "ses 403 UnrecognizedClientException: The security token included in the request is invalid";

/** Two recipients a request, refusing the account from its second request on: a send that
 *  reached some readers before the provider started refusing. */
class RefusesAfterFirst extends BatchProvider {
  override readonly maxBatch: number = 2;
  override async sendBatch(
    rendered: RenderedEmail,
    recipients: Recipient[],
    opts: SendBatchOptions,
  ): Promise<SendBatchResult> {
    const answer = await super.sendBatch(rendered, recipients, opts);
    this.refuse = REFUSAL;
    return answer;
  }
}

let transport: BatchProvider;

beforeEach(async () => {
  await resetDatabase();
  vi.useFakeTimers({ toFake: ["Date"] });
  transport = new BatchProvider();
  vi.spyOn(providers, "getProvider").mockImplementation(() => transport);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const row = async (id: string) => (await sends.getSend(env.DB, id))!;

function end(id: string, body?: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${base}/api/sends/${id}/end`, {
    method: "POST",
    headers: body ? JSON_AUTH : AUTH,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function read(id: string): Promise<SendResponse> {
  return readJson(await SELF.fetch(`${base}/api/sends/${id}`, { headers: AUTH }));
}

const actionNames = async (id: string) => (await read(id)).send.actions.map((a) => a.name);

async function deliveries(id: string) {
  const { results } = await env.DB.prepare(
    "SELECT email, status, error, provider_id FROM deliveries WHERE send_id = ? ORDER BY email",
  )
    .bind(id)
    .all<{ email: string; status: string; error: string | null; provider_id: string | null }>();
  return results;
}

/** A send the provider refuses after taking its first two recipients, of five. */
async function refusedPartway(): Promise<string> {
  transport = new RefusesAfterFirst();
  await seedConfirmed(addresses(5));
  const send = await dueSend({ subject: "Owls" });
  await sweep(env);
  expect(await row(send.id)).toMatchObject({
    status: "sending",
    halt_reason: "account",
    c_accepted: 2,
    c_pending: 3,
  });
  return send.id;
}

describe("ending a held send (SPEC §12)", () => {
  it("records everyone not yet handed off unsent by the publisher, keeps who was reached, and finishes the send and post", async () => {
    const id = await refusedPartway();
    const mailed = transport.mailed.length;

    const res = await end(id);
    expect(res.status).toBe(200);
    const body: EndResponse = await readJson(res);
    expect(body.resolved).toBe(0);
    expect(body.unsent).toBe(3);
    expect(body.send.status).toBe("sent");
    expect(body.send.ended_by).toMatchObject({ kind: "human" });
    expect(body.send.actions).toEqual([]);

    const rows = await deliveries(id);
    expect(rows.filter((r) => r.status === "accepted").map((r) => r.provider_id)).toEqual([
      "msg_1",
      "msg_2",
    ]);
    expect(rows.filter((r) => r.status === "unsent").map((r) => r.error)).toEqual([
      sends.ENDED_BY_PUBLISHER,
      sends.ENDED_BY_PUBLISHER,
      sends.ENDED_BY_PUBLISHER,
    ]);
    // The outcome still sums to the audience: nothing new, nothing lost.
    const { outcomes, send } = await read(id);
    expect(outcomes).toMatchObject({ recipients: 5, accepted: 2, unsent: 3, pending: 0 });
    expect(send.audience.count).toBe(5);
    expect(send.provider.halt).toBeNull();
    expect((await posts.getPost(env.DB, send.post_id))!.status).toBe("sent");
    expect(transport.mailed.length).toBe(mailed); // ending mailed no one (I4)
  });

  it("is never picked up by the sweep again and mails no one after, even once the provider takes mail (I4)", async () => {
    const id = await refusedPartway();
    expect((await end(id)).status).toBe(200);
    const requests = transport.requests;
    transport.refuse = null;
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 2 * 60 * MIN);
      await sweep(env);
    }
    expect(transport.requests).toBe(requests);
    expect(await row(id)).toMatchObject({ status: "sent", c_accepted: 2, c_unsent: 3 });
  });

  it("lets a later receipt land on a recipient the provider took before the end", async () => {
    const id = await refusedPartway();
    expect((await end(id)).status).toBe(200);
    await sends.markDeliveryEvent(env.DB, {
      providerId: "msg_1",
      event: "delivered",
      at: Date.now(),
    });
    const { outcomes } = await read(id);
    expect(outcomes).toMatchObject({ recipients: 5, delivered: 1, accepted: 1, unsent: 3 });
  });

  it("ends a send held on an outage before its first hand-off, fixing its audience so the record lists everyone it was for", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend();
    transport.outage = 100;
    await sweep(env);
    expect(await row(send.id)).toMatchObject({ halt_reason: "unavailable", c_pending: 3 });
    expect(await actionNames(send.id)).toEqual(["end"]);

    const body: EndResponse = await readJson(await end(send.id));
    expect(body.unsent).toBe(3);
    const { outcomes } = await read(send.id);
    expect(outcomes).toMatchObject({ recipients: 3, unsent: 3, accepted: 0 });
    expect(transport.mailed.length).toBe(0);
  });

  it("records who ended it in the send's log, with no resolution when no one was in flight", async () => {
    const id = await refusedPartway();
    expect((await end(id)).status).toBe(200);
    const acts = await env.DB.prepare(
      "SELECT act, resolution FROM send_acts WHERE send_id = ? AND act = 'end'",
    )
      .bind(id)
      .all();
    expect(acts.results).toEqual([{ act: "end", resolution: null }]);
  });
});

describe("ending a wedged send (SPEC §12)", () => {
  it("settles the recipients in flight as not sent, as Resolve would", async () => {
    allowErrorLogs("send.wedged");
    const id = await wedgedSend();
    expect(await actionNames(id)).toEqual(["resolve", "end"]);
    const body: EndResponse = await readJson(await end(id, { resolution: "unsent" }));
    expect(body).toMatchObject({ resolved: 1, unsent: 0 });
    const [r] = await deliveries(id);
    expect(r).toMatchObject({ status: "unsent" });
    expect(r!.error).toMatch(/^operator adjudication: assumed NOT delivered/);
    expect(body.send.ended_by).not.toBeNull();
    expect(body.send.resolved_by).toBeNull();
    const act = await env.DB.prepare("SELECT resolution FROM send_acts WHERE act = 'end'").first();
    expect(act).toEqual({ resolution: "unsent" });
  });

  it("settles the recipients in flight as sent when the publisher says so", async () => {
    const id = await wedgedSend();
    const body: EndResponse = await readJson(await end(id, { resolution: "accepted" }));
    expect(body).toMatchObject({ resolved: 1, unsent: 0 });
    expect((await read(id)).outcomes).toMatchObject({ recipients: 1, accepted: 1 });
  });
});

describe("what End refuses", () => {
  it("refuses a send still going out, with its own code", async () => {
    await seedConfirmed(addresses(2));
    const send = await dueSend();
    const lease = (await sends.acquireLease(env.DB, send.id, Date.now(), LEASE_TTL_MS))!;
    await sends.releaseLease(env.DB, send.id, lease);
    expect(await actionNames(send.id)).toEqual([]);
    const res = await end(send.id);
    expect(res.status).toBe(409);
    expect((await readJson(res)).error).toBe("not_held");
  });

  it("refuses while a run holds the send, then ends it once the run lets go", async () => {
    const id = await refusedPartway();
    const lease = (await sends.acquireLease(env.DB, id, Date.now(), LEASE_TTL_MS))!;
    expect(await actionNames(id)).toEqual([]);
    const held = await end(id);
    expect(held.status).toBe(409);
    expect((await readJson(held)).error).toBe("run_in_progress");
    await sends.releaseLease(env.DB, id, lease);
    expect(await actionNames(id)).toEqual(["end"]);
    expect((await end(id)).status).toBe(200);
  });

  it("refuses a send already finished, as a second End finds it", async () => {
    const id = await refusedPartway();
    expect((await end(id)).status).toBe(200);
    const again = await end(id);
    expect(again.status).toBe(409);
    const body = await readJson(again);
    expect(body.error).toBe("not_held");
    expect(body.send.status).toBe("sent");
  });

  it("refuses an End with no resolution while recipients are in flight, changing nothing", async () => {
    const id = await wedgedSend();
    const res = await end(id);
    expect(res.status).toBe(400);
    expect((await readJson(res)).field).toBe("resolution");
    expect(await row(id)).toMatchObject({ status: "sending", locked_until: null, c_in_flight: 1 });
  });

  it("refuses a resolution when no one is in flight, changing nothing", async () => {
    const id = await refusedPartway();
    const res = await end(id, { resolution: "unsent" });
    expect(res.status).toBe(400);
    expect((await readJson(res)).field).toBe("resolution");
    expect(await row(id)).toMatchObject({ status: "sending", locked_until: null, c_pending: 3 });
  });
});

describe("the finished email for an ended send (SPEC §8)", () => {
  async function finishedEmail(id: string) {
    await recordNotifications(env.DB, Date.now());
    const n = await env.DB.prepare(
      "SELECT kind FROM notifications WHERE send_id = ? AND kind = 'finished'",
    )
      .bind(id)
      .first();
    expect(n).toEqual({ kind: "finished" });
    const due = (await dueNotifications(env.DB, 10, Date.now())).find(
      (d) => d.send_id === id && d.kind === "finished",
    );
    return composeNotification(due as DueNotification, getConfig(env));
  }

  it("says the send was ended, never that the provider accepted none, when no one was reached", async () => {
    await seedConfirmed(addresses(3));
    const send = await dueSend({ subject: "Owls" });
    transport.refuse = REFUSAL;
    await sweep(env);
    expect((await end(send.id)).status).toBe(200);
    const email = await finishedEmail(send.id);
    expect(email.subject).toBe('"Owls" didn’t reach anyone');
    expect(email.text).toContain('"Owls" was ended at ');
    expect(email.text).toContain("before anyone received it, so none of its 3 emails went out.");
    expect(email.text).not.toContain("accepted none");
    expect((await posts.getPost(env.DB, send.post_id))!.status).toBe("sent");
  });

  it("says how many were reached before the end", async () => {
    const id = await refusedPartway();
    expect((await end(id)).status).toBe(200);
    const email = await finishedEmail(id);
    expect(email.subject).toBe("Ended: Owls");
    expect(email.text).toContain(
      "Your email provider accepted 2 of 5 emails before then, and the other 3 weren’t sent.",
    );
  });
});
