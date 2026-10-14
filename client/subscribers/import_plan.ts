// Reading an import's plan, or its result, for the publisher (SPEC §7): a line per outcome
// that applies, in the server's counts, with the rows kept back by this list's own record
// set apart so nobody reads them as imported, the rows not imported as subscribed as a file
// to download, and the rows that came out differently from the plan on screen. The server
// decides every outcome; this only words and compares them.

import {
  type ConfirmedBreakdown,
  type ImportDifference,
  type ImportOutcome,
  type ImportRowResult,
  OPT_INS,
  type OutcomeCounts,
  toCsv,
} from "../../shared/imports";
import { optInPhrase, originName } from "./provenance";

/** One line of what an import will do, or did. `kept` lines are the list's own record winning. */
export interface OutcomeLine {
  outcome: ImportOutcome;
  count: number;
  text: string;
  kept: boolean;
}

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// Each outcome's words, after its count, in the order the publisher reads them: who joins,
// who leaves, what else the file does, what it leaves out, then what this list keeps.
const OUTCOME_WORDS: { outcome: ImportOutcome; one: string; many: string; kept?: true }[] = [
  {
    outcome: "create_confirmed",
    one: "address added as a confirmed subscriber",
    many: "addresses added as confirmed subscribers",
  },
  {
    outcome: "confirm_pending",
    one: "pending subscriber here confirmed",
    many: "pending subscribers here confirmed",
  },
  {
    outcome: "mark_unsubscribed",
    one: "subscriber here unsubscribed",
    many: "subscribers here unsubscribed",
  },
  {
    outcome: "create_unsubscribed",
    one: "address recorded as having left (unsubscribed), so the list remembers them",
    many: "addresses recorded as having left (unsubscribed), so the list remembers them",
  },
  {
    outcome: "suppression_added",
    one: "address suppressed as the file says (bounced, complained, or blocked), so it’s never mailed",
    many: "addresses suppressed as the file says (bounced, complained, or blocked), so they’re never mailed",
  },
  {
    outcome: "unchanged",
    one: "address already here as the file says, so it’s unchanged",
    many: "addresses already here as the file says, so they’re unchanged",
  },
  {
    outcome: "left_out",
    one: "row still pending, or with no status, left out, since an import sends no email",
    many: "rows still pending, or with no status, left out, since an import sends no email",
  },
  { outcome: "invalid", one: "row isn’t a valid address", many: "rows aren’t valid addresses" },
  {
    outcome: "merged",
    one: "row repeats an address earlier in the file, and is folded into it",
    many: "rows repeat an address earlier in the file, and are folded into it",
  },
  {
    outcome: "blocked_by_suppression",
    one: "address is blocked by a suppression here, so it isn’t imported",
    many: "addresses are blocked by a suppression here, so they aren’t imported",
    kept: true,
  },
  {
    outcome: "kept_unsubscribed",
    one: "reader unsubscribed here, and stays unsubscribed",
    many: "readers unsubscribed here, and stay unsubscribed",
    kept: true,
  },
  {
    outcome: "kept_confirmed_newer",
    one: "reader confirmed here after the file says they left, and stays confirmed",
    many: "readers confirmed here after the file says they left, and stay confirmed",
    kept: true,
  },
];

/** A line for each outcome with a count, in reading order. */
export function outcomeLines(counts: OutcomeCounts): OutcomeLine[] {
  return OUTCOME_WORDS.filter((w) => counts[w.outcome] > 0).map((w) => ({
    outcome: w.outcome,
    count: counts[w.outcome],
    text: plural(counts[w.outcome], w.one, w.many),
    kept: w.kept === true,
  }));
}

/** How many an import confirms. */
export function confirmedCount(counts: OutcomeCounts): number {
  return counts.create_confirmed + counts.confirm_pending;
}

/**
 * The suppressions the rows of other outcomes add too, said once beside the lines, so a row
 * that both unsubscribes and suppresses isn't counted twice. Null when there are none.
 */
export function extraSuppressionsLine(counts: OutcomeCounts, added: number): string | null {
  const extra = added - counts.suppression_added;
  return extra > 0
    ? `${plural(extra, "of the addresses above also gains", "of the addresses above also gain")} a suppression, so ${extra === 1 ? "it’s" : "they’re"} never mailed.`
    : null;
}

/**
 * Who is being confirmed, by how consent was collected and where, as the file claims it:
 * "By opt-in: 20 double, 5 unknown" and "From: Sendy 25". Each part with a count only.
 */
export function confirmedBreakdown(b: ConfirmedBreakdown): { optIn: string; origin: string } {
  const optIn = OPT_INS.filter((o) => (b.opt_in[o] ?? 0) > 0)
    .map((o) => `${b.opt_in[o].toLocaleString("en-US")} ${optInPhrase(o)}`)
    .join(", ");
  const origin = Object.entries(b.origin)
    .filter(([, n]) => n > 0)
    .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]))
    .map(([o, n]) => `${originName(o) ?? "unknown"} ${n.toLocaleString("en-US")}`)
    .join(", ");
  return { optIn, origin };
}

// What happened to one row, as the "turned out differently" table says it. A confirming row
// is named by its effect alone, since the plan's rows leave confirming rows out.
const OUTCOME_SHORT: Record<ImportOutcome, string> = {
  create_confirmed: "Imported as subscribed",
  confirm_pending: "Imported as subscribed",
  mark_unsubscribed: "Unsubscribed",
  create_unsubscribed: "Recorded as having left",
  suppression_added: "Suppressed",
  unchanged: "Unchanged",
  left_out: "Left out",
  invalid: "Invalid",
  merged: "Folded into an earlier row",
  blocked_by_suppression: "Blocked by a suppression here",
  kept_unsubscribed: "Kept unsubscribed",
  kept_confirmed_newer: "Kept confirmed",
};

/** One row whose result differs from the plan the publisher confirmed, in words. */
export interface RowDifference {
  row: number;
  email: string;
  planned: string;
  applied: string;
}

/**
 * The rows whose result differs from the plan on screen. The commit plans again, so the
 * server's `differed` only covers a change during the commit itself; a reader who left
 * between the plan and the commit shows here by comparing the two answers' rows. Both list
 * every row not imported as subscribed, so a row in one and not the other was imported as
 * subscribed on that side.
 */
export function rowDifferences(
  planned: readonly ImportRowResult[],
  applied: readonly ImportRowResult[],
  differed: readonly ImportDifference[],
): RowDifference[] {
  const before = new Map(planned.map((r) => [r.row, r]));
  const after = new Map(applied.map((r) => [r.row, r]));
  const out = new Map<number, RowDifference>();
  for (const row of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(row);
    const now = after.get(row);
    const wasText = was ? OUTCOME_SHORT[was.outcome] : OUTCOME_SHORT.create_confirmed;
    const nowText = now ? OUTCOME_SHORT[now.outcome] : OUTCOME_SHORT.create_confirmed;
    if (wasText !== nowText) {
      out.set(row, { row, email: (now ?? was)?.email ?? "", planned: wasText, applied: nowText });
    }
  }
  for (const d of differed) {
    const planned = OUTCOME_SHORT[d.planned];
    const applied = OUTCOME_SHORT[d.applied];
    if (!out.has(d.row) && planned !== applied) {
      out.set(d.row, { row: d.row, email: d.email, planned, applied });
    }
  }
  return [...out.values()].sort((a, z) => a.row - z.row);
}

/** The rows not imported as subscribed, as a CSV to check against the file: its row, the address, and what happens to it. */
export function notImportedCsv(rows: readonly ImportRowResult[]): string {
  return toCsv([
    ["row", "email", "outcome", "suppression_added"],
    ...rows.map((r) => [String(r.row), r.email, r.outcome, r.suppression_added ? "yes" : "no"]),
  ]);
}
