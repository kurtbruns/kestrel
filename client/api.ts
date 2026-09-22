// @ts-nocheck
// The one network seam: every call to the HTTP API goes through api() / apiText(),
// which attach the credential and route a 401 to re-auth.

import { authHeaders } from "./auth";
import { showReauth } from "./build_ref";

export async function api(path, opts = {}) {
  const headers = Object.assign(authHeaders(), opts.headers || {});
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401) {
    showReauth();
    throw new Error("Not authorized — please sign in again.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || res.statusText);
    err.status = res.status; // callers (e.g. the editor's conflict handling) branch on this
    err.data = data;
    throw err;
  }
  return data;
}

// Like api(), but returns the raw response text instead of parsing JSON — for the
// endpoints that answer with HTML (the rendered preview). Keeps the same 401 →
// re-auth guard, which a bare fetch(authHeaders()) would skip.
export async function apiText(path, opts = {}) {
  const headers = Object.assign(authHeaders(), opts.headers || {});
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401) {
    showReauth();
    throw new Error("Not authorized — please sign in again.");
  }
  if (!res.ok) {
    const err = new Error(res.statusText);
    err.status = res.status;
    throw err;
  }
  return res.text();
}
