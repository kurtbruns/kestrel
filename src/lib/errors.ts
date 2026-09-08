/** Small HTTP error + JSON helpers used across routes. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export const badRequest = (message?: string) => new HttpError(400, "bad_request", message);
export const unauthorized = (message?: string) => new HttpError(401, "unauthorized", message);
export const forbidden = (message?: string) => new HttpError(403, "forbidden", message);
export const notFound = (message?: string) => new HttpError(404, "not_found", message);
export const conflict = (message?: string) => new HttpError(409, "conflict", message);

/** JSON response helper. */
export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

/** Turn any thrown value into a JSON error response. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.code, message: err.message }, err.status);
  }
  console.error("unhandled error", err);
  return json({ error: "internal_error" }, 500);
}
