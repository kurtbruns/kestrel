/** Small HTTP error + JSON helpers used across routes. */

import type { ApiErrorBody } from "../../shared/errors";
import { errorText, log } from "./log";

export class HttpError extends Error {
  /**
   * `details` are extra top-level fields for the JSON body, for a refusal that must
   * hand the client what it needs to act (the scheduled sends a template save would
   * re-make, SPEC §9) rather than a bare code. They sit beside `error` and `message`,
   * never in place of them.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export const badRequest = (message?: string, details?: Record<string, unknown>) =>
  new HttpError(400, "bad_request", message, details);
export const unauthorized = (message?: string) => new HttpError(401, "unauthorized", message);
export const forbidden = (message?: string) => new HttpError(403, "forbidden", message);
export const notFound = (message?: string) => new HttpError(404, "not_found", message);
export const conflict = (message?: string) => new HttpError(409, "conflict", message);
/**
 * A refusal with a code of its own, so a client tells one reason from another without
 * parsing the message: `window_closed`, `not_wedged`, and the rest the API reference
 * lists per route. `details` carries what the client needs next, such as the send as it
 * stands.
 */
export const refusal = (
  status: 400 | 409 | 412 | 503,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new HttpError(status, code, message, details);
export const unsupportedMediaType = (message?: string) =>
  new HttpError(415, "unsupported_media_type", message);

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
