/**
 * The SES account a local server stands in for (`SIMULATE_ACCOUNT`, SPEC §10): the row the
 * account check would leave in each simulated state, read in place of the stored one. Pure: it
 * reads the simulation's view and the config, never the database, so the editor's provider
 * status and the simulated sandbox's refusals read the same account.
 */

import type { SimulatedAccountView } from "../../../shared/settings";
import type { AccountAnswer, ProviderAccountRow } from "../../db/provider_account";
import type { Config } from "../../env";

/** SES's sandbox limits, and a common starting production quota, for the simulated account. */
const SANDBOX_ACCOUNT = { maxSendRate: 1, max24HourSend: 200 } as const;
const PRODUCTION_ACCOUNT = { maxSendRate: 14, max24HourSend: 50_000 } as const;

/**
 * The account check's row as SES would leave it in the simulated state (SPEC §10). It changes
 * what the editor shows of the account, not how a simulated send goes out: the `ses` profile
 * keeps its own pace. A simulated problem is the reading the real check would make of it
 * (SPEC §13), so each warning can be seen locally: a rejected key keeps the last answer, as a
 * real one does. Routing, reports, and a problem are independent, so each is read on its own.
 */
export function simulatedAccountRow(
  account: SimulatedAccountView,
  config: Pick<Config, "sesConfigurationSet">,
  now: number,
): ProviderAccountRow {
  if (account.state === "permission") {
    return { attemptedAt: now, outcome: "permission", checkedAt: null, answer: null };
  }
  const production = account.state === "production";
  const limits = production ? PRODUCTION_ACCOUNT : SANDBOX_ACCOUNT;
  const problem = account.problem;
  const identitySet = account.bounces_routed ? "kestrel-mail" : null;
  const setName = config.sesConfigurationSet ?? identitySet;
  const answer: AccountAnswer = {
    productionAccess: production,
    review: production
      ? "granted"
      : account.state === "pending" || account.state === "denied"
        ? account.state
        : null,
    reviewCase: account.state === "denied" ? "1234567890" : null,
    maxSendRate: limits.maxSendRate,
    max24HourSend: limits.max24HourSend,
    sentLast24Hours: 0,
    enforcement:
      problem === "shutdown" ? "shutdown" : problem === "probation" ? "probation" : "healthy",
    sendingEnabled: problem !== "sending_disabled",
    identityConfigurationSet: { name: identitySet },
    senderVerified: problem !== "sender_unverified",
  };
  if (setName) {
    answer.configurationSet = {
      name: setName,
      exists: problem !== "set_missing",
      sendingEnabled: problem !== "set_paused" && problem !== "set_missing",
    };
  }
  return {
    attemptedAt: now,
    outcome: problem === "key_rejected" ? "rejected" : "ok",
    checkedAt: now,
    answer,
  };
}
