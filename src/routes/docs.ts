/**
 * In-app operator setup guide, served read-only to the admin surface. Authed
 * exactly like the rest of the authoring API (mounted under `/api` in app.ts),
 * so the SPA's bearer/Access-JWT fetch reaches it in both dev and prod. The
 * content is bundled from docs/ (see src/docs/index.ts) — nothing is editable.
 *
 *   GET /api/docs        → the table of contents (JSON)
 *   GET /api/docs/:slug  → one doc, rendered as a themed HTML page
 */

import { listDocs, renderDocPage } from "../docs";
import { json, notFound } from "../lib/errors";
import type { RequestContext } from "../router";
import { param } from "../router";

export function list(_c: RequestContext): Response {
  return json({ docs: listDocs() });
}

export function get(c: RequestContext): Response {
  const res = renderDocPage(param(c, "slug"));
  if (!res) {
    throw notFound("doc");
  }
  return res;
}
