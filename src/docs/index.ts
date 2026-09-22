/**
 * The in-app setup guide: the repo's `docs/setup/*.md`, bundled into
 * the Worker as Text modules (the `rules` entry in wrangler.jsonc) and served
 * read-only through the authed docs API. The markdown in `docs/` is the single
 * source of truth — the pages are NOT editable in the app.
 *
 * Rendering reuses the low-level `markdownToHtml` util plus the HTML hygiene
 * pass, and returns a sanitized HTML *fragment* per doc (no page wrapper): the
 * SPA injects the guide directly into its own DOM as one native scrollable page
 * with a scroll-spy contents rail (no iframe). The content is trusted (the repo's
 * own markdown, hygiene-passed), so injecting the fragments is safe. This is a
 * Markdown→web-page path, deliberately separate from the single Markdown→email
 * render path (I5, see render/render.ts). See docs/SPEC.md §5 / §11.
 */
import overview from "../../docs/setup/00-overview.md";
import provision from "../../docs/setup/01-provision.md";
import access from "../../docs/setup/02-access.md";
import emailSender from "../../docs/setup/03-email-sender.md";
import sendingDomain from "../../docs/setup/04-sending-domain-dns.md";
import archiveWebsite from "../../docs/setup/05-archive-website.md";
import verify from "../../docs/setup/06-verify.md";
import connectClaude from "../../docs/setup/07-connect-claude.md";
import type { DocFragment } from "../../shared/docs";
import { markdownToHtml } from "../render/markdown";
import { sanitizeEmailHtml } from "../render/sanitize";

interface DocSource {
  slug: string;
  markdown: string;
}

// Array order is the reading order of the guide (the contents rail follows it).
const SOURCES: DocSource[] = [
  { slug: "overview", markdown: overview },
  { slug: "provision", markdown: provision },
  { slug: "access", markdown: access },
  { slug: "email-sender", markdown: emailSender },
  { slug: "sending-domain", markdown: sendingDomain },
  { slug: "archive-website", markdown: archiveWebsite },
  { slug: "verify", markdown: verify },
  { slug: "connect-claude", markdown: connectClaude },
];

/** Title = the doc's first `# H1`, so titles live in the source markdown. */
function extractTitle(markdown: string, slug: string): string {
  const m = markdown.match(/^#\s+(.+?)\s*$/m);
  return m?.[1]?.trim() || slug;
}

const DOCS = SOURCES.map((s) => ({ ...s, title: extractTitle(s.markdown, s.slug) }));

// The fragment shape lives in shared/ so the editor reads the same definition; re-exported
// here as the guide's own.
export type { DocFragment };

/** Render one doc's markdown to a sanitized HTML fragment (no page wrapper). Docs
 *  carry no post images, so the image map is empty and the media base is unused. */
function renderFragment(markdown: string): string {
  const warnings: string[] = [];
  const html = markdownToHtml(markdown, {
    images: new Map(),
    mediaBase: "",
    maxWidth: 720,
    warnings,
  });
  return sanitizeEmailHtml(html);
}

/** The whole guide, in reading order — slug, title, and rendered fragment. */
export function renderDocs(): DocFragment[] {
  return DOCS.map((d) => ({ slug: d.slug, title: d.title, html: renderFragment(d.markdown) }));
}
