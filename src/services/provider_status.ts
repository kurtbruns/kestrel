/**
 * The email provider's connection (SPEC §13): the sweep's account check, which asks the
 * provider about its own account and keeps the answer (`db/provider_account.ts`), and the view
 * both clients read (`GET /api/provider`), built from that answer and the deploy config.
 *
 * The check is downstream of sending, never part of it. It runs only on a tick that sent
 * nothing, so its requests never meet a send's (SES throttles its other actions to one request
 * a second, and the send loop uses that second to the full), and nothing that decides whether
 * to send reads what it found: a sandbox refusal is still found and held from the provider's
 * own answer (SPEC §12). The one thing a send takes from it is its pace (`sesSendRate`).
 */

import type {
  ConfigurationSetView,
  ProviderStatusView,
  ProviderWarning,
  ProviderWarningCode,
  RefusingCause,
  SendRateSource,
} from "../../shared/provider";
import {
  type AccountAnswer,
  type ProviderAccountRow,
  readProviderAccount,
  recordAnswer,
  recordMiss,
} from "../db/provider_account";
import { clearCheckRefusal, readSending, type SendingRow } from "../db/sending";
import type { AppEnv, Config } from "../env";
import { DEFAULT_SES_MAX_SEND_RATE } from "../env";
import { log } from "../lib/log";
import { checkSesAccount, MAX_ACCOUNT_REQUESTS } from "../providers/ses_account";
import { simulatedAccountRow } from "../providers/simulate";
import type { Budget } from "../send/budget";
import { noteRefusal, sendingView, signupsState } from "./sending";

/** How old an answer may get before an idle tick asks again: a grant of production access
 *  shows within about this long. */
export const ACCOUNT_CHECK_INTERVAL_MS = 10 * 60_000;

/** How long a key without the permission waits between asks, so an instance that hasn't
 *  added it spends one request an hour, not six. */
export const PERMISSION_RECHECK_MS = 60 * 60_000;

/** What one check may cost: the row's read, the provider's requests, one write, and what it
 *  says about whether email is getting out: the sending row's read, and a refusal recorded
 *  with its notice (SPEC §13). */
const CHECK_QUERIES = 5;

/** Whether the account is due a check at `now`. */
export function accountCheckDue(row: ProviderAccountRow | null, now: number): boolean {
  if (!row) {
    return true;
  }
  const wait = row.outcome === "permission" ? PERMISSION_RECHECK_MS : ACCOUNT_CHECK_INTERVAL_MS;
  return now - row.attemptedAt >= wait;
}

/**
 * Ask the provider about its account when the answer is due, and keep what it says. Only SES
 * has an account to ask. The caller runs it on a tick that sent nothing, within what the tick
 * has left of `budget`.
 */
export async function refreshProviderAccount(
  env: AppEnv,
  config: Config,
  budget: Budget,
  now: number,
): Promise<void> {
  const simulated = config.provider === "ses" ? null : config.simulation?.account;
  if (simulated) {
    // Local dev's stand-in account finds its problems as the real check would, each tick
    // that sent nothing, so a refusal it stands in for reaches the state by the same path.
    await noteAccountRefusal(
      env.DB,
      config,
      simulatedAccountRow(simulated, config, now),
      Date.now(),
    );
    return;
  }
  if (config.provider !== "ses" || !budget.affords(CHECK_QUERIES, MAX_ACCOUNT_REQUESTS)) {
    return;
  }
  budget.query();
  const row = await readProviderAccount(env.DB);
  if (!accountCheckDue(row, now)) {
    return;
  }
  budget.request(MAX_ACCOUNT_REQUESTS);
  const check = await checkSesAccount(config, env);
  // When the account answered: what it says about whether email is getting out is as of then,
  // so it never replaces an email's answer given after it.
  const read = Date.now();
  budget.query();
  if (check.outcome === "ok") {
    keepUnread(check.answer, row?.answer ?? null, config);
    await recordAnswer(env.DB, now, check.answer);
    budget.query(3);
    await noteAccountRefusal(
      env.DB,
      config,
      { attemptedAt: now, outcome: "ok", checkedAt: now, answer: check.answer },
      read,
    );
    log.info("provider.account_checked", {
      outcome: "ok",
      productionAccess: check.answer.productionAccess,
      maxSendRate: check.answer.maxSendRate,
      enforcement: check.answer.enforcement,
      sendingEnabled: check.answer.sendingEnabled,
      configurationSet: check.answer.identityConfigurationSet
        ? check.answer.identityConfigurationSet.name !== null
        : undefined,
      configurationSetExists: check.answer.configurationSet?.exists,
      senderVerified: check.answer.senderVerified,
    });
    return;
  }
  await recordMiss(env.DB, now, check.outcome);
  log.info("provider.account_checked", {
    outcome: check.outcome,
    error: check.outcome === "permission" ? undefined : check.error,
  });
  if (check.outcome === "rejected") {
    budget.query(3);
    await noteAccountRefusal(
      env.DB,
      config,
      { attemptedAt: now, outcome: "rejected", checkedAt: null, answer: null },
      read,
    );
  }
}

/** The refusing cause each error the account check can find stands for (SPEC §13): every one
 *  of them refuses every email, as a send would find. */
const WARNING_CAUSES: Partial<Record<ProviderWarningCode, RefusingCause>> = {
  key_rejected: "credentials",
  sending_disabled: "paused",
  configuration_set_missing: "configuration",
  configuration_set_paused: "set_paused",
  sender_unverified: "sender",
};

/**
 * The refusals the account check found, errors first, each in the check's own words. Found
 * without sending, so each makes email refusing and pauses signups, and the publisher is
 * told, at most once a day (SPEC §8).
 */
export function accountRefusals(
  config: Config,
  row: ProviderAccountRow,
): { cause: RefusingCause; error: string }[] {
  const out: { cause: RefusingCause; error: string }[] = [];
  for (const w of warnings(config, row, configurationSet(config, row.answer))) {
    const cause = WARNING_CAUSES[w.code];
    if (cause && w.severity === "error") {
      out.push({ cause, error: w.message });
    }
  }
  return out;
}

/**
 * What a reading, taken at `at`, says about whether email is getting out (SPEC §13). A refusal
 * it finds makes email refusing, unless an email the provider took has contradicted that same
 * finding since, so a reading that stays wrong while email goes out pauses signups once, not
 * every ten minutes; it still shows as a warning, and a different finding pauses them again.
 * A clean reading lifts a refusal an earlier reading found, back to where email stood before,
 * so a reading wrong for a moment pauses signups only until the next, and forgets what emails
 * contradicted. It never makes email working where none has been, and never lifts a refusal
 * an email met, which only an email the provider takes lifts. A check that read nothing (a
 * key not allowed to ask, no answer) says nothing.
 */
async function noteAccountRefusal(
  db: D1Database,
  config: Config,
  row: ProviderAccountRow,
  at: number,
): Promise<void> {
  const found = accountRefusals(config, row);
  if (found.length > 0) {
    const contradicted = (await readSending(db))?.checkContradicted ?? [];
    const standing = found.find((f) => !contradicted.includes(f.cause));
    if (standing) {
      await noteRefusal(db, { ...standing, foundBy: "account_check" }, at, true);
    }
  } else if (row.outcome === "ok" && (await clearCheckRefusal(db, at))) {
    log.info("sending.cleared", { foundBy: "account_check" });
  }
}

/**
 * A part of the account this check couldn't read keeps what the last check found, as the
 * account itself does when it can't be read: the identity, and the configuration set while it
 * is still the one that applies. The sender's verdict isn't tied to the From address it was
 * read for, so after a deploy that changes the address, a failed identity read shows the old
 * verdict until the next good one: rare, and it clears itself.
 */
function keepUnread(answer: AccountAnswer, last: AccountAnswer | null, config: Config): void {
  if (!last) {
    return;
  }
  if (!answer.identityConfigurationSet && last.identityConfigurationSet) {
    answer.identityConfigurationSet = last.identityConfigurationSet;
  }
  if (answer.senderVerified === undefined && last.senderVerified !== undefined) {
    answer.senderVerified = last.senderVerified;
  }
  const applies = config.sesConfigurationSet ?? answer.identityConfigurationSet?.name ?? null;
  if (!answer.configurationSet && last.configurationSet?.name === applies) {
    answer.configurationSet = last.configurationSet;
  }
}

/**
 * The rate a send keeps to, in messages a second, and where it comes from: the lower of the
 * account's own and `SES_MAX_SEND_RATE` when both are known (a setting above the account only
 * draws throttles, one below it is a choice), whichever one is known otherwise, else the
 * default (SPEC §12).
 */
export function sesSendRate(
  config: Pick<Config, "sesMaxSendRateSetting">,
  answer: Pick<AccountAnswer, "maxSendRate"> | null,
): { value: number; source: SendRateSource } {
  const setting = config.sesMaxSendRateSetting;
  const account = answer ? Math.max(1, Math.floor(answer.maxSendRate)) : null;
  if (account !== null && (setting === null || account <= setting)) {
    return { value: account, source: "account" };
  }
  if (setting !== null) {
    return { value: setting, source: "setting" };
  }
  return { value: DEFAULT_SES_MAX_SEND_RATE, source: "default" };
}

/** The account's answer the send loop paces by, read once a tick; null off SES. */
export async function accountForPacing(
  db: D1Database,
  config: Config,
): Promise<AccountAnswer | null> {
  if (config.provider !== "ses") {
    return null;
  }
  return (await readProviderAccount(db))?.answer ?? null;
}

/**
 * Whether the provider's account was last read in the sandbox: SES's own reading, or local
 * dev's stand-in for it. False when it can't tell, so the `sandbox` condition only ever says
 * what the account itself said (SPEC §6).
 */
export async function readSandbox(db: D1Database, config: Config): Promise<boolean> {
  if (config.provider === "ses") {
    const answer = (await readProviderAccount(db))?.answer;
    return answer ? !answer.productionAccess : false;
  }
  const simulated = config.simulation?.account;
  return simulated
    ? simulatedAccountRow(simulated, config, Date.now()).answer?.productionAccess === false
    : false;
}

/** The anchor of the guide's step that routes bounces and complaints to the app. */
export const BOUNCES_DOC = { slug: "ses", anchor: "4-send-bounces-and-complaints-to-the-app" };

/** The guide's step that creates the app's AWS key and its policy. */
const KEY_DOC = { slug: "ses", anchor: "5-create-the-apps-aws-key" };

/** The guide's step that verifies the sending hostname. */
const SENDER_DOC = { slug: "ses", anchor: "1-verify-your-sending-hostname" };

/** Troubleshooting's section on problems with the SES account, which covers what AWS does to it. */
const ACCOUNT_DOC = { slug: "troubleshooting", anchor: "a-problem-with-amazon-ses" };

function configurationSet(
  config: Config,
  answer: AccountAnswer | null,
): ConfigurationSetView | null {
  if (config.sesConfigurationSet) {
    return { name: config.sesConfigurationSet, source: "setting" };
  }
  const identity = answer?.identityConfigurationSet;
  if (!identity) {
    return null;
  }
  return identity.name
    ? { name: identity.name, source: "identity" }
    : { name: null, source: "none" };
}

/** The address part of a From address, for the words of a warning. */
function fromEmail(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim();
}

/**
 * What the account check found worth a look (SPEC §13), errors first: each `error` stops every
 * email until it's fixed, each `warn` leaves sending working. A part the check couldn't read
 * raises nothing.
 */
function warnings(
  config: Config,
  row: ProviderAccountRow | null,
  set: ConfigurationSetView | null,
): ProviderWarning[] {
  const answer = row?.answer ?? null;
  const out: ProviderWarning[] = [];
  const region = config.awsRegion;
  if (row?.outcome === "rejected") {
    out.push({
      code: "key_rejected",
      severity: "error",
      message:
        "Amazon SES rejects Kestrel’s AWS key, so no email can go out. Check that the AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY secrets hold the key’s ID and its secret, and that the key is active in IAM. If they do, the AWS account may not be signed up for SES.",
      docs: KEY_DOC,
    });
  }
  if (answer?.enforcement === "shutdown") {
    out.push({
      code: "sending_disabled",
      severity: "error",
      message:
        "AWS has paused your SES account’s sending, so no email can go out. AWS’s email to the AWS account says why and what it needs: answer it in AWS Support.",
      docs: ACCOUNT_DOC,
    });
  } else if (answer && !answer.sendingEnabled) {
    out.push({
      code: "sending_disabled",
      severity: "error",
      // AWS documents turning account sending back on only from the CLI, with no console switch.
      message: `Sending is turned off for your SES account in ${region}, so no email can go out. Turn it back on with the AWS CLI: aws sesv2 put-account-sending-attributes --sending-enabled --region ${region}`,
      docs: ACCOUNT_DOC,
    });
  }
  const found = answer?.configurationSet;
  if (found && set?.name === found.name) {
    const where =
      set.source === "setting"
        ? `SES_CONFIGURATION_SET names ${found.name}`
        : `The sending identity’s default configuration set is ${found.name}`;
    if (!found.exists) {
      out.push({
        code: "configuration_set_missing",
        severity: "error",
        message: `${where}, and SES has no configuration set by that name in ${region}, so it refuses every email. Correct the name, or create the set in that region.`,
        docs: BOUNCES_DOC,
      });
    } else if (!found.sendingEnabled) {
      out.push({
        code: "configuration_set_paused",
        severity: "error",
        message: `${where}, and sending is turned off for that set, so SES refuses every email. Turn its sending back on in the SES console, under Configuration sets.`,
        docs: BOUNCES_DOC,
      });
    }
  }
  if (answer?.senderVerified === false) {
    out.push({
      code: "sender_unverified",
      severity: "error",
      message: `SES has no verified identity for ${fromEmail(config.fromAddress)} in ${region}, so it refuses every email. Verify ${config.sendingDomain} in SES, in the region AWS_REGION names.`,
      docs: SENDER_DOC,
    });
  }
  if (answer?.enforcement === "probation") {
    out.push({
      code: "account_probation",
      severity: "warn",
      message:
        "AWS is reviewing your SES account over its bounce or complaint rate. It still sends, but AWS can pause it. AWS’s email to the AWS account says what to fix.",
      docs: ACCOUNT_DOC,
    });
  }
  if (set?.source === "none") {
    out.push({
      code: "bounces_not_routed",
      severity: "warn",
      message: `Bounces and complaints won’t reach Kestrel. Mail from ${config.sendingDomain} goes out under no configuration set, so a bounced address is mailed again with every post and a complaint unsubscribes no one. Name the set in SES_CONFIGURATION_SET, or make it the sending identity’s default.`,
      docs: BOUNCES_DOC,
    });
  }
  return out;
}

/** GET /api/provider, from the deploy config, the account check's row, and the sending row. */
export function providerStatusView(
  config: Config,
  read: ProviderAccountRow | null,
  sendingRow: SendingRow | null,
): ProviderStatusView {
  let row = read;
  const sending = sendingView(config, sendingRow);
  const none: ProviderStatusView = {
    provider: config.provider,
    state: "not_connected",
    unknown_reason: null,
    review: null,
    review_case: null,
    send_rate: null,
    account: null,
    configuration_set: null,
    warnings: [],
    checked_at: null,
    sending,
    signups: signupsState(sending),
  };
  if (config.provider === "none") {
    return none;
  }
  if (config.provider !== "ses") {
    // Local dev may stand in for the SES account (`SIMULATE_ACCOUNT`, SPEC §10), so the
    // editor can be seen in each state; `simulation` is only ever set in a dev-shaped env.
    const simulated = config.simulation?.account;
    if (!simulated) {
      return { ...none, state: "unknown", unknown_reason: "stand_in" };
    }
    row = simulatedAccountRow(simulated, config, Date.now());
  }
  const answer = row?.answer ?? null;
  const set = configurationSet(config, answer);
  const base: ProviderStatusView = {
    ...none,
    send_rate: sesSendRate(config, answer),
    configuration_set: set,
    warnings: warnings(config, row, set),
  };
  if (!answer) {
    const reason = !row
      ? "not_checked"
      : row.outcome === "permission" || row.outcome === "rejected"
        ? row.outcome
        : "unreachable";
    return { ...base, state: "unknown", unknown_reason: reason };
  }
  return {
    ...base,
    state: answer.productionAccess ? "production" : "sandbox",
    review: answer.review,
    review_case: answer.reviewCase,
    account: {
      max_send_rate: answer.maxSendRate,
      max_24_hour_send: answer.max24HourSend,
      sent_last_24_hours: answer.sentLast24Hours,
      enforcement: answer.enforcement,
      sending_enabled: answer.sendingEnabled,
    },
    checked_at: row?.checkedAt ?? null,
  };
}
