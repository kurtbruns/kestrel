import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderStatusView, SendingPurpose } from "../shared/provider";
import { readSending, recordAccepted } from "../src/db/sending";
import { getConfig } from "../src/env";
import { drainSimulatedWebhooks } from "../src/providers/simulate";
import { _clearKeyCache, type SnsEnvelope } from "../src/providers/sns";
import { providerStatusView } from "../src/services/provider_status";
import { noteContact } from "../src/services/sending";
import { NOT_CONNECTED_DEPLOY, SES_DEPLOY, SNS_TOPIC_ARN } from "./support/deploy";
import { resetDatabase, seedDelivery } from "./support/fixtures";
import { AUTH } from "./support/http";
import { allowErrorLogs } from "./support/log";
import { makeSigner, type Signer, signEnvelope } from "./support/sns";
import { fetchWith, withVars } from "./support/worker_env";

// Whether SES's reports reach the app (SPEC §13): the webhook keeps when the last report
// arrived, the record of an email SES took starts the wait for one, and an hour of waiting is
// the `receipts_not_arriving` warning, read by both clients from GET /api/provider.

const HOUR = 60 * 60_000;
const MINUTE = 60_000;
const OTHER_TOPIC = "arn:aws:sns:us-east-1:123456789012:kestrel-events-old";

let signer: Signer;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now());
  await resetDatabase();
  _clearKeyCache();
  signer = await makeSigner();
  // The webhook fetches SNS's signing certificate; nothing else here leaves the Worker.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return url === signer.certUrl
      ? new Response(signer.certPem, { status: 200 })
      : new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** What GET /api/provider answers on an SES deployment, from the record as it stands. The
 *  route itself signs in only in a dev-shaped env, so the simulation's tests read it over HTTP. */
async function status(vars: Record<string, string> = SES_DEPLOY): Promise<ProviderStatusView> {
  return providerStatusView(getConfig(withVars(vars)), null, await readSending(env.DB));
}

const codes = (v: ProviderStatusView) => v.warnings.map((w) => w.code);

/** SES took an email of this kind now, recorded by the path every email's answer takes. */
async function taken(purpose: SendingPurpose = "test"): Promise<void> {
  await noteContact(
    env.DB,
    getConfig(withVars(SES_DEPLOY)),
    purpose,
    { kind: "accepted" },
    Date.now(),
  );
}

/** SES's report of one event, as SNS posts it to the webhook, from `topic`. */
async function report(
  type: "Delivery" | "Bounce" | "Complaint",
  email: string,
  messageId: string,
  topic = SNS_TOPIC_ARN,
): Promise<Response> {
  const detail =
    type === "Delivery"
      ? { delivery: { recipients: [email] } }
      : type === "Bounce"
        ? {
            bounce: {
              bounceType: "Permanent",
              bounceSubType: "General",
              bouncedRecipients: [{ emailAddress: email }],
            },
          }
        : {
            complaint: {
              complaintFeedbackType: "abuse",
              complainedRecipients: [{ emailAddress: email }],
            },
          };
  const envelope: SnsEnvelope = {
    Type: "Notification",
    MessageId: crypto.randomUUID(),
    TopicArn: topic,
    Message: JSON.stringify({
      notificationType: type,
      mail: { messageId, destination: [email] },
      ...detail,
    }),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    Signature: "",
    SigningCertURL: signer.certUrl,
  };
  return fetchWith(SES_DEPLOY, "/webhooks/ses", {
    method: "POST",
    headers: { "content-type": "text/plain; charset=UTF-8" },
    body: JSON.stringify(await signEnvelope(envelope, signer)),
  });
}

describe("the warning that SES's reports aren't arriving (SPEC §13)", () => {
  it("shows once SES took an email more than an hour ago with no report since, and not before", async () => {
    await taken("test");
    const at = Date.now();
    later(HOUR);
    expect(codes(await status())).toEqual([]);
    later(1);
    const view = await status();
    expect(view.receipts).toEqual({ last_at: null, waiting_since: at, refused_topic: null });
    expect(view.warnings).toEqual([
      {
        code: "receipts_not_arriving",
        severity: "warn",
        message:
          "SES took an email more than an hour ago, and no report of a delivery, bounce, or complaint has reached Kestrel since. Until one does, a bounced address is mailed again and a complaint unsubscribes no one. Check that the configuration set has an enabled SNS destination and its topic lets SES publish (Connect Amazon SES, section 4), then that /webhooks/ses isn’t behind Access, the app’s subscription to the topic is confirmed, and SNS_TOPIC_ARN names that topic (section 7), or the set doesn’t report Deliveries; the guide selects them.",
        docs: { slug: "ses", anchor: "4-send-bounces-and-complaints-to-the-app" },
      },
    ]);
  });

  it("says nothing before SES has taken an email, however long it has been", async () => {
    later(3 * HOUR);
    const view = await status();
    expect(view.receipts).toEqual({ last_at: null, waiting_since: null, refused_topic: null });
    expect(codes(view)).toEqual([]);
  });

  const cases: {
    name: string;
    purpose: SendingPurpose;
    type: "Delivery" | "Bounce" | "Complaint";
    row: boolean;
  }[] = [
    { name: "a delivery of a test", purpose: "test", type: "Delivery", row: false },
    { name: "a bounce of a confirmation", purpose: "confirmation", type: "Bounce", row: false },
    {
      name: "a complaint about a notification",
      purpose: "notification",
      type: "Complaint",
      row: false,
    },
    { name: "a delivery of a list send", purpose: "list", type: "Delivery", row: true },
    { name: "a bounce from a list send", purpose: "list", type: "Bounce", row: true },
  ];
  for (const c of cases) {
    it(`clears when any report lands: ${c.name}`, async () => {
      if (c.row) {
        await seedDelivery("reader@example.com", "msg-1");
      }
      await taken(c.purpose);
      later(2 * HOUR);
      expect(codes(await status())).toEqual(["receipts_not_arriving"]);
      expect((await report(c.type, "reader@example.com", "msg-1")).status).toBe(200);
      const view = await status();
      expect(codes(view)).toEqual([]);
      expect(view.receipts).toEqual({
        last_at: Date.now(),
        waiting_since: null,
        refused_topic: null,
      });
    });
  }

  it("still warns on a busy instance that keeps sending: the wait runs from the first email after the last report", async () => {
    await report("Delivery", "reader@example.com", "msg-0");
    const first = Date.now() + MINUTE;
    for (let i = 0; i < 4; i += 1) {
      later(i === 0 ? MINUTE : 30 * MINUTE);
      await taken("confirmation");
    }
    // The last email went a minute ago; the first after the report, an hour and a half ago.
    later(MINUTE);
    const view = await status();
    expect(view.receipts?.waiting_since).toBe(first);
    expect(codes(view)).toEqual(["receipts_not_arriving"]);
  });

  it("starts the wait again with the first email after a report, not one before it", async () => {
    await taken("test");
    later(10 * MINUTE);
    await report("Delivery", "reader@example.com", "msg-1");
    later(10 * MINUTE);
    await taken("test");
    const second = Date.now();
    // An answer recorded late, for an email taken before the report, starts nothing.
    await recordAccepted(env.DB, "list", second - 15 * MINUTE);
    expect((await readSending(env.DB))?.waitingSince).toBe(second);
    later(HOUR + 1);
    expect(codes(await status())).toEqual(["receipts_not_arriving"]);
  });

  it("names exactly the topic SES reports to and the one SNS_TOPIC_ARN names, until a report is taken after the refusal", async () => {
    allowErrorLogs("webhook.refused");
    await taken("test");
    later(5 * MINUTE);
    expect((await report("Delivery", "reader@example.com", "msg-1", OTHER_TOPIC)).status).toBe(403);
    const refusedAt = Date.now();
    later(HOUR);
    const view = await status();
    expect(view.receipts?.refused_topic).toEqual({
      topic: OTHER_TOPIC,
      expected: SNS_TOPIC_ARN,
      at: refusedAt,
    });
    expect(view.warnings.map((w) => w.message)).toEqual([
      `SES took an email more than an hour ago, and Kestrel refused the reports since: SES reports to ${OTHER_TOPIC}, but SNS_TOPIC_ARN names ${SNS_TOPIC_ARN}. Until they match, a bounced address is mailed again and a complaint unsubscribes no one. Store the topic SES reports to in SNS_TOPIC_ARN and deploy, or point the configuration set’s SNS destination at the topic SNS_TOPIC_ARN names.`,
    ]);

    // Fixed: a report from the right topic clears the warning, and the refusal is history.
    expect((await report("Delivery", "reader@example.com", "msg-2")).status).toBe(200);
    expect(codes(await status())).toEqual([]);
    later(MINUTE);
    await taken("test");
    later(HOUR + 1);
    const again = await status();
    expect(again.receipts?.refused_topic).toBeNull();
    expect(again.warnings.map((w) => w.message)).toEqual([
      expect.stringContaining("no report of a delivery, bounce, or complaint has reached Kestrel"),
    ]);
  });

  it("keeps no topic from a report whose signature fails, since only SNS's own names a real topic", async () => {
    allowErrorLogs("webhook.refused");
    const forger = await makeSigner();
    const envelope: SnsEnvelope = {
      Type: "Notification",
      MessageId: crypto.randomUUID(),
      TopicArn: OTHER_TOPIC,
      Message: "{}",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      Signature: "",
      SigningCertURL: signer.certUrl,
    };
    const res = await fetchWith(SES_DEPLOY, "/webhooks/ses", {
      method: "POST",
      headers: { "content-type": "text/plain; charset=UTF-8" },
      body: JSON.stringify(await signEnvelope(envelope, forger)),
    });
    expect(res.status).toBe(403);
    expect((await readSending(env.DB))?.refusedTopic ?? null).toBeNull();
  });

  it("only warns: signups stay open and email reads working while it shows (SPEC §7)", async () => {
    await taken("confirmation");
    later(2 * HOUR);
    const view = await status();
    expect(codes(view)).toEqual(["receipts_not_arriving"]);
    expect(view.sending?.state).toBe("working");
    expect(view.signups).toBe("open");
  });

  it("is not reported with no provider connected", async () => {
    await recordAccepted(env.DB, "test", Date.now());
    later(2 * HOUR);
    const view = await status(NOT_CONNECTED_DEPLOY);
    expect(view.receipts).toBeNull();
    expect(view.warnings).toEqual([]);
  });
});

describe("the dev simulation's reports (SPEC §10, §13)", () => {
  const simulated = (account: string) =>
    withVars({ SIMULATE_SENDS: "ses", SIMULATE_ACCOUNT: account });

  async function simStatus(account: string): Promise<ProviderStatusView> {
    const res = await fetchWith(
      { SIMULATE_SENDS: "ses", SIMULATE_ACCOUNT: account },
      "/api/provider",
      { headers: AUTH },
    );
    return (await res.json()) as ProviderStatusView;
  }

  it("reports a test a few seconds after SES takes it, so the wait clears on its own", async () => {
    await recordAccepted(env.DB, "test", Date.now());
    later(5_000);
    await drainSimulatedWebhooks(simulated("production"), getConfig(simulated("production")));
    expect((await readSending(env.DB))?.waitingSince).toBeNull();
    expect((await readSending(env.DB))?.lastReceiptAt).toBe(Date.now());
  });

  it("withholds every report with :unreported, so the warning shows after its two minutes", async () => {
    await recordAccepted(env.DB, "test", Date.now());
    later(2 * MINUTE);
    await drainSimulatedWebhooks(
      simulated("production:unreported"),
      getConfig(simulated("production:unreported")),
    );
    expect(codes(await simStatus("production:unreported"))).toEqual([]);
    later(1);
    const view = await simStatus("production:unreported");
    expect(view.warnings.map((w) => w.message)).toEqual([
      expect.stringMatching(/^SES took an email more than two minutes ago, and no report/),
    ]);
  });

  it("refuses its reports as from another topic with :wrong_topic, naming both", async () => {
    await recordAccepted(env.DB, "test", Date.now());
    later(5_000);
    const vars = simulated("sandbox:wrong_topic");
    await drainSimulatedWebhooks(vars, getConfig(vars));
    later(2 * MINUTE);
    const view = await simStatus("sandbox:wrong_topic");
    expect(view.receipts?.last_at).toBeNull();
    expect(view.warnings.map((w) => w.code)).toEqual(["receipts_not_arriving"]);
    expect(view.warnings[0]?.message).toContain(
      "SES reports to arn:aws:sns:us-east-1:111122223333:kestrel-events-old, but SNS_TOPIC_ARN names arn:aws:sns:us-east-1:111122223333:kestrel-events.",
    );
  });
});
