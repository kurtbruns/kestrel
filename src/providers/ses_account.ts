/**
 * Asking Amazon SES about its own account (SPEC §9): whether it is still in the sandbox, its
 * production-access review, its send rate and daily limit, its standing, and, when
 * `SES_CONFIGURATION_SET` names no set, the configuration set the sending identity files mail
 * under by default. Read-only SESv2 calls, `GetAccount` and `GetEmailIdentity`, signed like the
 * sends; the sweep's account check (`services/provider_status.ts`) is the only caller, and only
 * when no send is going out, so these requests never meet a send's.
 *
 * What an answer means is decided here, as the adapter decides a send's: a key without
 * `ses:GetAccount` (every instance set up before the permission was in the guide) is
 * `permission`, never an error; anything else that isn't an answer is `unreachable`. A key
 * without `ses:GetEmailIdentity` still gets the account's answer, with the identity's set left
 * unread, so a missing permission never reads as a missing configuration set.
 *
 * SES takes these actions at one request a second, so the reads go out a second apart: a
 * throttled identity read would otherwise leave the set unread, and the warning it could
 * raise silently missing.
 */
import { AwsClient } from "aws4fetch";
import type { AccountEnforcement, ProductionReview } from "../../shared/provider";
import type { AccountAnswer } from "../db/provider_account";
import type { AppEnv, Config } from "../env";
import { parseSesError, sesErrorText } from "./ses";

/** How long one account request may take: an answer is well under a second, and a check that
 *  times out is only tried again later. */
const ACCOUNT_REQUEST_TIMEOUT_MS = 10_000;

/** The most identities one check reads, from the From address up through its parent domains. */
export const MAX_IDENTITY_LOOKUPS = 4;

/** The most requests one check makes: `GetAccount`, then the identities. */
export const MAX_ACCOUNT_REQUESTS = 1 + MAX_IDENTITY_LOOKUPS;

/** The least time between two reads: SES takes every action but its single sends at one
 *  request a second. */
export const ACCOUNT_READ_GAP_MS = 1000;

/** Error types that say the key may not make this call, as opposed to not being a key. */
const NOT_PERMITTED = new Set(["AccessDeniedException", "AccessDenied", "NotAuthorized"]);

export type SesAccountCheck =
  | { outcome: "ok"; answer: AccountAnswer }
  | { outcome: "permission" }
  | { outcome: "unreachable"; error: string };

/** One SES read's answer: its JSON, a refusal for want of permission, `missing` for a 404, or
 *  no usable answer. */
type Read =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "permission" }
  | { kind: "missing" }
  | { kind: "failed"; error: string };

/**
 * The identities SES could sign `from` with, most specific first: the address, its domain,
 * then each parent domain down to two labels. SES applies the default configuration set of
 * the most specific verified identity, so the first one that exists decides.
 */
export function identityCandidates(from: string): string[] {
  const address = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const out = at > 0 ? [address] : [];
  const labels = address.slice(at + 1).split(".");
  for (let i = 0; labels.length - i >= 2; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out.slice(0, MAX_IDENTITY_LOOKUPS);
}

/** Ask SES about the account and, unless `SES_CONFIGURATION_SET` is set, the sending identity. */
export async function checkSesAccount(config: Config, env: AppEnv): Promise<SesAccountCheck> {
  const client = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "",
    service: "ses",
    region: config.awsRegion,
    retries: 0,
  });
  const base = `https://email.${config.awsRegion}.amazonaws.com/v2/email`;
  let lastAt = Number.NEGATIVE_INFINITY;
  const read = async (path: string): Promise<Read> => {
    const wait = lastAt + ACCOUNT_READ_GAP_MS - performance.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastAt = performance.now();
    let res: Response;
    try {
      res = await client.fetch(`${base}/${path}`, {
        method: "GET",
        signal: AbortSignal.timeout(ACCOUNT_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
    }
    const text = await res.text().catch(() => "");
    if (res.ok) {
      try {
        return { kind: "ok", body: JSON.parse(text) as Record<string, unknown> };
      } catch {
        return { kind: "failed", error: `ses ${res.status}: an answer that isn't JSON` };
      }
    }
    const { type, message } = parseSesError(text, res.headers.get("x-amzn-ErrorType"));
    if (NOT_PERMITTED.has(type)) {
      return { kind: "permission" };
    }
    if (res.status === 404 || type === "NotFoundException") {
      return { kind: "missing" };
    }
    return { kind: "failed", error: sesErrorText(res.status, type, message) };
  };

  const account = await read("account");
  if (account.kind === "permission") {
    return { outcome: "permission" };
  }
  if (account.kind !== "ok") {
    return {
      outcome: "unreachable",
      error: account.kind === "failed" ? account.error : "ses 404: no account",
    };
  }
  const answer = accountAnswer(account.body);
  if (!answer) {
    return { outcome: "unreachable", error: "ses: an account answer without its send quota" };
  }
  if (!config.sesConfigurationSet) {
    const identity = await identitySet(read, config.fromAddress);
    if (identity) {
      answer.identityConfigurationSet = identity;
    }
  }
  return { outcome: "ok", answer };
}

/** The default configuration set of the first identity verified for sending, or undefined when
 *  one couldn't be read or none is verified, since SES then sends nothing to file. An identity
 *  that exists but isn't verified is passed over: SES signs with the verified one beneath it. */
async function identitySet(
  read: (path: string) => Promise<Read>,
  from: string,
): Promise<{ name: string | null } | undefined> {
  for (const identity of identityCandidates(from)) {
    const r = await read(`identities/${encodeURIComponent(identity)}`);
    if (r.kind === "missing") {
      continue;
    }
    if (r.kind !== "ok") {
      return undefined;
    }
    if (r.body.VerifiedForSendingStatus !== true) {
      continue;
    }
    const name = r.body.ConfigurationSetName;
    return { name: typeof name === "string" && name.length > 0 ? name : null };
  }
  return undefined;
}

const REVIEWS: Record<string, ProductionReview> = {
  PENDING: "pending",
  GRANTED: "granted",
  DENIED: "denied",
  FAILED: "failed",
};

const ENFORCEMENT: Record<string, AccountEnforcement> = {
  HEALTHY: "healthy",
  PROBATION: "probation",
  SHUTDOWN: "shutdown",
};

/** `GetAccount`'s body as the check keeps it, or null without the send quota, which every
 *  account answer carries. */
export function accountAnswer(body: Record<string, unknown>): AccountAnswer | null {
  const quota = (body.SendQuota ?? {}) as Record<string, unknown>;
  const rate = quota.MaxSendRate;
  if (typeof rate !== "number" || !(rate > 0)) {
    return null;
  }
  const details = (body.Details ?? {}) as Record<string, unknown>;
  const review = (details.ReviewDetails ?? {}) as Record<string, unknown>;
  const daily = quota.Max24HourSend;
  const sent = quota.SentLast24Hours;
  const caseId = review.CaseId;
  return {
    productionAccess: body.ProductionAccessEnabled === true,
    review: REVIEWS[String(review.Status ?? "")] ?? null,
    reviewCase: typeof caseId === "string" && caseId.length > 0 ? caseId : null,
    maxSendRate: rate,
    max24HourSend: typeof daily === "number" && daily >= 0 ? daily : null,
    sentLast24Hours: typeof sent === "number" ? sent : 0,
    enforcement: ENFORCEMENT[String(body.EnforcementStatus ?? "")] ?? null,
    sendingEnabled: body.SendingEnabled !== false,
  };
}
