// The line Kestrel draws on the Workers Free plan's limits (SPEC §7, §8), stated as a pair:
// Free suits a list of up to about 1,000 subscribers, and past about 5,000 one send alone can
// spend D1's 100,000 written rows a day, which stops the whole newsletter until midnight UTC.
// Every warning about the plan says it in these words, so the app, the API, and the docs
// agree. Kestrel judges the plan from its config, never by asking Cloudflare. Pure and
// dependency-free.

/** D1's free plan's written rows a day. */
export const D1_FREE_DAILY_WRITES = 100_000;

/**
 * Rows a send writes per recipient, receipts included, as `test/send_d1_cost.spec.ts`
 * measures it (14.1), which fails when a change raises it.
 */
export const SEND_WRITES_PER_RECIPIENT = 14;

/**
 * The confirmed list Workers Free suits. At 1,000 a whole list fits one Free import, and an
 * import and two sends on one UTC day use about a third of D1's daily writes, so no day's
 * mix of them can run out. Past it, the app advises Workers Paid on the list and on an
 * import plan, and counts nothing to do so.
 */
export const FREE_PLAN_LIST = 1_000;

/**
 * A scheduled send to more than this many recipients may spend D1's daily writes on its own:
 * 70% of them at the measured cost, the rest being headroom for what isn't the send.
 */
export const DAILY_WRITES_SEND_RECIPIENTS = Math.floor(
  (D1_FREE_DAILY_WRITES * 7) / 10 / SEND_WRITES_PER_RECIPIENT,
);

/** Whether a send to `recipients` may spend D1's daily writes on Workers Free's limits. */
export function sendSpendsDailyWrites(recipients: number): boolean {
  return recipients > DAILY_WRITES_SEND_RECIPIENTS;
}

/** The pair, as the advice on a list past what Free suits says it. */
export const FREE_PLAN_LINE = `Workers Free suits a list of up to about ${FREE_PLAN_LIST.toLocaleString("en-US")} subscribers. Past about ${DAILY_WRITES_SEND_RECIPIENTS.toLocaleString("en-US")}, one send can use up the day’s database writes and stop this newsletter until midnight UTC.`;

/** The way out, as every warning about the plan ends. Kestrel can't see the account's plan, only its config. */
export const FREE_PLAN_FIX =
  "Move to Workers Paid, or, if the account is on it already, set SUBREQUEST_BUDGET to 10000.";

/** Whether a confirmed list of `confirmed` is past what Workers Free suits. */
export function pastFreePlanList(confirmed: number): boolean {
  return confirmed > FREE_PLAN_LIST;
}

/** The standing notice on the list, on Workers Free's limits, once it is past what Free suits. */
export function freePlanListNotice(confirmed: number): string {
  return `This list has ${confirmed.toLocaleString("en-US")} confirmed subscribers, on the Workers Free plan’s limits. ${FREE_PLAN_LINE} ${FREE_PLAN_FIX}`;
}

/** An import plan's advice, on Workers Free's limits, when it leaves the list past what Free suits. */
export function freePlanImportAdvice(confirmedAfter: number): string {
  return `On the Workers Free plan’s limits, this import leaves ${confirmedAfter.toLocaleString("en-US")} confirmed subscribers. ${FREE_PLAN_LINE} ${FREE_PLAN_FIX}`;
}

/** The `daily_writes` condition's words, for a scheduled send to `recipients`. */
export function dailyWritesSendWarning(recipients: number): string {
  return `On the Workers Free plan’s limits, a send to ${recipients.toLocaleString("en-US")} recipients may use up the day’s database writes and stop this newsletter until midnight UTC, the send included. Workers Free suits a list of up to about ${FREE_PLAN_LIST.toLocaleString("en-US")} subscribers. ${FREE_PLAN_FIX}`;
}
