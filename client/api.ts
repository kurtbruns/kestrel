// The one network seam: every call to the HTTP API goes through api() / apiText(), which
// attach the credential and route a 401 to re-auth. They call the global fetch, so a spec
// stands in for the API by scripting fetch and the real functions run over it.

import { authHeaders, showReauth } from "./auth";

/** What a request may carry. `json` sets the body and its content type; `body` is sent as is. */
export interface ApiOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  json?: unknown;
}

/**
 * A non-2xx answer. Callers branch on `status` (the editor's conflict handling on 409)
 * and read the parsed body, when there was one, from `data`.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const REAUTH_MESSAGE = "Not authorized — please sign in again.";

async function send(path: string, opts: ApiOptions): Promise<Response> {
  const headers: Record<string, string> = { ...authHeaders(), ...(opts.headers ?? {}) };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, { method: opts.method ?? "GET", headers, body });
  if (res.status === 401) {
    showReauth();
    throw new ApiError(REAUTH_MESSAGE, 401);
  }
  return res;
}

/** The message an error body carries, when it carries one. */
function messageOf(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const d = data as { message?: unknown; error?: unknown };
    if (typeof d.message === "string") {
      return d.message;
    }
    if (typeof d.error === "string") {
      return d.error;
    }
  }
  return undefined;
}

/** Call the API and parse its JSON answer (null for an empty body). Throws ApiError on a non-2xx. */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await send(path, opts);
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(messageOf(data) ?? res.statusText, res.status, data);
  }
  return data as T;
}

/**
 * Like api(), but the raw response text, for the endpoints that answer with HTML (the
 * rendered preview). Same 401 guard, which a bare fetch(authHeaders()) would skip.
 */
export async function apiText(path: string, opts: ApiOptions = {}): Promise<string> {
  const res = await send(path, opts);
  if (!res.ok) {
    throw new ApiError(res.statusText, res.status);
  }
  return res.text();
}
