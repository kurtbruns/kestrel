/**
 * The email provider's connection (SPEC §9): the sweep's account check, which asks the
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
  SendRateSource,
} from "../../shared/provider";
import {
  type AccountAnswer,
  type ProviderAccountRow,
  readProviderAccount,
  recordAnswer,
  recordMiss,
} from "../db/provider_account";
import type { AppEnv, Config } from "../env";
import { DEFAULT_SES_MAX_SEND_RATE } from "../env";
import { log } from "../lib/log";
import { checkSesAccount, MAX_ACCOUNT_REQUESTS } from "../providers/ses_account";
import { simulatedAccountRow } from "../providers/simulate";
import type { Budget } from "../send/budget";

/** How old an answer may get before an idle tick asks again: a grant of production access
 *  shows within about this long. */
export const ACCOUNT_CHECK_INTERVAL_MS = 10 * 60_000;

/** How long a key without the permission waits between asks, so an instance that hasn't
 *  added it spends one request an hour, not six. */
export const PERMISSION_RECHECK_MS = 60 * 60_000;

/** What one check may cost: the row's read, the provider's requests, and one write. */
const CHECK_QUERIES = 2;

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
  budget.query();
  if (check.outcome === "ok") {
    // An identity this check couldn't read keeps what the last one found, as the account does.
    const kept = row?.answer?.identityConfigurationSet;
    if (!check.answer.identityConfigurationSet && kept && !config.sesConfigurationSet) {
      check.answer.identityConfigurationSet = kept;
    }
    await recordAnswer(env.DB, now, check.answer);
    log.info("provider.account_checked", {
      outcome: "ok",
      productionAccess: check.answer.productionAccess,
      maxSendRate: check.answer.maxSendRate,
      enforcement: check.answer.enforcement,
      configurationSet: check.answer.identityConfigurationSet
        ? check.answer.identityConfigurationSet.name !== null
        : undefined,
    });
    return;
  }
  await recordMiss(env.DB, now, check.outcome);
  log.info("provider.account_checked", {
    outcome: check.outcome,
    error: check.outcome === "unreachable" ? check.error : undefined,
  });
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

/** The anchor of the guide's step that routes bounces and complaints to the app. */
export const BOUNCES_DOC = { slug: "ses", anchor: "4-send-bounces-and-complaints-to-the-app" };

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

function warnings(config: Config, set: ConfigurationSetView | null): ProviderWarning[] {
  if (set?.source !== "none") {
    return [];
  }
  return [
    {
      code: "bounces_not_routed",
      severity: "warn",
      message: `Bounces and complaints won’t reach Kestrel. Mail from ${config.sendingDomain} goes out under no configuration set, so a bounced address is mailed again with every post and a complaint unsubscribes no one. Name the set in SES_CONFIGURATION_SET, or make it the sending identity’s default.`,
      docs: BOUNCES_DOC,
    },
  ];
}

/** GET /api/provider, from the deploy config and the account check's row. */
export function providerStatusView(
  config: Config,
  read: ProviderAccountRow | null,
): ProviderStatusView {
  let row = read;
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
    row = simulatedAccountRow(simulated, Date.now());
  }
  const answer = row?.answer ?? null;
  const set = configurationSet(config, answer);
  const base: ProviderStatusView = {
    ...none,
    send_rate: sesSendRate(config, answer),
    configuration_set: set,
    warnings: warnings(config, set),
  };
  if (!answer) {
    const reason = !row
      ? "not_checked"
      : row.outcome === "permission"
        ? "permission"
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
