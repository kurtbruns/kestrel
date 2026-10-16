// Bringing a list in and taking it out (SPEC §7): the one import format, `kestrel-subscribers/1`,
// as data (its columns, their values, the plain list's rules, the limits), the reader that
// turns a file into rows or refuses it by name, the rule that folds an address's repeats into
// one row, and the wire shapes of the plan, the commit, and the export.
//
// Everything a client learns about the format (the format route, the templates, the reference
// page) is generated from or checked against the definitions here, and the Worker parses with
// the same code, so what is documented and what is accepted cannot drift apart. Pure and
// dependency-free: the Worker and the editor both import it.

import { isValidEmail, normalizeEmail } from "./email";
import { publicationName } from "./publication";

/** The format's name and version, written in its `format` column. */
export const IMPORT_FORMAT = "kestrel-subscribers/1";

/** Every version this release reads, oldest first. A file names one or is read as version 1. */
export const IMPORT_FORMAT_VERSIONS: readonly string[] = [IMPORT_FORMAT];

/** The consent claim a row makes. `none` is a known address with no claim, carrying a suppression. */
export const IMPORT_STATUSES = ["subscribed", "pending", "unsubscribed", "none"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** How consent was collected, as the source states it; `unknown` unless it does. */
export const OPT_INS = ["double", "single", "unknown"] as const;
export type OptIn = (typeof OPT_INS)[number];

/** A suppression a row carries on top of its status. */
export const SUPPRESSION_CLAIMS = ["bounce", "complaint", "manual", "erased"] as const;
export type SuppressionClaim = (typeof SUPPRESSION_CLAIMS)[number];

/** What a plain list's addresses are, declared in the request; `subscribed` by default. */
export const PLAIN_LIST_STATUSES = ["subscribed", "unsubscribed", "bounced"] as const;
export type PlainListStatus = (typeof PLAIN_LIST_STATUSES)[number];

/** The two files an import reads, by extension. */
export type ImportFileKind = "csv" | "txt";

/** The limits on one import. A deployment on Workers Free gets `maxRowsFree` (the format route says which applies). */
export const IMPORT_LIMITS = {
  maxRows: 10_000,
  maxRowsFree: 1_000,
  /** The request body, in bytes: 10,000 rows of about 700 bytes, evidence included. */
  maxBodyBytes: 10 * 1024 * 1024,
  /** One row's `evidence`, in bytes of its JSON. */
  maxEvidenceBytes: 500,
} as const;

/**
 * Rows per page of the export, set by the server, never the client. Workers Free's 10 ms of
 * CPU a request reads and writes about 1,000 rows (around 3 ms); Paid's memory holds 10,000
 * (around 20 MB) with room to spare.
 */
export const EXPORT_PAGE_ROWS = {
  paid: 10_000,
  free: 1_000,
} as const;

// An origin is a short lowercase name: `sendy`, `mailchimp`, `kestrel`, `unknown`.
const ORIGIN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

// An instant with its zone: a date, a time to the minute or finer, and `Z` or an offset.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/** One column of the format, as the format route and the reference page describe it. */
export interface ImportColumn {
  name: string;
  required: boolean;
  /** The values it takes, when they are a fixed set. */
  values: readonly string[] | null;
  /** What it takes when it isn't a fixed set. */
  takes: string;
  meaning: string;
}

/** The format's columns, in the order the template and the export write them. */
export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  {
    name: "email",
    required: true,
    values: null,
    takes: "an email address; trimmed and lowercased before it is matched",
    meaning:
      "The address. An invalid one is still a row, counted as invalid and reported, never dropped.",
  },
  {
    name: "status",
    required: true,
    values: IMPORT_STATUSES,
    takes: "one of the values",
    meaning:
      "The consent claim. `none` is a known address with no consent claim, present only to carry a suppression.",
  },
  {
    name: "opt_in",
    required: true,
    values: OPT_INS,
    takes: "one of the values",
    meaning: "How consent was collected. `unknown` unless the source states it.",
  },
  {
    name: "origin",
    required: true,
    values: null,
    takes:
      "a short lowercase name (letters, digits, `.`, `_`, `-`, up to 40): `sendy`, `mailchimp`, `kestrel`, `unknown`",
    meaning: "Where consent was first collected, as the file claims it.",
  },
  {
    name: "suppression",
    required: false,
    values: SUPPRESSION_CLAIMS,
    takes: "one of the values, or empty",
    meaning:
      "A suppression on top of `status`: the address bounced, complained, was suppressed by hand, or was erased.",
  },
  {
    name: "subscribed_at",
    required: false,
    values: null,
    takes: "a UTC ISO-8601 instant with its zone (`2024-03-01T09:30:00Z`), or empty",
    meaning: "When the person subscribed, if the source states it.",
  },
  {
    name: "confirmed_at",
    required: false,
    values: null,
    takes: "an instant with its zone, or empty",
    meaning: "When the person confirmed, if the source states it.",
  },
  {
    name: "unsubscribed_at",
    required: false,
    values: null,
    takes: "an instant with its zone, or empty",
    meaning:
      "When the person left, if the source states it. A reader who confirmed here after it stays confirmed.",
  },
  {
    name: "suppressed_at",
    required: false,
    values: null,
    takes: "an instant with its zone, or empty",
    meaning: "When the address was suppressed, if the source states it.",
  },
  {
    name: "evidence",
    required: false,
    values: null,
    takes: `a JSON object of at most ${IMPORT_LIMITS.maxEvidenceBytes} bytes, or empty`,
    meaning:
      "The source’s consent-relevant columns, verbatim (a signup IP, a form name, a confirmation time). Nothing reads it to decide anything: it is the proof of consent and the audit trail of a conversion.",
  },
  {
    name: "format",
    required: false,
    values: IMPORT_FORMAT_VERSIONS,
    takes: "the format’s name and version, or empty",
    meaning:
      "The version the file is written in. A file without it is read as version 1; a version this release doesn’t know is refused by name.",
  },
];

const COLUMN_NAMES = new Set(IMPORT_COLUMNS.map((c) => c.name));

/** One row of a file, read and checked, before an address's repeats are folded together. */
export interface ImportRow {
  /** The row's place in the file, from 1: the data row for a CSV (the header is row 0), the line for a plain list. */
  row: number;
  /** The address, normalized; for an invalid row, the text as it was. */
  email: string;
  valid: boolean;
  status: ImportStatus;
  opt_in: OptIn;
  origin: string;
  suppression: SuppressionClaim | null;
  subscribed_at: number | null;
  confirmed_at: number | null;
  unsubscribed_at: number | null;
  suppressed_at: number | null;
  /** The evidence as compact JSON, or null. */
  evidence: string | null;
}

/** A refusal of a whole file, with what was wrong and what was expected. */
export interface ImportFileError {
  code: "unrecognized_format" | "invalid_field";
  message: string;
  /** The row it is about, numbered as `ImportRow.row` is (0 for the header). */
  row?: number;
  /** The column it is about. */
  column?: string;
  /** The values that column takes. */
  allowed?: readonly string[];
}

/** A file read: its kind and its rows in file order. */
export interface ParsedImport {
  kind: ImportFileKind;
  rows: ImportRow[];
}

export type ParseResult = { ok: true; file: ParsedImport } | { ok: false; error: ImportFileError };

/** The file kind its name says, or null for a name that is neither `.csv` nor `.txt`. */
export function fileKindOf(name: string): ImportFileKind | null {
  const lower = name.trim().toLowerCase();
  return lower.endsWith(".csv") ? "csv" : lower.endsWith(".txt") ? "txt" : null;
}

/**
 * Read an import file, or refuse it whole by name. A `.csv` is the full format; a `.txt` is a
 * plain list whose addresses are `plainListStatus`. The text is the file decoded as UTF-8.
 */
export function parseImportFile(
  file: { name: string; text: string },
  plainListStatus: PlainListStatus = "subscribed",
): ParseResult {
  const kind = fileKindOf(file.name);
  if (kind === null) {
    return refuse(
      "unrecognized_format",
      `"${file.name}" is neither a .csv in the ${IMPORT_FORMAT} format nor a .txt plain list of addresses.`,
    );
  }
  // A U+FFFD is what a decoder leaves for bytes that weren't UTF-8, and a NUL is never text.
  if (/[�\0]/.test(file.text)) {
    return refuse(
      "unrecognized_format",
      `"${file.name}" isn’t UTF-8 text. Save it as UTF-8 (CSV UTF-8 in a spreadsheet) and choose it again.`,
    );
  }
  const text = file.text.startsWith("﻿") ? file.text.slice(1) : file.text;
  return kind === "csv" ? parseCsvFile(text) : parsePlainList(text, plainListStatus);
}

function refuse(
  code: ImportFileError["code"],
  message: string,
  at: Omit<ImportFileError, "code" | "message"> = {},
): { ok: false; error: ImportFileError } {
  return { ok: false, error: { code, message, ...at } };
}

/** A plain list's addresses as rows with what the request declared them to be. */
function parsePlainList(text: string, declared: PlainListStatus): ParseResult {
  const lines = text.split(/\r\n|\n|\r/);
  const rows: ImportRow[] = [];
  let anyValid = false;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") {
      continue;
    }
    if (/[,;\t]/.test(line)) {
      return refuse(
        "unrecognized_format",
        `Line ${i + 1} has a comma, tab, or semicolon, so this is a table, not a plain list. Save it as a .csv in the ${IMPORT_FORMAT} format, or keep only the addresses, one per line.`,
        { row: i + 1 },
      );
    }
    const email = normalizeEmail(line);
    const valid = isValidEmail(email);
    anyValid ||= valid;
    rows.push({
      row: i + 1,
      email: valid ? email : line,
      valid,
      status: declared === "bounced" ? "none" : declared,
      opt_in: "unknown",
      origin: "unknown",
      suppression: declared === "bounced" ? "bounce" : null,
      subscribed_at: null,
      confirmed_at: null,
      unsubscribed_at: null,
      suppressed_at: null,
      evidence: null,
    });
  }
  if (!anyValid) {
    return refuse(
      "unrecognized_format",
      "There isn’t one valid email address in this file. A plain list is one address per line.",
    );
  }
  return { ok: true, file: { kind: "txt", rows } };
}

/**
 * Split RFC 4180 text into records of fields: commas between fields, a field in double quotes
 * may hold commas, quotes (doubled), and line breaks, and a record ends at CRLF, LF, or CR.
 * An unclosed quote is reported by the record it opened in.
 */
export function splitCsv(text: string): { records: string[][] } | { unclosed: number } {
  const records: string[][] = [];
  let record: string[] = [];
  let i = 0;
  const n = text.length;
  while (i <= n) {
    if (i === n) {
      // The text ended: a last record with no line break after it.
      if (record.length > 0) {
        records.push(record);
      }
      break;
    }
    let field: string;
    if (text.charCodeAt(i) === 34 /* " */) {
      let out = "";
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q === -1) {
          return { unclosed: records.length };
        }
        out += text.slice(j, q);
        if (text.charCodeAt(q + 1) === 34) {
          out += '"';
          j = q + 2;
          continue;
        }
        i = q + 1;
        break;
      }
      field = out;
      // Anything between the closing quote and the delimiter is kept, as a lenient reader would.
      const end = nextDelimiter(text, i);
      field += text.slice(i, end);
      i = end;
    } else {
      const end = nextDelimiter(text, i);
      field = text.slice(i, end);
      i = end;
    }
    record.push(field);
    const c = text.charCodeAt(i);
    if (c === 44 /* , */) {
      i += 1;
      if (i === n) {
        record.push("");
      }
      continue;
    }
    records.push(record);
    record = [];
    if (c === 13 /* \r */ && text.charCodeAt(i + 1) === 10) {
      i += 2;
    } else {
      i += 1;
    }
    if (i >= n) {
      break;
    }
  }
  return { records };
}

function nextDelimiter(text: string, from: number): number {
  for (let k = from; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (c === 44 || c === 10 || c === 13) {
      return k;
    }
  }
  return text.length;
}

/** An instant with its zone as epoch milliseconds, or undefined for anything else. */
export function parseInstant(value: string): number | undefined {
  if (!INSTANT.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The full format: a header of the format's own column names, then a row per address. */
function parseCsvFile(text: string): ParseResult {
  const split = splitCsv(text);
  if ("unclosed" in split) {
    return refuse(
      "unrecognized_format",
      `This isn’t valid CSV: a quoted value that opens in row ${split.unclosed} is never closed.`,
      { row: split.unclosed },
    );
  }
  const records = split.records.filter((r) => !(r.length === 1 && r[0]?.trim() === ""));
  const header = records[0];
  if (!header?.includes("email")) {
    return refuse(
      "unrecognized_format",
      `This isn’t a ${IMPORT_FORMAT} file: its first row must name the columns, including email, status, opt_in, and origin. An export from another service is converted to this format first.`,
      { row: 0 },
    );
  }
  const seen = new Set<string>();
  for (const name of header) {
    if (!COLUMN_NAMES.has(name)) {
      const lower = name.trim().toLowerCase();
      const hint = COLUMN_NAMES.has(lower)
        ? ` Column names are written exactly, in lowercase: "${lower}".`
        : " A source’s other columns belong in evidence, as JSON, not beside it.";
      return refuse(
        "invalid_field",
        `The column "${name}" isn’t part of ${IMPORT_FORMAT}.${hint}`,
        {
          row: 0,
          column: name,
          allowed: [...COLUMN_NAMES],
        },
      );
    }
    if (seen.has(name)) {
      return refuse("invalid_field", `The column "${name}" appears twice in the header.`, {
        row: 0,
        column: name,
      });
    }
    seen.add(name);
  }
  for (const col of IMPORT_COLUMNS) {
    if (col.required && !seen.has(col.name)) {
      return refuse("invalid_field", `The required column "${col.name}" is missing.`, {
        row: 0,
        column: col.name,
      });
    }
  }
  const at = (name: string): number => header.indexOf(name);
  const idx = {
    email: at("email"),
    status: at("status"),
    opt_in: at("opt_in"),
    origin: at("origin"),
    suppression: at("suppression"),
    subscribed_at: at("subscribed_at"),
    confirmed_at: at("confirmed_at"),
    unsubscribed_at: at("unsubscribed_at"),
    suppressed_at: at("suppressed_at"),
    evidence: at("evidence"),
    format: at("format"),
  };
  const rows: ImportRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const record = records[r] ?? [];
    if (record.length !== header.length) {
      return refuse(
        "invalid_field",
        `Row ${r} has ${record.length} values for the header’s ${header.length} columns.`,
        { row: r },
      );
    }
    const cell = (i: number): string => (i < 0 ? "" : unguardFormula((record[i] ?? "").trim()));
    const pick = <T extends string>(name: string, i: number, allowed: readonly T[]): T => {
      const v = cell(i);
      if ((allowed as readonly string[]).includes(v)) {
        return v as T;
      }
      throw refuse(
        "invalid_field",
        `Row ${r}: ${name} is "${v}", which isn’t one of ${allowed.join(", ")}.`,
        { row: r, column: name, allowed },
      ).error;
    };
    const instant = (name: string, i: number): number | null => {
      const v = cell(i);
      if (v === "") {
        return null;
      }
      const ms = parseInstant(v);
      if (ms === undefined) {
        throw refuse(
          "invalid_field",
          `Row ${r}: ${name} is "${v}", which isn’t an instant with its zone, such as 2024-03-01T09:30:00Z. A time without a zone is never guessed at.`,
          { row: r, column: name },
        ).error;
      }
      return ms;
    };
    try {
      const format = cell(idx.format);
      if (format !== "" && !IMPORT_FORMAT_VERSIONS.includes(format)) {
        return refuse(
          "unrecognized_format",
          `Row ${r} is written in "${format}", a version this release can’t read. It reads ${IMPORT_FORMAT_VERSIONS.join(", ")}.`,
          { row: r, column: "format", allowed: IMPORT_FORMAT_VERSIONS },
        );
      }
      const origin = cell(idx.origin);
      if (!ORIGIN.test(origin)) {
        return refuse(
          "invalid_field",
          `Row ${r}: origin is "${origin}", which isn’t a short lowercase name such as sendy, mailchimp, or unknown.`,
          { row: r, column: "origin" },
        );
      }
      const suppression = cell(idx.suppression);
      const evidenceText = cell(idx.evidence);
      let evidence: string | null = null;
      if (evidenceText !== "") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(evidenceText);
        } catch {
          parsed = undefined;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return refuse("invalid_field", `Row ${r}: evidence isn’t a JSON object.`, {
            row: r,
            column: "evidence",
          });
        }
        evidence = JSON.stringify(parsed);
        if (utf8Bytes(evidence) > IMPORT_LIMITS.maxEvidenceBytes) {
          return refuse(
            "invalid_field",
            `Row ${r}: evidence is over ${IMPORT_LIMITS.maxEvidenceBytes} bytes. Keep only the source’s consent-relevant columns.`,
            { row: r, column: "evidence" },
          );
        }
      }
      const raw = cell(idx.email);
      const email = normalizeEmail(raw);
      const valid = isValidEmail(email);
      rows.push({
        row: r,
        email: valid ? email : raw,
        valid,
        status: pick("status", idx.status, IMPORT_STATUSES),
        opt_in: pick("opt_in", idx.opt_in, OPT_INS),
        origin,
        suppression:
          suppression === "" ? null : pick("suppression", idx.suppression, SUPPRESSION_CLAIMS),
        subscribed_at: instant("subscribed_at", idx.subscribed_at),
        confirmed_at: instant("confirmed_at", idx.confirmed_at),
        unsubscribed_at: instant("unsubscribed_at", idx.unsubscribed_at),
        suppressed_at: instant("suppressed_at", idx.suppressed_at),
        evidence,
      });
    } catch (err) {
      return { ok: false, error: err as ImportFileError };
    }
  }
  return { ok: true, file: { kind: "csv", rows } };
}

// Merging repeats: which claim wins. Higher wins; for opt_in the weakest claim wins.
const STATUS_RANK: Record<ImportStatus, number> = {
  none: 0,
  pending: 1,
  subscribed: 2,
  unsubscribed: 3,
};
const SUPPRESSION_RANK: Record<SuppressionClaim, number> = {
  manual: 0,
  bounce: 1,
  complaint: 2,
  erased: 3,
};
const OPT_IN_STRENGTH: Record<OptIn, number> = { unknown: 0, single: 1, double: 2 };

function earliest(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

function latest(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.max(a, b);
}

/** A file's rows with each address's repeats folded together. */
export interface MergedImport {
  /** One row per valid address, at the place its first row held, carrying the merged claims. */
  rows: ImportRow[];
  /** The rows folded into an earlier one. */
  repeats: ImportRow[];
  /** The rows whose address isn't valid. */
  invalid: ImportRow[];
}

/**
 * Fold an address's repeats into one row (SPEC §7): status unsubscribed over subscribed over
 * pending over none; suppression erased over complaint over bounce over manual; the weakest
 * opt-in claim; the earliest consent times and the latest unsubscribe and suppression times;
 * and the evidence and origin of the row whose status won (the first such row on a tie).
 */
export function mergeRows(rows: readonly ImportRow[]): MergedImport {
  const byEmail = new Map<string, ImportRow>();
  const out: MergedImport = { rows: [], repeats: [], invalid: [] };
  for (const row of rows) {
    if (!row.valid) {
      out.invalid.push(row);
      continue;
    }
    const held = byEmail.get(row.email);
    if (!held) {
      const copy = { ...row };
      byEmail.set(row.email, copy);
      out.rows.push(copy);
      continue;
    }
    out.repeats.push(row);
    if (STATUS_RANK[row.status] > STATUS_RANK[held.status]) {
      held.status = row.status;
      held.origin = row.origin;
      held.evidence = row.evidence;
    }
    if (
      row.suppression !== null &&
      (held.suppression === null ||
        SUPPRESSION_RANK[row.suppression] > SUPPRESSION_RANK[held.suppression])
    ) {
      held.suppression = row.suppression;
    }
    if (OPT_IN_STRENGTH[row.opt_in] < OPT_IN_STRENGTH[held.opt_in]) {
      held.opt_in = row.opt_in;
    }
    held.subscribed_at = earliest(held.subscribed_at, row.subscribed_at);
    held.confirmed_at = earliest(held.confirmed_at, row.confirmed_at);
    held.unsubscribed_at = latest(held.unsubscribed_at, row.unsubscribed_at);
    held.suppressed_at = latest(held.suppressed_at, row.suppressed_at);
  }
  return out;
}

/** One row's line in the format, as the export and the template write it. */
export interface ExportRow {
  email: string;
  status: ImportStatus;
  opt_in: OptIn;
  origin: string;
  suppression: SuppressionClaim | null;
  subscribed_at: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  suppressed_at: string | null;
  /** A JSON object, as compact text, or null. */
  evidence: string | null;
  format: string;
}

// A spreadsheet runs a cell that starts with one of these as a formula, and anyone can put
// such an address on the list through the public form. The export writes the cell with an
// apostrophe before it, which a spreadsheet shows as text, and the reader takes it off again,
// so the file still round-trips.
const FORMULA_START = /^[=+\-@\t\r]/;

function guardFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function unguardFormula(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

function csvField(raw: string): string {
  const value = guardFormula(raw);
  return /[",\r\n]/.test(value) || value !== value.trim()
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/**
 * Records as CSV text, CRLF-terminated (RFC 4180), each value quoted where it needs to be
 * and guarded against a spreadsheet running it as a formula. The first record is the header.
 */
export function toCsv(records: readonly (readonly string[])[]): string {
  return `${records.map((r) => r.map(csvField).join(",")).join("\r\n")}\r\n`;
}

/** Rows as a CSV file in the format: the header, then a line per row, CRLF-terminated (RFC 4180). */
export function toImportCsv(rows: readonly ExportRow[]): string {
  const names = IMPORT_COLUMNS.map((c) => c.name) as (keyof ExportRow)[];
  return toCsv([names, ...rows.map((row) => names.map((name) => row[name] ?? ""))]);
}

/** The CSV template: a few rows that show the format's cases, and that plan cleanly as they are. */
export const TEMPLATE_ROWS: readonly ExportRow[] = [
  {
    email: "ada@example.com",
    status: "subscribed",
    opt_in: "double",
    origin: "sendy",
    suppression: null,
    subscribed_at: "2024-03-01T09:30:00Z",
    confirmed_at: "2024-03-01T09:42:00Z",
    unsubscribed_at: null,
    suppressed_at: null,
    evidence: '{"signup_ip":"203.0.113.7","list":"Field Notes"}',
    format: IMPORT_FORMAT,
  },
  {
    email: "grace@example.com",
    status: "subscribed",
    opt_in: "single",
    origin: "mailchimp",
    suppression: null,
    subscribed_at: "2023-11-12T16:05:00Z",
    confirmed_at: null,
    unsubscribed_at: null,
    suppressed_at: null,
    evidence: null,
    format: IMPORT_FORMAT,
  },
  {
    email: "edsger@example.com",
    status: "unsubscribed",
    opt_in: "unknown",
    origin: "unknown",
    suppression: null,
    subscribed_at: null,
    confirmed_at: null,
    unsubscribed_at: "2025-01-20T08:00:00Z",
    suppressed_at: null,
    evidence: null,
    format: IMPORT_FORMAT,
  },
  {
    email: "bounced@example.com",
    status: "none",
    opt_in: "unknown",
    origin: "unknown",
    suppression: "bounce",
    subscribed_at: null,
    confirmed_at: null,
    unsubscribed_at: null,
    suppressed_at: "2025-02-02T12:00:00Z",
    evidence: null,
    format: IMPORT_FORMAT,
  },
];

/** The CSV template's text. */
export const TEMPLATE_CSV = toImportCsv(TEMPLATE_ROWS);

/** The plain-list template's text: one address per line. */
export const TEMPLATE_TXT = "ada@example.com\r\ngrace@example.com\r\nlinus@example.com\r\n";

/** The names the two example files download under, so they read as examples of an import,
 *  not as a list someone exported. */
export const EXAMPLE_CSV_NAME = "kestrel-import-example.csv";
export const EXAMPLE_TXT_NAME = "kestrel-import-example.txt";

/**
 * What an import does to one address (SPEC §7), after its repeats are folded together. A row
 * that changes its status and adds a suppression reports its status outcome and
 * `suppression_added: true`; `suppression_added` as the outcome is a row whose only effect
 * is the suppression.
 */
export const IMPORT_OUTCOMES = [
  "create_confirmed",
  "confirm_pending",
  "unchanged",
  "mark_unsubscribed",
  "create_unsubscribed",
  "kept_confirmed_newer",
  "kept_unsubscribed",
  "blocked_by_suppression",
  "suppression_added",
  "left_out",
  "invalid",
  "merged",
] as const;
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];

/** When each outcome applies, for the format route and the reference page. */
export const IMPORT_OUTCOME_MEANINGS: Record<ImportOutcome, string> = {
  create_confirmed:
    "`subscribed`, with no subscriber and no suppression here, and not erased in the file: added as confirmed.",
  confirm_pending:
    "`subscribed`, pending here (never confirmed), and not erased in the file: confirmed, and its confirmation link no longer works.",
  unchanged:
    "Already confirmed here, or already in the state the row claims. A subscriber who joined here keeps their own record.",
  mark_unsubscribed:
    "`unsubscribed`, and confirmed or pending here, with no confirmation here newer than the row’s `unsubscribed_at`: unsubscribed.",
  create_unsubscribed:
    "`unsubscribed`, with no subscriber here, and not erased here or in the file: recorded as unsubscribed, so the list remembers they left.",
  kept_confirmed_newer:
    "`unsubscribed`, but the reader confirmed here after the source’s `unsubscribed_at`: their newer action stands.",
  kept_unsubscribed:
    "`subscribed`, but unsubscribed here, or pending again after leaving until they confirm here themselves. An unsubscribe here is never reversed (I2).",
  blocked_by_suppression:
    "`subscribed`, but the address carries a suppression here, a do-not-contact marker included: never added or confirmed. Also `unsubscribed` for an address whose suppression here is the do-not-contact marker an erasure left, and, for an address erased in the file (its `suppression` is `erased`, which is still added), `subscribed` or `unsubscribed` with no subscriber here, or `subscribed` and pending here, which stays pending: no subscriber is recorded or confirmed, so an import never brings back an erased person’s data.",
  suppression_added:
    "The row carries a suppression and the address has none here (or only a do-not-contact marker, which a bounce, a complaint, or a manual suppression replaces), and nothing else changes. Applied whatever the row’s `status`.",
  left_out:
    "`pending` or `none` with nothing to apply: counted, never confirmed. An import sends no email.",
  invalid: "The address isn’t valid.",
  merged: "A repeat of an address earlier in the file, folded into it.",
};

/** The outcomes that confirm someone, which need the publisher's attestation. */
export const CONFIRMING_OUTCOMES: ReadonlySet<ImportOutcome> = new Set([
  "create_confirmed",
  "confirm_pending",
]);

/** The publisher's attestation, at the version the plan returns. `[publication]` names theirs. */
export const ATTESTATION = {
  version: 1,
  text: "Everyone I’m importing as subscribed opted in to receive [publication]. This isn’t a purchased, rented, or scraped list.",
} as const;

/** The publication as the attestation names it: by the name every surface shows (SPEC §9),
 *  its own or else the sender's display name, and as "this newsletter" when it has neither. */
export function attestationPublication(name: string, fromAddress: string): string {
  return publicationName(name, fromAddress) || "this newsletter";
}

/** The attestation's words for a publication named as `attestationPublication` names it. */
export function attestationText(publication: string): string {
  return ATTESTATION.text.replace("[publication]", publication);
}

/** One row of the plan or the commit that won't be confirmed, with what happens to it. */
export interface ImportRowResult {
  /** Its place in the file (`ImportRow.row`). */
  row: number;
  email: string;
  outcome: ImportOutcome;
  /** Whether it also adds a suppression. */
  suppression_added: boolean;
}

/** A scheduled send whose audience the import would grow. */
export interface GrowingSend {
  id: string;
  subject: string;
  fire_at: number;
  /** How many it gains. */
  gains: number;
}

export type OutcomeCounts = Record<ImportOutcome, number>;

/** What the rows that would be confirmed claim, counted by how consent was collected and where. */
export interface ConfirmedBreakdown {
  opt_in: Record<OptIn, number>;
  origin: Record<string, number>;
}

/** The file a plan or a commit is about. */
export interface ImportFileSummary {
  name: string;
  kind: ImportFileKind;
  /** Its rows, invalid and repeated ones included. */
  rows: number;
  /** Its distinct valid addresses. */
  addresses: number;
  /** A plain list's declared meaning; null for a CSV. */
  plain_list_status: PlainListStatus | null;
}

/** The body of a plan: the file as text, and for a plain list what its addresses are. */
export interface ImportPlanRequest {
  file: { name: string; text: string };
  plain_list_status?: PlainListStatus;
}

/** POST /api/imports/plan: what an import would do, which writes nothing (SPEC §7). */
export interface ImportPlanResponse {
  file: ImportFileSummary;
  /** Every row once, by outcome; they sum to `file.rows`. */
  counts: OutcomeCounts;
  /** Rows that add a suppression, whatever their outcome. */
  suppressions_added: number;
  confirmed: ConfirmedBreakdown;
  /** The rows that won't be confirmed, in file order, each with its outcome. */
  rows: ImportRowResult[];
  sends_growing: GrowingSend[];
  /** The attestation the commit needs, with the name it calls the publication, or null when no row would be confirmed. */
  attestation: { version: number; text: string; publication: string } | null;
  /** What the commit must name, so it applies this plan and no other. */
  plan_hash: string;
  /** On the Workers Free plan's limits, when this import would leave more confirmed subscribers than Free suits (`FREE_PLAN_LIST`): the server's advice to move to Workers Paid, to show as it stands. Null otherwise. Never a refusal. */
  workers_plan_advice: string | null;
}

/** The body of a commit: the plan's body, the plan's hash, and the publisher's answers. */
export interface ImportCommitRequest extends ImportPlanRequest {
  plan_hash: string;
  attestation?: { version: number; accepted: true };
  /** The id of every send in `sends_growing`. */
  acknowledge_sends?: string[];
}

/** An import as it is kept: never an address (SPEC §8). */
export interface ImportRecord {
  id: string;
  created_at: number;
  principal: { kind: "human" | "service"; email: string | null };
  /** The attestation's version, or null when none was needed. */
  attestation_version: number | null;
  file_name: string;
  file_sha256: string;
  plan_hash: string;
  counts: OutcomeCounts;
  suppressions_added: number;
}

/** A row the commit planned to write that the list, changed in the meantime, didn't let it. */
export interface ImportDifference {
  row: number;
  email: string;
  planned: ImportOutcome;
  applied: ImportOutcome;
}

/** POST /api/imports: what was applied. */
export interface ImportCommitResponse {
  import: ImportRecord;
  /** Every row once, by outcome as applied. */
  counts: OutcomeCounts;
  suppressions_added: number;
  /** The rows not confirmed, as applied. Empty on a replay, since the record keeps no address. */
  rows: ImportRowResult[];
  /** The rows whose result differed from the commit's own plan. Empty on a replay. */
  differed: ImportDifference[];
  /** True when this answers a commit already applied, and nothing was written now. */
  replayed: boolean;
}

/**
 * A page of GET /api/subscribers/export. Pages run in address order; following `next` until
 * it is null reads every address on the list for the whole export exactly once (SPEC §8).
 * A CSV is the pages' rows through `toImportCsv`.
 */
export interface ExportResponse {
  format: string;
  /** When the export's first page was read, the same on every page. */
  exported_at: number;
  subscribers: ExportRow[];
  /** Pass as `?after=` for the next page; null on the last. Opaque. */
  next: string | null;
}

/** One file an import reads, as the format route describes it. */
export interface ImportFileFormat {
  kind: ImportFileKind;
  name: string;
  when: string;
  /** What a list loses in this format, empty for the full one. */
  loses: string[];
  template: string;
}

/** GET /api/imports/format: everything about the format, generated from this module. */
export interface ImportFormatResponse {
  format: string;
  versions: readonly string[];
  preferred: { kind: ImportFileKind; why: string };
  files: ImportFileFormat[];
  columns: readonly ImportColumn[];
  plain_list: {
    statuses: { value: PlainListStatus; means: string }[];
    default: PlainListStatus;
    rules: string[];
  };
  limits: {
    /** The most rows this deployment takes in one import. */
    max_rows: number;
    /** Why it is that, when it is below the format's own limit. */
    max_rows_reason: string | null;
    max_body_bytes: number;
    max_evidence_bytes: number;
  };
  outcomes: { outcome: ImportOutcome; when: string }[];
  attestation: { version: number; text: string };
}

/** The plain list's rules, in words, as the format route and the reference page give them. */
export const PLAIN_LIST_RULES: readonly string[] = [
  "One address per line. Each line is trimmed, blank lines are skipped, and CRLF line endings and a UTF-8 byte-order mark are accepted.",
  "A line that isn’t a single valid address (`Name <ada@example.com>`, a typo) is counted as invalid and listed among the rows left out, so one bad line doesn’t sink a list.",
  "The whole file is refused as `unrecognized_format` when it isn’t a plain list at all: not UTF-8 text, a line with a comma, tab, or semicolon (it’s a table, so a .csv), or not one valid address in it.",
  "Its rows arrive with `origin: unknown` and `opt_in: unknown`.",
];

/** The format described for a deployment that takes at most `maxRows` rows. */
export function describeFormat(
  maxRows: number,
  maxRowsReason: string | null,
): ImportFormatResponse {
  return {
    format: IMPORT_FORMAT,
    versions: IMPORT_FORMAT_VERSIONS,
    preferred: {
      kind: "csv",
      why: "The full CSV carries unsubscribes, bounces, and how each person joined; it is what the export writes; and you can open it in a spreadsheet to check it before importing.",
    },
    files: [
      {
        kind: "csv",
        name: `${IMPORT_FORMAT} (.csv)`,
        when: "Any list with more than addresses: who unsubscribed or bounced, how and where each person joined, and the evidence. The format the export writes.",
        loses: [],
        template: "/api/imports/template.csv",
      },
      {
        kind: "txt",
        name: "Plain list (.txt)",
        when: "A list that is only addresses, all of one kind, which you declare: subscribed, unsubscribed, or bounced.",
        loses: [
          "How each person joined: their opt-in method and origin are recorded as unknown.",
          "Any times: when each person subscribed, confirmed, or left.",
          "The evidence of consent.",
          "Mixed states: every address in the file is the one kind you declare, so unsubscribes and bounces need a file of their own.",
        ],
        template: "/api/imports/template.txt",
      },
    ],
    columns: IMPORT_COLUMNS,
    plain_list: {
      statuses: [
        {
          value: "subscribed",
          means: "They opted in: imported as confirmed, with your attestation.",
        },
        {
          value: "unsubscribed",
          means: "They left: unsubscribed here, or recorded as unsubscribed.",
        },
        { value: "bounced", means: "Their mail bounced: suppressed, whatever their state here." },
      ],
      default: "subscribed",
      rules: [...PLAIN_LIST_RULES],
    },
    limits: {
      max_rows: maxRows,
      max_rows_reason: maxRowsReason,
      max_body_bytes: IMPORT_LIMITS.maxBodyBytes,
      max_evidence_bytes: IMPORT_LIMITS.maxEvidenceBytes,
    },
    outcomes: IMPORT_OUTCOMES.map((outcome) => ({
      outcome,
      when: IMPORT_OUTCOME_MEANINGS[outcome],
    })),
    attestation: { version: ATTESTATION.version, text: ATTESTATION.text },
  };
}
