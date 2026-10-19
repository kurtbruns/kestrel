/**
 * Bringing a list in (SPEC §7): planning an import against the list as it stands, which
 * writes nothing, and committing a plan, all of it or none of it.
 *
 * A plan reads the file with the one parser in `shared/imports.ts`, folds each address's
 * repeats together, and classifies every row against the list, so the outcome of each is
 * decided here once and both clients only show it. Its hash covers what the publisher's
 * consent to the commit rests on (the file, its declared meaning, whether an attestation is
 * needed, and the scheduled sends it would grow), and is the commit's idempotency key.
 * A commit plans again, refuses a plan that no longer hashes the same, and applies the
 * plan in one batch (`db/imports.ts`) whose every write re-checks the list as it stands,
 * so the list moving in between is applied safely and reported, never refused.
 */

import { freePlanImportAdvice, pastFreePlanList } from "../../shared/free_plan";
import {
  ATTESTATION,
  attestationText,
  CONFIRMING_OUTCOMES,
  type ConfirmedBreakdown,
  EXPORT_PAGE_ROWS,
  type GrowingSend,
  IMPORT_LIMITS,
  IMPORT_OUTCOMES,
  type ImportCommitResponse,
  type ImportDifference,
  type ImportFileError,
  type ImportFileKind,
  type ImportOutcome,
  type ImportPlanResponse,
  type ImportRecord,
  type ImportRow,
  type ImportRowResult,
  type MergedImport,
  mergeRows,
  type OutcomeCounts,
  type PlainListStatus,
  parseImportFile,
} from "../../shared/imports";
import { strongerCause } from "../../shared/subscribers";
import { deliveriesNaming, forgetDeliveries, handingOff } from "../db/erasure";
import type { ListEntry, ListState } from "../db/imports";
import * as imports from "../db/imports";
import { countSubscribers } from "../db/subscribers";
import { onFreePlanLimits } from "../env";
import { HttpError, refusal } from "../lib/errors";
import { newId, newTokens } from "../lib/ids";
import { errorText, log } from "../lib/log";
import type { Principal } from "../router";

/** A file to import, as a request carries it. */
export interface ImportInput {
  name: string;
  text: string;
  /** A plain list's declared meaning; null for a CSV. */
  plainListStatus: PlainListStatus | null;
}

/** One address's place in a plan: its merged row and what the import does to it. */
export interface PlannedRow {
  row: ImportRow;
  outcome: ImportOutcome;
  suppressionAdded: boolean;
}

/** A plan, with everything the commit needs to apply it. */
export interface Plan {
  input: ImportInput;
  kind: ImportFileKind;
  fileSha256: string;
  rowCount: number;
  merged: MergedImport;
  planned: PlannedRow[];
  counts: OutcomeCounts;
  suppressionsAdded: number;
  confirmed: ConfirmedBreakdown;
  sendsGrowing: GrowingSend[];
  attestation: { version: number; text: string; publication: string } | null;
  planHash: string;
  /** The advice to move to Workers Paid, on Workers Free's limits only, when the import leaves the list past what Free suits (SPEC §7). */
  workersPlanAdvice: string | null;
}

/**
 * The most rows one import takes on this deployment: the format's limit, or less on Workers
 * Free, judged as the send budget is (`SUBREQUEST_BUDGET` left at the Free plan's), since
 * 10 ms of CPU per request can't read and apply the full limit.
 */
export function maxImportRows(subrequestBudget: number): {
  maxRows: number;
  reason: string | null;
} {
  return onFreePlanLimits({ subrequestBudget })
    ? {
        maxRows: IMPORT_LIMITS.maxRowsFree,
        // Said to the publisher, who may never have seen Cloudflare: the setting behind it
        // is the operator's, in the API reference and Bring your existing list's file format.
        reason: `That’s the limit on Cloudflare’s Workers Free plan. Whoever runs your Kestrel can raise it to ${IMPORT_LIMITS.maxRows.toLocaleString("en-US")} rows by moving to Workers Paid.`,
      }
    : { maxRows: IMPORT_LIMITS.maxRows, reason: null };
}

/** Rows per page of the export, judged from the plan as the import limit is. */
export function exportPageRows(subrequestBudget: number): number {
  return onFreePlanLimits({ subrequestBudget }) ? EXPORT_PAGE_ROWS.free : EXPORT_PAGE_ROWS.paid;
}

function emptyCounts(): OutcomeCounts {
  return Object.fromEntries(IMPORT_OUTCOMES.map((o) => [o, 0])) as OutcomeCounts;
}

const WRITE_OUTCOMES: ReadonlySet<ImportOutcome> = new Set([
  "added_confirmed",
  "confirmed_pending",
  "unsubscribed",
  "erased",
  "added_unsubscribed",
]);

/**
 * What an import does to one address (SPEC §7), from its merged row and the address's
 * subscriber and suppression reason here. Only `subscribed` confirms, and never past an
 * unsubscribe or a suppression here; leaving and suppressions apply whatever the row's status.
 *
 * A pending subscriber who once left counts as unsubscribed: anyone can put an address back
 * to pending through the public form, so only its owner's confirmation undoes the leaving
 * (I2). Someone already unsubscribed here takes the row's cause only when it is the stronger
 * (an erasure over a complaint over the rest), as when a person leaves again. Someone here the
 * row unsubscribes by an erasure is `erased`, since it erases them as Erase does. A suppression
 * here stands: the first one an address gets is the one it keeps.
 */
export function classify(
  row: ImportRow,
  here: ListEntry | undefined,
  suppressionHere: string | undefined,
): { outcome: ImportOutcome; suppressionAdded: boolean } {
  const suppressionAdded = row.suppression !== null && suppressionHere === undefined;
  const leftHere =
    here?.status === "unsubscribed" ||
    (here?.status === "pending" && here.unsubscribed_at !== null);
  let outcome: ImportOutcome;
  if (row.status === "subscribed") {
    outcome =
      suppressionHere !== undefined
        ? "kept_suppressed"
        : here === undefined
          ? "added_confirmed"
          : leftHere
            ? "kept_unsubscribed"
            : here.status === "pending"
              ? "confirmed_pending"
              : "unchanged";
  } else if (row.status === "unsubscribed") {
    // Only a confirmation recorded here can be newer than the source's unsubscribe: an
    // imported one is the source's own word.
    const confirmedHereSince =
      here?.status === "confirmed" &&
      here.import_id === null &&
      row.unsubscribed_at !== null &&
      (here.confirmed_at ?? 0) > row.unsubscribed_at;
    outcome =
      here === undefined
        ? "added_unsubscribed"
        : here.status === "unsubscribed"
          ? causeReplaces(here, row)
            ? "unsubscribed"
            : "unchanged"
          : confirmedHereSince
            ? "kept_confirmed_newer"
            : "unsubscribed";
  } else {
    outcome = "left_out";
  }
  // An erasure that unsubscribes someone here erases them, which the plan names apart.
  if (outcome === "unsubscribed" && row.unsubscribe_cause === "erased") {
    outcome = "erased";
  }
  if (suppressionAdded && (outcome === "unchanged" || outcome === "left_out")) {
    outcome = "suppressed";
  }
  return { outcome, suppressionAdded };
}

/** Whether an unsubscribed row's cause is stronger than the one a subscriber who already left
 *  here holds, and so replaces it (SPEC §7). */
function causeReplaces(here: ListEntry, row: ImportRow): boolean {
  const held = here.unsubscribe_cause ?? "import";
  const next = row.unsubscribe_cause ?? "import";
  return strongerCause(held, next) !== held;
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The file's own fingerprint: the SHA-256 of its text as UTF-8. */
export function fileSha256(text: string): Promise<string> {
  return sha256Hex(text);
}

/** A 400 a client fixes by changing the file, with what was wrong and where. */
function fileRefusal(error: ImportFileError): HttpError {
  const { code, message, ...at } = error;
  return new HttpError(code, message, { field: "file", ...at });
}

/**
 * Plan an import: read the file, fold repeats, and classify every row against the list as it
 * stands. Writes nothing. Refuses a file not in the format, or with more rows than `maxRows`.
 */
export async function planImport(
  db: D1Database,
  input: ImportInput,
  {
    maxRows,
    maxRowsReason,
    publication,
    freePlan = false,
  }: {
    maxRows: number;
    maxRowsReason: string | null;
    /** The publication as the attestation names it (`attestationPublication`). */
    publication: string;
    /** On Workers Free's limits: the plan then advises Workers Paid when it leaves the list past what Free suits. */
    freePlan?: boolean;
  },
): Promise<Plan> {
  const tooMany = (rows: string) =>
    new HttpError(
      "too_many_rows",
      `The file has ${rows} rows; one import takes at most ${maxRows.toLocaleString("en-US")}.${maxRowsReason ? ` ${maxRowsReason}` : ""} Split it into files of up to ${maxRows.toLocaleString("en-US")} rows.`,
      { field: "file", limit: maxRows },
    );
  // A file far over the limit is refused on its line count, before the parse whose CPU would
  // run past a Workers Free request's limit and leave the publisher with no refusal at all.
  // Only far over: a quoted value may hold a line break, so a line isn't always a row.
  let lines = 1;
  for (let at = input.text.indexOf("\n"); at !== -1; at = input.text.indexOf("\n", at + 1)) {
    lines += 1;
  }
  if (lines > 2 * (maxRows + 1)) {
    throw tooMany(`about ${lines.toLocaleString("en-US")}`);
  }
  const parsed = parseImportFile(
    { name: input.name, text: input.text },
    input.plainListStatus ?? "subscribed",
  );
  if (!parsed.ok) {
    throw fileRefusal(parsed.error);
  }
  const { kind, rows } = parsed.file;
  if (kind === "csv" && input.plainListStatus !== null) {
    throw new HttpError(
      "bad_request",
      "plain_list_status is for a plain list (.txt); a CSV says each row’s status itself",
      { field: "plain_list_status" },
    );
  }
  if (rows.length > maxRows) {
    throw tooMany(rows.length.toLocaleString("en-US"));
  }
  const merged = mergeRows(rows);
  const state = await imports.readListState(
    db,
    merged.rows.map((r) => r.email),
  );
  const planned = merged.rows.map((row) => ({
    row,
    ...classify(row, state.subscribers.get(row.email), state.suppressions.get(row.email)),
  }));
  const counts = emptyCounts();
  const confirmed: ConfirmedBreakdown = {
    opt_in: { double: 0, single: 0, unknown: 0 },
    origin: {},
  };
  let suppressionsAdded = 0;
  let gains = 0;
  // Confirmed subscribers this import unsubscribes, which leave the confirmed list.
  let leaving = 0;
  for (const p of planned) {
    counts[p.outcome] += 1;
    if (
      p.outcome === "unsubscribed" &&
      state.subscribers.get(p.row.email)?.status === "confirmed"
    ) {
      leaving += 1;
    }
    suppressionsAdded += p.suppressionAdded ? 1 : 0;
    if (CONFIRMING_OUTCOMES.has(p.outcome)) {
      confirmed.opt_in[p.row.opt_in] += 1;
      confirmed.origin[p.row.origin] = (confirmed.origin[p.row.origin] ?? 0) + 1;
      // A row bringing its own suppression is confirmed but never in an audience.
      gains += p.row.suppression === null ? 1 : 0;
    }
  }
  counts.merged = merged.repeats.length;
  counts.invalid = merged.invalid.length;

  const sendsGrowing =
    gains === 0 ? [] : (await imports.scheduledSends(db)).map((s) => ({ ...s, gains }));
  // The import committed last, so a plan made before another import landed can't be
  // committed after it, and the same file planned again against a list that has moved since
  // its first import is a new plan rather than a replay of that one.
  const after = await imports.latestImportId(db);
  const needsAttestation = counts.added_confirmed + counts.confirmed_pending > 0;
  const sha = await fileSha256(input.text);
  // Read only on Free, where it can advise; advice never changes what the commit applies,
  // so it stays out of the hash.
  const confirmedAfter = freePlan
    ? (await countSubscribers(db, { status: "confirmed" })) +
      counts.added_confirmed +
      counts.confirmed_pending -
      leaving
    : 0;
  const planHash = await sha256Hex(
    JSON.stringify([
      "kestrel-import-plan/1",
      kind,
      sha,
      input.plainListStatus,
      needsAttestation,
      sendsGrowing.map((s) => s.id).sort(),
      after,
    ]),
  );
  return {
    input,
    kind,
    fileSha256: sha,
    rowCount: rows.length,
    merged,
    planned,
    counts,
    suppressionsAdded,
    confirmed,
    sendsGrowing,
    attestation: needsAttestation
      ? { version: ATTESTATION.version, text: attestationText(publication), publication }
      : null,
    planHash,
    workersPlanAdvice:
      freePlan && pastFreePlanList(confirmedAfter) ? freePlanImportAdvice(confirmedAfter) : null,
  };
}

/** The rows that won't be confirmed, in file order: every outcome but the confirming ones. */
function notConfirmedRows(
  planned: { row: ImportRow; outcome: ImportOutcome; suppressionAdded: boolean }[],
  merged: MergedImport,
): ImportRowResult[] {
  const out: ImportRowResult[] = [];
  for (const p of planned) {
    if (!CONFIRMING_OUTCOMES.has(p.outcome)) {
      out.push({
        row: p.row.row,
        email: p.row.email,
        outcome: p.outcome,
        suppression_added: p.suppressionAdded,
      });
    }
  }
  for (const r of merged.repeats) {
    out.push({ row: r.row, email: r.email, outcome: "merged", suppression_added: false });
  }
  for (const r of merged.invalid) {
    out.push({ row: r.row, email: r.email, outcome: "invalid", suppression_added: false });
  }
  return out.sort((a, b) => a.row - b.row);
}

/** The plan as the plan route answers it. */
export function planResponse(plan: Plan): ImportPlanResponse {
  return {
    file: {
      name: plan.input.name,
      kind: plan.kind,
      rows: plan.rowCount,
      addresses: plan.merged.rows.length,
      plain_list_status: plan.input.plainListStatus,
    },
    counts: plan.counts,
    suppressions_added: plan.suppressionsAdded,
    confirmed: plan.confirmed,
    rows: notConfirmedRows(plan.planned, plan.merged),
    sends_growing: plan.sendsGrowing,
    attestation: plan.attestation,
    plan_hash: plan.planHash,
    workers_plan_advice: plan.workersPlanAdvice,
  };
}

// A file's suppression claim as the suppression it becomes here: an imported bounce is kept
// apart from one this instance saw.
const SUPPRESSION_REASON = {
  bounce: "import_bounce",
  manual: "manual",
} as const;

/** The answer to a commit replayed after the first was applied: the record, nothing written now. */
export function replayResponse(record: ImportRecord): ImportCommitResponse {
  return {
    import: record,
    counts: record.counts,
    suppressions_added: record.suppressions_added,
    rows: [],
    differed: [],
    replayed: true,
  };
}

/**
 * Apply a plan: one atomic batch, every write guarded against the list as it stands. A row
 * whose planned write the list no longer allowed (a reader who unsubscribed, an address
 * suppressed, since the plan was made) is applied as it now stands and reported in
 * `differed`. A second commit of the same plan, racing this one, finds this one's record.
 */
export async function commitImport(
  db: D1Database,
  plan: Plan,
  principal: Principal,
  now: number,
): Promise<ImportCommitResponse> {
  const id = newId();
  const writes: imports.ImportWrites = {
    record: {
      id,
      created_at: now,
      principal_kind: principal.kind,
      principal_email: principal.kind === "human" ? (principal.email ?? "").toLowerCase() : null,
      attestation_version: plan.attestation ? plan.attestation.version : null,
      file_name: plan.input.name,
      file_sha256: plan.fileSha256,
      plan_hash: plan.planHash,
      counts: plan.counts,
      suppressions_added: plan.suppressionsAdded,
    },
    unsubscribe: [],
    addUnsubscribed: [],
    confirm: [],
    addConfirmed: [],
    suppress: [],
    erase: [],
    notice: principal.kind === "service",
  };
  const tokens = newTokens(plan.counts.added_confirmed + plan.counts.added_unsubscribed);
  const token = (): string => tokens.pop() ?? "";
  for (const { row, outcome, suppressionAdded } of plan.planned) {
    const consent = {
      e: row.email,
      opt: row.opt_in,
      org: row.origin,
      ev: row.evidence,
      cat: row.confirmed_at ?? row.subscribed_at,
    };
    if (outcome === "added_confirmed") {
      writes.addConfirmed.push({ ...consent, id: newId(), tok: token(), uat: null });
    } else if (outcome === "confirmed_pending") {
      writes.confirm.push(consent);
    } else if (
      outcome === "unsubscribed" ||
      outcome === "erased" ||
      outcome === "added_unsubscribed"
    ) {
      // An added one in the unsubscribe too, so an address that subscribed here since the plan
      // still leaves.
      const cause = row.unsubscribe_cause ?? "import";
      writes.unsubscribe.push({ e: row.email, uat: row.unsubscribed_at, c: cause });
      if (outcome === "added_unsubscribed") {
        // An erasure is recorded with its address alone, whatever else the file says (SPEC §7).
        const ids = { id: newId(), tok: token(), uat: row.unsubscribed_at, c: cause };
        writes.addUnsubscribed.push(
          cause === "erased"
            ? { ...ids, tok: null, e: row.email, opt: null, org: null, ev: null, cat: null }
            : { ...ids, ...consent, cat: row.confirmed_at },
        );
      }
      if (cause === "erased") {
        writes.erase.push(row.email);
      }
    }
    if (suppressionAdded && row.suppression !== null) {
      writes.suppress.push({
        e: row.email,
        r: SUPPRESSION_REASON[row.suppression],
        at: row.suppressed_at,
      });
    }
  }

  // Whoever the import erases loses their address on past sends here too, as with Erase, and
  // like Erase the commit waits while a send run is handing one of them to the provider.
  if ((await handingOff(db, writes.erase, now)).length > 0) {
    throw refusal(
      "run_in_progress",
      "A send is handing someone this import would erase to the email provider right now, so it can’t be committed this moment. Try again in a minute.",
    );
  }
  const forget = await forgetDeliveries(db, writes.erase, now);

  let applied: imports.AppliedWrites;
  try {
    applied = await imports.applyImport(db, writes, `imported from ${plan.input.name}`, [
      ...forget.rewrite,
      ...forget.move,
    ]);
  } catch (err) {
    // Another commit of this plan got there first: its batch wrote the record, this one
    // wrote nothing.
    const raced = await imports.getImportByPlanHash(db, plan.planHash);
    if (raced) {
      return replayResponse(raced);
    }
    throw err;
  }
  // From here the import is written: nothing below may fail the commit, or a retry would
  // read as a replay of a commit that answered nothing.

  // A run that took its lease between the check and the batch held back an erased person's
  // delivery rows: say so, since Erase on them finishes the job.
  if (writes.erase.length > 0) {
    try {
      const left = await deliveriesNaming(db, writes.erase);
      if (left > 0) {
        log.error("import.incomplete", { importId: id, step: "erase", deliveries: left });
      }
    } catch (err) {
      log.error("import.incomplete", { importId: id, step: "erase", error: errorText(err) });
    }
  }

  // What each row's writes actually did, against what the plan meant them to.
  const actual: PlannedRow[] = [];
  const unsettled: PlannedRow[] = [];
  for (const p of plan.planned) {
    const e = p.row.email;
    const outcome: ImportOutcome | undefined = applied.confirmed.has(e)
      ? "confirmed_pending"
      : applied.addedConfirmed.has(e)
        ? "added_confirmed"
        : applied.unsubscribed.has(e)
          ? p.row.unsubscribe_cause === "erased"
            ? "erased"
            : "unsubscribed"
          : applied.addedUnsubscribed.has(e)
            ? "added_unsubscribed"
            : WRITE_OUTCOMES.has(p.outcome)
              ? undefined
              : p.outcome;
    const suppressionAdded = applied.suppressed.has(e);
    if (outcome === undefined || (p.outcome === "suppressed" && !suppressionAdded)) {
      unsettled.push({ ...p, suppressionAdded });
      continue;
    }
    actual.push({ ...p, outcome, suppressionAdded });
  }
  // A planned write the list held back: read the address as it now stands, setting aside a
  // suppression this import itself just added, and say what that means for it.
  if (unsettled.length > 0) {
    let state: ListState = { subscribers: new Map(), suppressions: new Map() };
    try {
      state = await imports.readListState(
        db,
        unsettled.map((p) => p.row.email),
      );
    } catch (err) {
      log.error("import.incomplete", { importId: id, step: "reread", error: errorText(err) });
    }
    for (const p of unsettled) {
      const e = p.row.email;
      const { outcome } = classify(
        { ...p.row, suppression: null },
        state.subscribers.get(e),
        applied.suppressed.has(e) ? undefined : state.suppressions.get(e),
      );
      // The guard held the write back, so whatever the list would allow now did not happen.
      actual.push({ ...p, outcome: WRITE_OUTCOMES.has(outcome) ? "unchanged" : outcome });
    }
  }

  const counts = emptyCounts();
  let suppressionsAdded = 0;
  for (const p of actual) {
    counts[p.outcome] += 1;
    suppressionsAdded += p.suppressionAdded ? 1 : 0;
  }
  counts.merged = plan.counts.merged;
  counts.invalid = plan.counts.invalid;

  const byEmail = new Map(plan.planned.map((p) => [p.row.email, p]));
  const differed: ImportDifference[] = [];
  for (const p of actual) {
    const was = byEmail.get(p.row.email);
    if (was && (was.outcome !== p.outcome || was.suppressionAdded !== p.suppressionAdded)) {
      differed.push({
        row: p.row.row,
        email: p.row.email,
        planned: was.outcome,
        applied: p.outcome,
      });
    }
  }
  differed.sort((a, b) => a.row - b.row);
  if (differed.length > 0) {
    try {
      await imports.setImportCounts(db, id, counts, suppressionsAdded);
    } catch (err) {
      // The record keeps the planned counts; the answer still says what was applied.
      log.error("import.incomplete", { importId: id, step: "counts", error: errorText(err) });
    }
  }

  return {
    import: {
      id,
      created_at: now,
      principal: { kind: writes.record.principal_kind, email: writes.record.principal_email },
      attestation_version: writes.record.attestation_version,
      file_name: writes.record.file_name,
      file_sha256: writes.record.file_sha256,
      plan_hash: writes.record.plan_hash,
      counts,
      suppressions_added: suppressionsAdded,
    },
    counts,
    suppressions_added: suppressionsAdded,
    rows: notConfirmedRows(actual, plan.merged),
    differed,
    replayed: false,
  };
}

/** The 409 for a commit whose plan no longer hashes the same. */
export function planStale(): HttpError {
  return refusal(
    "plan_stale",
    "The import would no longer do what its plan said: the file, its declared meaning, whether an attestation is needed, or the scheduled sends it would grow have changed, or another import was committed since. Plan it again and review the new plan.",
  );
}
