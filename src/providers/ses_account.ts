/**
 * Asking Amazon SES about its own account (SPEC §9): whether it is still in the sandbox, its
 * production-access review, its send rate and daily limit, its standing, whether the sending
 * identity is verified and which configuration set it files mail under by default, and whether
 * the configuration set that applies exists and can send. Read-only SESv2 calls, `GetAccount`,
 * `GetEmailIdentity`, and `GetConfigurationSet`, signed like the sends; the sweep's account
 * check (`services/provider_status.ts`) is the only caller, and only when no send is going
 * out, so these requests never meet a send's. Every check reads all of it, whether or not
 * `SES_CONFIGURATION_SET` names a set, so a setup mistake shows without anything being sent.
 *
 * What an answer means is decided here, as the adapter decides a send's: a key without
 * `ses:GetAccount` (every instance set up before the permission was in the guide) is
 * `permission`, never an error; a key SES doesn't accept at all is `rejected`; anything else
 * that isn't an answer is `unreachable`. A key without `ses:GetEmailIdentity` or
 * `ses:GetConfigurationSet` still gets the account's answer, with that part left unread, so a
 * missing permission never reads as a missing set or an unverified sender.
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

/** The most requests one check makes: `GetAccount`, the identities, then the configuration set. */
export const MAX_ACCOUNT_REQUESTS = 1 + MAX_IDENTITY_LOOKUPS + 1;

/** The least time between two reads: SES takes every action but its single sends at one
 *  request a second. */
export const ACCOUNT_READ_GAP_MS = 1000;

/** Error types that say the key may not make this call, as opposed to not being a key. */
const NOT_PERMITTED = new Set(["AccessDeniedException", "AccessDenied", "NotAuthorized"]);

/**
 * Error types that say SES won't take the key at all, for any call: a key ID it doesn't know,
 * a signature its secret doesn't match, no key, or an AWS account not signed up for SES. Each
 * stops every send until someone fixes the key or the account, so it is reported as such,
 * never as "can't tell". `RequestExpired` is not one: a request dated more than 15 minutes
 * off is a clock that's wrong, which clears on its own, so it stays `unreachable`.
 */
const KEY_REJECTED = new Set([
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "IncompleteSignature",
  "IncompleteSignatureException",
  "InvalidSignatureException",
  "MissingAuthenticationToken",
  "MissingAuthenticationTokenException",
  "OptInRequired",
]);

export type SesAccountCheck =
  | { outcome: "ok"; answer: AccountAnswer }
  | { outcome: "permission" }
  | { outcome: "rejected"; error: string }
  | { outcome: "unreachable"; error: string };

/** One SES read's answer: its JSON, a refusal for want of permission, a key SES rejects,
 *  `missing` for a 404, or no usable answer. */
type Read =
  | { kind: "ok"; body: Record<string, unknown> }
  | { kind: "permission" }
  | { kind: "rejected"; error: string }
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

/** Ask SES about the account, the sending identity, and the configuration set that applies. */
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
    if (KEY_REJECTED.has(type)) {
      return { kind: "rejected", error: sesErrorText(res.status, type, message) };
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
  if (account.kind === "rejected") {
    return { outcome: "rejected", error: account.error };
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
  const identity = await sendingIdentity(read, config.fromAddress);
  if (identity) {
    answer.senderVerified = identity.verified;
    if (identity.verified) {
      answer.identityConfigurationSet = { name: identity.configurationSet };
    }
  }
  const setName = config.sesConfigurationSet ?? answer.identityConfigurationSet?.name ?? null;
  if (setName) {
    const set = await configurationSet(read, setName);
    if (set) {
      answer.configurationSet = set;
    }
  }
  return { outcome: "ok", answer };
}

/**
 * Whether an identity SES could sign `from` with is verified for sending, and the first
 * verified one's default configuration set; undefined when an identity couldn't be read, since
 * the app then can't tell. An identity that exists but isn't verified is passed over: SES signs
 * with the verified one beneath it.
 */
async function sendingIdentity(
  read: (path: string) => Promise<Read>,
  from: string,
): Promise<{ verified: boolean; configurationSet: string | null } | undefined> {
  const candidates = identityCandidates(from);
  for (const identity of candidates) {
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
    return {
      verified: true,
      configurationSet: typeof name === "string" && name.length > 0 ? name : null,
    };
  }
  // A From address with more parent domains than one check reads may be covered by one it
  // didn't, so only a list read down to two labels says the sender isn't verified.
  const last = candidates.at(-1) ?? "";
  return last.includes("@") || last.split(".").length > 2
    ? undefined
    : { verified: false, configurationSet: null };
}

/** The named configuration set as SES describes it: missing (a 404), or present with its
 *  sending on or off; undefined when it couldn't be read. */
async function configurationSet(
  read: (path: string) => Promise<Read>,
  name: string,
): Promise<NonNullable<AccountAnswer["configurationSet"]> | undefined> {
  const r = await read(`configuration-sets/${encodeURIComponent(name)}`);
  if (r.kind === "missing") {
    return { name, exists: false, sendingEnabled: false };
  }
  if (r.kind !== "ok") {
    return undefined;
  }
  const sending = (r.body.SendingOptions ?? {}) as Record<string, unknown>;
  return { name, exists: true, sendingEnabled: sending.SendingEnabled !== false };
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
