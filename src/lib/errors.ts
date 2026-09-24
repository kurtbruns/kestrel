/** Small HTTP error + JSON helpers used across routes. */

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
export const unsupportedMediaType = (message?: string) =>
  new HttpError(415, "unsupported_media_type", message);

/** JSON response helper. */
export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

/** Turn any thrown value into a JSON error response. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ ...err.details, error: err.code, message: err.message }, err.status);
  }
  log.error("request.error", {
    name: err instanceof Error ? err.name : typeof err,
    error: errorText(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return json({ error: "internal_error" }, 500);
}
