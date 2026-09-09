/**
 * The in-app operator setup guide: the repo's `docs/setup/*.md`, bundled into
 * the Worker as Text modules (the `rules` entry in wrangler.jsonc) and served
 * read-only through the authed docs API. The markdown in `docs/` is the single
 * source of truth — the pages are NOT editable in the app.
 *
 * Rendering reuses the low-level `markdownToHtml` util plus the HTML hygiene
 * pass; it is Markdown→web-page and stays a separate path from the single
 * Markdown→email render path (I5, see render/render.ts). See docs/SPEC.md §5 for
 * the reader surface and the deployment appendix for the admin surface.
 */
import overview from "../../docs/setup/00-overview.md";
import provision from "../../docs/setup/01-provision.md";
import access from "../../docs/setup/02-access.md";
import emailSender from "../../docs/setup/03-email-sender.md";
import sendingDomain from "../../docs/setup/04-sending-domain-dns.md";
import archiveWebsite from "../../docs/setup/05-archive-website.md";
import verify from "../../docs/setup/06-verify.md";

import { markdownToHtml } from "../render/markdown";
import { sanitizeEmailHtml } from "../render/sanitize";
import { docPage } from "../lib/page";

interface DocSource {
  slug: string;
  markdown: string;
}

// Array order is the reading order of the guide (the nav follows it).
const SOURCES: DocSource[] = [
  { slug: "overview", markdown: overview },
  { slug: "provision", markdown: provision },
  { slug: "access", markdown: access },
  { slug: "email-sender", markdown: emailSender },
  { slug: "sending-domain", markdown: sendingDomain },
  { slug: "archive-website", markdown: archiveWebsite },
  { slug: "verify", markdown: verify },
];

/** Title = the doc's first `# H1`, so titles live in the source markdown. */
function extractTitle(markdown: string, slug: string): string {
  const m = markdown.match(/^#\s+(.+?)\s*$/m);
  return m?.[1]?.trim() || slug;
}

const DOCS = SOURCES.map((s) => ({ ...s, title: extractTitle(s.markdown, s.slug) }));

export interface DocMeta {
  slug: string;
  title: string;
}

/** The guide's table of contents, in reading order. */
export function listDocs(): DocMeta[] {
  return DOCS.map(({ slug, title }) => ({ slug, title }));
}

/**
 * Render one doc to a themed, sanitized HTML page. Returns `undefined` for an
 * unknown slug so the route can answer 404. Docs carry no post images, so the
 * image map is empty and the media base is unused.
 */
export function renderDocPage(slug: string): Response | undefined {
  const doc = DOCS.find((d) => d.slug === slug);
  if (!doc) return undefined;
  const warnings: string[] = [];
  const contentHtml = markdownToHtml(doc.markdown, {
    images: new Map(),
    mediaBase: "",
    maxWidth: 760,
    warnings,
  });
  return docPage(doc.title, sanitizeEmailHtml(contentHtml));
}
