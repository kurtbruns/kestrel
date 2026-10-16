/** Small HTTP error + JSON helpers used across routes. */

import type { ApiErrorBody } from "../../shared/errors";
import { REFUSAL_STATUS, type RefusalCode } from "../reference/refusals";
import { errorText, log } from "./log";

/**
 * A refusal the API answers with. Its code is one the reference's registry lists
 * (src/reference/refusals.ts), and its status is read from there, so a code can't be
 * thrown without the reference knowing it, nor carry a status the reference doesn't show.
 */
export class HttpError extends Error {
  readonly status: number;

  /**
   * `details` are extra top-level fields for the JSON body, for a refusal that must
   * hand the client what it needs to act (the scheduled sends a template save would
   * re-make, SPEC §9) rather than a bare code. They sit beside `error` and `message`,
   * never in place of them.
   */
  constructor(
    readonly code: RefusalCode,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "HttpError";
    this.status = REFUSAL_STATUS[code];
  }
}

export const badRequest = (message?: string, details?: Record<string, unknown>) =>
  new HttpError("bad_request", message, details);
export const unauthorized = (message?: string) => new HttpError("unauthorized", message);
export const forbidden = (message?: string) => new HttpError("forbidden", message);
export const notFound = (message?: string) => new HttpError("not_found", message);
export const conflict = (message?: string) => new HttpError("conflict", message);
/**
 * A refusal with a code of its own, so a client tells one reason from another without
 * parsing the message: `window_closed`, `not_wedged`, and the rest the API reference
 * lists per route. `details` carries what the client needs next, such as the send as it
 * stands.
 */
export const refusal = (code: RefusalCode, message: string, details?: Record<string, unknown>) =>
  new HttpError(code, message, details);
export const unsupportedMediaType = (message?: string) =>
  new HttpError("unsupported_media_type", message);

/** JSON response helper. */
export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

/** Log a thrown value nothing handled, as the one `request.error` line it earns (SPEC §12). */
export function logUncaught(err: unknown): void {
  log.error("request.error", {
    name: err instanceof Error ? err.name : typeof err,
    error: errorText(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
}

/** Turn any thrown value into a JSON error response. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    const body: ApiErrorBody = { ...err.details, error: err.code, message: err.message };
    return json(body, err.status);
  }
  logUncaught(err);
  const body: ApiErrorBody = { error: "internal_error" };
  return json(body, 500);
}
