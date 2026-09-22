/**
 * In-app setup guide, served read-only to the admin surface. Authed
 * exactly like the rest of the authoring API (mounted under `/api` in app.ts),
 * so the SPA's bearer/Access-JWT fetch reaches it in both dev and prod. The
 * content is bundled from docs/ (see src/docs/index.ts) — nothing is editable.
 *
 *   GET /api/docs → the whole guide as sanitized HTML fragments, in reading order
 *                   (JSON). The SPA renders them natively with a scroll-spy rail.
 */

import type { DocsResponse } from "../../shared/docs";
import { renderDocs } from "../docs";
import { json } from "../lib/errors";
import type { RequestContext } from "../router";

export function list(_c: RequestContext): Response {
  const body: DocsResponse = { docs: renderDocs() };
  return json(body);
}
