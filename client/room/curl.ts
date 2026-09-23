// The curl command the API reference offers for a route: the method, the URL on this
// instance, the credential headers its tier needs, and the example body when it has one.

import type { ReferenceEntry } from "../../shared/reference";

/** How this instance authenticates the admin tier, as the boot probe reported it. */
export type AuthMode = "access" | "dev";

/**
 * The credential headers an admin call carries: the Access service token's pair once
 * deployed (the names the setup guide uses), or the dev token locally (as in the README).
 */
function authLines(mode: AuthMode): string[] {
  return mode === "access"
    ? [
        '-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"',
        '-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"',
      ]
    : ['-H "Authorization: Bearer $TOKEN"'];
}

/**
 * The route's path as a URL path to type: the pattern syntax a URL never carries (a
 * parameter's regex, an optional segment) is dropped, and `:id`-style parameters stay as
 * the placeholders to replace. The reference shows its rows this way too.
 */
export function concretePath(path: string): string {
  return path.replace(/\([^)]*\)/g, "").replace(/\{[^}]*\}\??/g, "") || "/";
}

/**
 * A copy-paste curl command for a route on this instance, or null for a webhook, which
 * only the email provider can call (it must carry the provider's signature).
 */
export function curlCommand(r: ReferenceEntry, origin: string, mode: AuthMode): string | null {
  if (r.access === "webhook") {
    return null;
  }
  // A query parameter the route can't do without rides the URL, as a placeholder like a path's.
  const required = (r.query ?? []).filter((q) => q.required);
  const search = required.length ? `?${required.map((q) => `${q.name}=:${q.name}`).join("&")}` : "";
  const url = `"${origin}${concretePath(r.path)}${search}"`;
  const lines = [r.method === "GET" ? `curl ${url}` : `curl -X ${r.method} ${url}`];
  if (r.access === "admin") {
    lines.push(...authLines(mode));
  }
  if (r.example?.request !== undefined) {
    // Single-quoted for the shell, so a quote inside the JSON closes, escapes, and reopens.
    const body = JSON.stringify(r.example.request).replaceAll("'", `'\\''`);
    lines.push('-H "Content-Type: application/json"', `-d '${body}'`);
  }
  return lines.join(" \\\n  ");
}
