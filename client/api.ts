// The one network seam: every call to the HTTP API goes through api(), apiText(), or
// apiFile(), which attach the credential, route a 401 to re-auth and a refused deploy
// configuration to its wall, and turn any other failure into one ApiError carrying the
// server's message. They call the global fetch, so a spec
// stands in for the API by scripting fetch and the real functions run over it.

import { authHeaders, showReauth } from "./auth";
import { configRefusal, showConfigProblem } from "./config_problem";

/** What a request may carry. `json` sets the body and its content type; `body` is sent as is. */
export interface ApiOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  json?: unknown;
  /**
   * The mounted view's signal, for a read that paints: navigating away cuts the request
   * off, and the view is spared a stale answer. Never for a write (a save the reader
   * started must land whether or not they stayed to watch).
   */
  signal?: AbortSignal;
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

  /** The API's error code (`error` on the body), such as `cursor_ahead`, or null when the
   *  body carried none. */
  get code(): string | null {
    const d = this.data as { error?: unknown } | null;
    return typeof d?.error === "string" ? d.error : null;
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
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body,
    signal: opts.signal,
  });
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

/**
 * The ApiError a non-2xx response stands for, the same from every reader: the server's
 * words from its JSON error body, or, for a body that is not one (a proxy's error page, an
 * empty body), the status text, and the status itself when even that is empty, as it
 * always is over HTTP/2.
 */
async function failure(res: Response): Promise<ApiError> {
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON, so not the API's error body: fall back to the status below.
  }
  // A refused deploy configuration fails every call alike, so it is shown once, full page,
  // rather than as one more failed read.
  const refusal = configRefusal(data);
  if (refusal) {
    showConfigProblem(refusal);
  }
  const fallback = res.statusText || `Request failed (HTTP ${res.status})`;
  return new ApiError(messageOf(data) ?? fallback, res.status, data);
}

/** Call the API and parse its JSON answer (null for an empty body). Throws ApiError on a non-2xx. */
export async function api<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await send(path, opts);
  if (!res.ok) {
    throw await failure(res);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Like api(), but the raw response text, for the endpoints that answer with HTML (the
 * rendered preview). Same 401 guard, which a bare fetch(authHeaders()) would skip.
 */
export async function apiText(path: string, opts: ApiOptions = {}): Promise<string> {
  const res = await send(path, opts);
  if (!res.ok) {
    throw await failure(res);
  }
  return res.text();
}

/** A file the API serves for download: its text, and the name the server gives it in
 *  `Content-Disposition`, if any, so a saved file is named as the server names it. */
export async function apiFile(
  path: string,
  opts: ApiOptions = {},
): Promise<{ text: string; filename: string | null }> {
  const res = await send(path, opts);
  if (!res.ok) {
    throw await failure(res);
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? null;
  return { text: await res.text(), filename };
}
