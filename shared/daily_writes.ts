// D1's daily writes on the Workers Free plan's limits (SPEC §7, §8): the budget a day's imports
// and sends are held to before the app warns, what each costs, and the UTC day they share.
// D1's free plan refuses every query once a day's 100,000 written rows are spent, until
// midnight UTC, which stops the whole newsletter. The costs are measured, and the specs that
// measure them (`test/send_d1_cost.spec.ts`, `test/import_d1_cost.spec.ts`) fail when a change
// moves them, so an estimate here can't drift from what D1 reports. Pure and dependency-free.

/** D1's free plan's written rows a day. */
export const D1_FREE_DAILY_WRITES = 100_000;

/**
 * The written rows a day's imports and a send may plan to use before the app warns. The rest
 * is headroom for what isn't planned: signups, unsubscribes, the editor's saves, and
 * receipts that arrive after the day a send went out.
 */
export const DAILY_WRITES_BUDGET = 70_000;

/** Rows a send writes per recipient, receipts included. */
export const SEND_WRITES_PER_RECIPIENT = 14;

/**
 * Rows an import writes, by what it does: a new subscriber (confirmed or unsubscribed), a
 * pending one confirmed, a confirmed one unsubscribed, any suppression added, the import's
 * own record, and, for an import Claude commits, the notice telling the publisher. Two small
 * writes are left out, each at most a row or two: a suppression that replaces an erased
 * marker (an update, counted here as a new one, so over), and on Workers Free's limits the
 * restamp of the day's scheduled sends, a row or two for each.
 */
export const IMPORT_WRITES = {
  created: 7,
  confirmed: 3,
  unsubscribed: 2,
  suppression: 2,
  record: 3,
  notice: 4,
} as const;

/** The rows an import writes, from its counts by outcome, the suppressions it adds, and whether Claude committed it. */
export function importWrites(
  counts: {
    create_confirmed: number;
    create_unsubscribed: number;
    confirm_pending: number;
    mark_unsubscribed: number;
  },
  suppressionsAdded: number,
  byService: boolean,
): number {
  return (
    IMPORT_WRITES.created * (counts.create_confirmed + counts.create_unsubscribed) +
    IMPORT_WRITES.confirmed * counts.confirm_pending +
    IMPORT_WRITES.unsubscribed * counts.mark_unsubscribed +
    IMPORT_WRITES.suppression * suppressionsAdded +
    IMPORT_WRITES.record +
    (byService ? IMPORT_WRITES.notice : 0)
  );
}

const DAY_MS = 86_400_000;

/** When the UTC day holding `at` began, the moment D1's daily allowance last reset. */
export function utcDayStart(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/** The next midnight UTC after `at`, when D1's daily allowance resets. */
export function nextUtcMidnight(at: number): number {
  return utcDayStart(at) + DAY_MS;
}

/** The UTC day so far, on Workers Free's limits: what its imports wrote, and when it ends. */
export interface WritesDay {
  importWrites: number;
  /** The next midnight UTC, when D1's allowance resets. */
  until: number;
}

/** `WritesDay` for the day holding `now`, from the imports committed since it began. */
export function writesDay(now: number, importWritesToday: number): WritesDay {
  return { importWrites: importWritesToday, until: nextUtcMidnight(now) };
}

/** A share of D1's daily writes as a whole percentage, for the warnings' words. */
export function dailyWritesPercent(rows: number): number {
  return Math.round((rows / D1_FREE_DAILY_WRITES) * 100);
}
