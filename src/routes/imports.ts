/**
 * Authed import and export routes (SPEC §7): the format and its templates, a plan that
 * writes nothing, the commit that applies a plan whole, and the whole list out a page at a time.
 *
 * The rules of consent at the commit live here, where the principal is known: a plan that
 * confirms anyone needs the publisher's attestation, a plan that grows a scheduled send
 * needs a person in the editor to acknowledge each one (a service token can't, nor a person
 * through any other client, named or not: SPEC §11, Who acted), and the plan the commit
 * applies must hash the same as the one the publisher saw.
 */

import {
  ATTESTATION,
  attestationPublication,
  describeFormat,
  EXAMPLE_CSV_NAME,
  EXAMPLE_TXT_NAME,
  type ExportResponse,
  type ExportRow,
  fileKindOf,
  IMPORT_FORMAT,
  IMPORT_LIMITS,
  type ImportRecordResponse,
  type ImportStatus,
  PLAIN_LIST_STATUSES,
  type SuppressionClaim,
  TEMPLATE_CSV,
  TEMPLATE_TXT,
  type UnsubscribeCauseClaim,
} from "../../shared/imports";
import { EDITOR_CLIENT } from "../../shared/who_acted";
import * as imports from "../db/imports";
import { getSettings } from "../db/settings";
import { onFreePlanLimits } from "../env";
import {
  fieldError,
  type JsonObject,
  oneOf,
  optObject,
  optString,
  optStringList,
  readJsonObject,
} from "../lib/body";
import { badRequest, HttpError, json, notFound, refusal } from "../lib/errors";
import { log, whoActed } from "../lib/log";
import { decodePageCursor, encodePageCursor } from "../lib/page_cursor";
import { param, type RequestContext } from "../router";
import {
  commitImport,
  exportPageRows,
  fileSha256,
  type ImportInput,
  maxImportRows,
  type Plan,
  planImport,
  planResponse,
  planStale,
  replayResponse,
} from "../services/imports";

/** GET /api/imports/format */
export function format(c: RequestContext): Response {
  const { maxRows, reason } = maxImportRows(c.config.subrequestBudget);
  return json(describeFormat(maxRows, reason));
}

function download(body: string, type: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "content-type": `${type}; charset=utf-8`,
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

/** GET /api/imports/template.csv */
export function templateCsv(): Response {
  return download(TEMPLATE_CSV, "text/csv", EXAMPLE_CSV_NAME);
}

/** GET /api/imports/template.txt */
export function templateTxt(): Response {
  return download(TEMPLATE_TXT, "text/plain", EXAMPLE_TXT_NAME);
}

/** Refuse a body over the limit before reading it, when it says its length. */
function refuseOversize(c: RequestContext, bytes?: number): void {
  const declared = Number(c.req.headers.get("content-length") ?? "0");
  if ((bytes ?? declared) > IMPORT_LIMITS.maxBodyBytes) {
    throw new HttpError(
      "body_too_large",
      `The request is over ${IMPORT_LIMITS.maxBodyBytes / (1024 * 1024)} MB. Split the file into smaller imports.`,
    );
  }
}

/** The file and its declared meaning, as the plan and the commit both take them. */
function readInput(body: JsonObject): ImportInput {
  const file = optObject(body, "file");
  if (!file) {
    throw fieldError("file", "file is required, as { name, text }");
  }
  const name = optString(file, "name", "file");
  if (!name) {
    throw fieldError("file.name", "file.name is required: the file’s name, ending .csv or .txt");
  }
  const text = optString(file, "text", "file");
  if (text === undefined) {
    throw fieldError("file.text", "file.text is required: the file’s contents as UTF-8 text");
  }
  const declared =
    body.plain_list_status === undefined
      ? null
      : oneOf(body, "plain_list_status", PLAIN_LIST_STATUSES);
  // A plain list means `subscribed` unless it says otherwise, so it plans and hashes the same
  // whether the default is sent or left out.
  return {
    name,
    text,
    plainListStatus: declared ?? (fileKindOf(name) === "txt" ? "subscribed" : null),
  };
}

async function plan(c: RequestContext, input: ImportInput): Promise<Plan> {
  if (new TextEncoder().encode(input.text).length > IMPORT_LIMITS.maxBodyBytes) {
    refuseOversize(c, IMPORT_LIMITS.maxBodyBytes + 1);
  }
  const { maxRows, reason } = maxImportRows(c.config.subrequestBudget);
  const settings = await getSettings(c.env.DB);
  return planImport(c.env.DB, input, {
    maxRows,
    maxRowsReason: reason,
    publication: attestationPublication(settings.publication.name, c.config.fromAddress),
    freePlan: onFreePlanLimits(c.config),
  });
}

/** POST /api/imports/plan */
export async function planRoute(c: RequestContext): Promise<Response> {
  refuseOversize(c);
  const input = readInput(await readJsonObject(c));
  return json(planResponse(await plan(c, input)));
}

/** POST /api/imports */
export async function commit(c: RequestContext): Promise<Response> {
  refuseOversize(c);
  const body = await readJsonObject(c);
  const input = readInput(body);
  const planHash = optString(body, "plan_hash");
  if (!planHash) {
    throw fieldError("plan_hash", "plan_hash is required: the hash of the plan being committed");
  }
  const attestation = optObject(body, "attestation");
  if (attestation && (typeof attestation.version !== "number" || attestation.accepted !== true)) {
    throw fieldError(
      "attestation",
      "attestation must be { version, accepted: true }, with the version the plan returned",
    );
  }
  const acknowledged = new Set(optStringList(body, "acknowledge_sends") ?? []);
  const principal = c.principal;
  if (!principal) {
    throw badRequest("no principal");
  }

  // A commit replayed after a lost answer: the import already made from this plan and file.
  const done = await imports.getImportByPlanHash(c.env.DB, planHash);
  if (done && done.file_sha256 === (await fileSha256(input.text))) {
    return json(replayResponse(done));
  }

  const p = await plan(c, input);
  if (p.planHash !== planHash) {
    throw planStale();
  }
  if (
    p.attestation &&
    !(attestation?.accepted === true && attestation.version === p.attestation.version)
  ) {
    throw refusal(
      "attestation_required",
      `This import confirms ${p.counts.added_confirmed + p.counts.confirmed_pending} subscribers, so it needs the publisher’s attestation: "${p.attestation.text}" Send attestation: { version: ${ATTESTATION.version}, accepted: true } once they have given it.`,
      { attestation: p.attestation },
    );
  }
  if (p.sendsGrowing.length > 0) {
    // Held to every act that didn't come through the editor, so a client lifts it only by
    // naming itself the editor, never by naming nothing (SPEC §11).
    if (principal.client !== EDITOR_CLIENT) {
      throw refusal(
        "sends_acknowledgement_required",
        "This import would add people to the audience of a scheduled send, which only a person in the editor can acknowledge. Ask the publisher to finish it in the dashboard (Subscribers, Import), choosing the same file: the same plan appears there.",
        { sends: p.sendsGrowing },
      );
    }
    const missing = p.sendsGrowing.filter((s) => !acknowledged.has(s.id));
    if (missing.length > 0) {
      throw refusal(
        "sends_acknowledgement_required",
        `This import would add ${p.sendsGrowing[0]?.gains ?? 0} people to the audience of ${missing.length === 1 ? "a scheduled send" : `${missing.length} scheduled sends`} not yet acknowledged. Acknowledge each one by its id in acknowledge_sends.`,
        { sends: missing },
      );
    }
  }

  const result = await commitImport(c.env.DB, p, principal, Date.now());
  if (result.replayed) {
    return json(result);
  }
  log.info("import.committed", {
    importId: result.import.id,
    ...whoActed(principal),
    rows: p.rowCount,
    confirmed: result.counts.added_confirmed + result.counts.confirmed_pending,
    unsubscribed:
      result.counts.unsubscribed + result.counts.erased + result.counts.added_unsubscribed,
    suppressed: result.suppressions_added,
    differed: result.differed.length,
  });
  return json(result, 201);
}

// The list's states and suppression reasons in the format's words.
const STATUS_CLAIM: Record<string, ImportStatus> = {
  confirmed: "subscribed",
  pending: "pending",
  unsubscribed: "unsubscribed",
};
const SUPPRESSION_CLAIM: Record<string, SuppressionClaim> = {
  bounce: "bounce",
  import_bounce: "bounce",
  manual: "manual",
};
// Why someone left, in the format's words; having left elsewhere is the format's empty cause.
const CAUSE_CLAIM: Record<string, UnsubscribeCauseClaim> = {
  reader: "reader",
  publisher: "publisher",
  complaint: "complaint",
  erased: "erased",
};

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

// The export's cursor: the last address a page held and when the export began.
interface ExportCursor {
  after: string;
  at: number;
}

function encodeExportCursor(cursor: ExportCursor): string {
  return encodePageCursor({ after: cursor.after, at: cursor.at });
}

function decodeExportCursor(raw: string): ExportCursor | null {
  const fields = decodePageCursor(raw);
  if (!fields) {
    return null;
  }
  const { after, at } = fields;
  return typeof after === "string" && after !== "" && Number.isSafeInteger(at)
    ? { after, at: at as number }
    : null;
}

/** GET /api/imports/:id: the record an import keeps, which holds no subscriber's address. */
export async function get(c: RequestContext): Promise<Response> {
  const record = await imports.getImport(c.env.DB, param(c, "id"));
  if (!record) {
    throw notFound("import");
  }
  const body: ImportRecordResponse = { import: record };
  return json(body);
}

/** GET /api/subscribers/export */
export async function exportList(c: RequestContext): Promise<Response> {
  const raw = c.url.searchParams.get("after");
  const cursor = raw === null ? null : decodeExportCursor(raw);
  if (raw !== null && cursor === null) {
    throw fieldError("after", "after must be the next value a page of this export returned");
  }
  const at = cursor?.at ?? Date.now();
  const size = exportPageRows(c.config.subrequestBudget);
  // One row past the page says whether another follows, so the last page never comes empty.
  const read = await imports.listForExport(c.env.DB, cursor?.after ?? null, size + 1);
  const page = read.slice(0, size);
  const last = page.at(-1);
  const rows: ExportRow[] = page.map((r) => ({
    email: r.email,
    status: r.status === null ? "none" : (STATUS_CLAIM[r.status] ?? "none"),
    opt_in: r.opt_in ?? "unknown",
    origin: r.origin ?? "unknown",
    // Only an unsubscribed row says why it left: the format takes a cause nowhere else.
    unsubscribe_cause:
      r.status === "unsubscribed" && r.unsubscribe_cause !== null
        ? (CAUSE_CLAIM[r.unsubscribe_cause] ?? null)
        : null,
    suppression: r.reason === null ? null : (SUPPRESSION_CLAIM[r.reason] ?? "manual"),
    subscribed_at: iso(r.created_at),
    confirmed_at: iso(r.confirmed_at),
    unsubscribed_at: iso(r.unsubscribed_at),
    suppressed_at: iso(r.suppressed_at),
    evidence: r.consent_evidence,
    format: IMPORT_FORMAT,
  }));
  const body: ExportResponse = {
    format: IMPORT_FORMAT,
    exported_at: at,
    subscribers: rows,
    next: read.length > size && last ? encodeExportCursor({ after: last.email, at }) : null,
  };
  return json(body);
}
