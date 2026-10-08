/**
 * The in-app setup guide: the repo's `docs/README.md` and the section folders it lists,
 * bundled into the Worker as Text modules (the `rules` entry in wrangler.jsonc) and served
 * read-only through the authed docs API. The markdown in `docs/` is the single source of
 * truth — the pages are NOT editable in the app.
 *
 * `docs/README.md` is the landing page and the table of contents both: its H1 and intro,
 * then a `##` heading per section with a blurb and a list of the section's pages, numbered
 * when they are steps taken in order. The same file is what GitHub shows for the folder and
 * what getkestrel.dev builds its docs landing from, so the order and the sections are
 * written once. The imports below only make each page's Markdown available by its path.
 *
 * Rendering reuses the low-level `markdownToHtml` util plus the HTML hygiene
 * pass, and returns a sanitized HTML *fragment* per doc (no page wrapper): the
 * SPA injects the guide directly into its own DOM as one native scrollable page
 * with a scroll-spy contents rail (no iframe). The content is trusted (the repo's
 * own markdown, hygiene-passed), so injecting the fragments is safe. This is a
 * Markdown→web-page path, deliberately separate from the single Markdown→email
 * render path (I5, see render/render.ts). See docs/SPEC.md §5 / §11.
 */

import { Lexer, type Token, type Tokens } from "marked";
import overview from "../../docs/get-started/01-overview.md";
import deploy from "../../docs/get-started/02-deploy.md";
import access from "../../docs/get-started/03-access.md";
import resend from "../../docs/get-started/04-resend.md";
import verify from "../../docs/get-started/05-verify.md";
import goLive from "../../docs/get-started/06-go-live.md";
import connectClaude from "../../docs/guides/01-connect-claude.md";
import ses from "../../docs/guides/02-ses.md";
import notifications from "../../docs/guides/03-notifications.md";
import rateLimit from "../../docs/guides/05-rate-limit.md";
import upgrade from "../../docs/guides/07-upgrade.md";
import readme from "../../docs/README.md";
import configuration from "../../docs/reference/01-configuration.md";
import sendingDomain from "../../docs/reference/02-sending-domain-dns.md";
import type { DocFragment, DocSection, DocsLanding, DocsResponse } from "../../shared/docs";
import { markdownToHtml } from "../render/markdown";
import { sanitizeEmailHtml } from "../render/sanitize";

// Each page's Markdown by its path under docs/, the path the README links it by.
const PAGES: Record<string, string> = {
  "get-started/01-overview.md": overview,
  "get-started/02-deploy.md": deploy,
  "get-started/03-access.md": access,
  "get-started/04-resend.md": resend,
  "get-started/05-verify.md": verify,
  "get-started/06-go-live.md": goLive,
  "guides/01-connect-claude.md": connectClaude,
  "guides/02-ses.md": ses,
  "guides/03-notifications.md": notifications,
  "guides/05-rate-limit.md": rateLimit,
  "guides/07-upgrade.md": upgrade,
  "reference/01-configuration.md": configuration,
  "reference/02-sending-domain-dns.md": sendingDomain,
};

// A page's path under docs/: its section's folder, then the file. The slug is the file's
// name without its NN- prefix, so a link to a page never names its section.
const PAGE_PATH = /^([a-z0-9-]+)\/\d{2}-([a-z0-9-]+)\.md$/;

/** Every link in a token tree, in document order. */
function linksIn(tokens: Token[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tokens ?? []) {
    if (t.type === "link") {
      out.push((t as Tokens.Link).href);
    }
    const nested = t as { tokens?: Token[]; items?: Token[] };
    out.push(...linksIn(nested.tokens), ...linksIn(nested.items));
  }
  return out;
}

interface DocSource {
  slug: string;
  section: string;
  markdown: string;
}

/** Read the README: the landing's title and intro, its sections, and the pages each one
 *  lists, in order. A link to a path no import provides is skipped here; a spec fails on it. */
function readIndex(readme: string): {
  title: string;
  intro: string;
  sections: (Omit<DocSection, "id"> & { pages: string[] })[];
} {
  let title = "";
  let intro = "";
  const sections: (Omit<DocSection, "id"> & { pages: string[] })[] = [];
  for (const t of Lexer.lex(readme)) {
    const current = sections[sections.length - 1];
    if (t.type === "heading" && (t as Tokens.Heading).depth === 1) {
      title = (t as Tokens.Heading).text;
    } else if (t.type === "heading" && (t as Tokens.Heading).depth === 2) {
      sections.push({ title: (t as Tokens.Heading).text, blurb: "", numbered: false, pages: [] });
    } else if (t.type === "paragraph" && !current) {
      intro += t.raw;
    } else if (t.type === "paragraph" && current && !current.blurb) {
      current.blurb = t.raw;
    } else if (t.type === "list" && current) {
      current.numbered = (t as Tokens.List).ordered;
      current.pages.push(...linksIn([t]).filter((href) => href in PAGES));
    }
  }
  return { title, intro, sections };
}

const INDEX = readIndex(readme);

/** The path of every bundled page, for a spec to hold against what the README lists. */
export function bundledPages(): string[] {
  return Object.keys(PAGES);
}

const SOURCES: DocSource[] = INDEX.sections.flatMap((sec) =>
  sec.pages.flatMap((path) => {
    const m = path.match(PAGE_PATH);
    const markdown = PAGES[path];
    return m?.[1] && m[2] && markdown ? [{ slug: m[2], section: m[1], markdown }] : [];
  }),
);

/** Title = the doc's first `# H1`, so titles live in the source markdown. */
function extractTitle(markdown: string, slug: string): string {
  const m = markdown.match(/^#\s+(.+?)\s*$/m);
  return m?.[1]?.trim() || slug;
}

const SLUGS = new Set(SOURCES.map((s) => s.slug));

const DOCS = SOURCES.map((s) => ({ ...s, title: extractTitle(s.markdown, s.slug) }));

// The fragment shape lives in shared/ so the editor reads the same definition; re-exported
// here as the guide's own.
export type { DocFragment };

// A link from one guide page to another, as the Markdown writes it so it also works on
// GitHub: a relative path to the file, `02-deploy.md` or `../guides/02-ses.md`, maybe with
// an anchor. Captures the slug (the file name without its NN- prefix) and the anchor.
const DOC_LINK = /href="(?:\.\.\/[a-z-]+\/|[a-z-]+\/)?\d{2}-([a-z0-9-]+)\.md(?:#([^"]*))?"/g;
// A link to a heading on the same page: `[Check it](#check-it)`.
const SAME_PAGE_LINK = /href="#([^"/][^"]*)"/g;

/** Point each link between guide pages at the doc's in-app route, `#/docs/<slug>`, with
 *  its anchor as one more segment. The room gives each heading GitHub's id for it, so an
 *  anchor that works on GitHub lands on the same heading in the app. A link to a file that
 *  is not a doc is left as written, and a spec catches it. */
function rewriteDocLinks(html: string, slug: string): string {
  return html
    .replace(DOC_LINK, (whole, target: string, anchor: string | undefined) =>
      SLUGS.has(target) ? `href="#/docs/${target}${anchor ? `/${anchor}` : ""}"` : whole,
    )
    .replace(SAME_PAGE_LINK, (_whole, anchor: string) => `href="#/docs/${slug}/${anchor}"`);
}

/** Render one doc's markdown to a sanitized HTML fragment (no page wrapper). Docs
 *  carry no post images, so the image map is empty and the media base is unused. A link
 *  to a heading on the same page resolves against `slug`; the landing has none, so passes
 *  the empty slug. */
function renderFragment(markdown: string, slug: string): string {
  const warnings: string[] = [];
  const html = markdownToHtml(markdown, {
    images: new Map(),
    mediaBase: "",
    maxWidth: 720,
    warnings,
  });
  return rewriteDocLinks(sanitizeEmailHtml(html), slug);
}

/** The landing page, from the README: its title, intro, and sections. A section's id is
 *  the folder its pages live in (a spec holds each section to one folder). */
function renderLanding(): DocsLanding {
  return {
    title: INDEX.title,
    intro: renderFragment(INDEX.intro, ""),
    sections: INDEX.sections.map((sec) => ({
      id: sec.pages[0]?.match(PAGE_PATH)?.[1] ?? "",
      title: sec.title,
      blurb: sec.blurb ? renderFragment(sec.blurb, "") : "",
      numbered: sec.numbered,
    })),
  };
}

/** The landing page, and the whole guide in reading order — slug, title, section, and
 *  rendered fragment. */
export function renderDocs(): DocsResponse {
  return {
    landing: renderLanding(),
    docs: DOCS.map((d) => ({
      slug: d.slug,
      title: d.title,
      section: d.section,
      html: renderFragment(d.markdown, d.slug),
    })),
  };
}
