/**
 * In-app docs (the publisher's pages and the setup guide), served read-only to the admin
 * surface. Authed exactly like the rest of the authoring API (mounted under `/api` in app.ts),
 * so the SPA's bearer/Access-JWT fetch reaches it in both dev and prod, and Claude's service
 * token reaches it too. The content is bundled from docs/ (see src/docs/index.ts) — nothing
 * is editable.
 *
 *   GET /api/docs           → the two sets and every doc as sanitized HTML fragments, in
 *                             reading order (JSON). The SPA renders them natively.
 *   GET /api/docs/:name.md  → one doc's Markdown, or a set's index by its id, for an agent.
 */

import { docMarkdown, renderDocs } from "../docs";
import { json, notFound } from "../lib/errors";
import { param, type RequestContext } from "../router";

export function list(_c: RequestContext): Response {
  return json(renderDocs());
}

export function markdown(c: RequestContext): Response {
  const body = docMarkdown(param(c, "name"));
  if (body === null) {
    throw notFound("doc");
  }
  return markdownResponse(body);
}

/** A Markdown document as a response, for the routes that serve one to an agent. */
export function markdownResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
