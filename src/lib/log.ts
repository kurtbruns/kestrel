/**
 * Structured logging: one JSON object per line, so Workers Logs indexes every field and a
 * send's timeline is one query on its `sendId` (SPEC §12, the event catalog).
 *
 * Logs explain; the record decides. Nothing reads a log line to make a decision, so the
 * helper is fire-and-forget: it never throws, never awaits, and is called only after the
 * decision it describes has been made. Its only input from outside is the correlation id
 * (`run`), minted once per sweep tick and per request by the entry point (`withRun`), so a
 * tick's or a request's lines group together without every caller threading it through.
 *
 * No address, token, or credential goes in a field (the line SPEC §9 draws for settings).
 * Field values are scalars only, so a row, an error object, or a recipient list can't be
 * dumped whole, and every string is scrubbed on the way out, of anything address-shaped
 * and of any token in a URL, so a provider's or an exception's own text (or a stack) can't
 * carry one through either.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "error" | "warn" | "info";

/** A field's value: a scalar, never an object, so nothing is logged whole by accident.
 *  `undefined` drops the field. */
export type LogValue = string | number | boolean | null | undefined;

/** The fields of one line besides `event` and `level`. The named ones are the stable
 *  fields a query filters on; the rest are the event's own ids, counts, durations, enums,
 *  and provider text. */
export interface LogFields {
  sendId?: string;
  postId?: string;
  provider?: string;
  [field: string]: LogValue;
}

const runs = new AsyncLocalStorage<string>();

/** Run `fn` with `run` as the correlation id of every line it logs, however deep. */
export function withRun<T>(run: string, fn: () => T): T {
  return runs.run(run, fn);
}

/** A fresh correlation id, for a sweep tick or a request with no `cf-ray`. */
export function newRun(): string {
  return crypto.randomUUID();
}

// An address anywhere in a string: the local part goes, the domain stays, so a provider's
// "domain not verified" still says which domain while no subscriber is named. Wide on
// purpose, since a miss leaks and an over-match only blurs a line: a quoted local part,
// an `@` URL-encoded as `%40`, a domain in any script, a single label, or an IP literal.
const ADDRESS =
  /(?:"[^"\r\n]*"|[^\s<>"'(),;:@/?&=[\]]+?)(?:@|%40)(\[[^\]\s]*\]|[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*)/giu;
// A token in a URL (`/unsubscribe?token=…`, `/confirm?token=…`), which would let whoever
// reads the line act as that subscriber.
const TOKEN = /([?&;]token=)[^&\s"'#<>]+/gi;

/** A string with every address in it reduced to its domain and every URL token removed. */
export function scrub(text: string): string {
  return text.replace(ADDRESS, "…@$1").replace(TOKEN, "$1…");
}

function emit(level: LogLevel, event: string, fields: LogFields): void {
  try {
    const line: Record<string, string | number | boolean | null> = { event, level };
    const run = runs.getStore();
    if (run) {
      line.run = run;
    }
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || name === "event" || name === "level" || name === "run") {
        continue;
      }
      line[name] = typeof value === "string" ? scrub(value) : value;
    }
    const text = JSON.stringify(line);
    // The console method sets the level Workers Logs records, beside the `level` field.
    // biome-ignore lint/suspicious/noConsole: the one place the Worker writes a log line.
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(text);
  } catch {
    // A log line is never worth failing the work it describes.
  }
}

/**
 * The logger. `event` is a dotted name from the catalog in SPEC §12 (`send.batch`), which
 * a new event joins. The level carries the meaning, so pick it by this rule:
 *   - `error`: something could mail a person twice (I4), a send that should have gone out
 *     has not (missed, stuck, wedged), or a failure nothing else handled. Worth a look.
 *   - `warn`: the app is waiting something out that it recovers from on its own (a halt,
 *     a refusal, a lost lease, a notification to retry), but a person may want to know.
 *   - `info`: the ordinary lifecycle, and the counts of work done.
 * Work over many recipients is one line of counts, never a line each.
 */
export const log = {
  error: (event: string, fields: LogFields = {}): void => emit("error", event, fields),
  warn: (event: string, fields: LogFields = {}): void => emit("warn", event, fields),
  info: (event: string, fields: LogFields = {}): void => emit("info", event, fields),
};

/** An error's message as a field value (scrubbed like any string on the way out). */
export function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err);
}
