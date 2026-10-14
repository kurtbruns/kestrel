/**
 * The in-app docs: two sets, one per reader. **Publishing** (`docs/publishing/README.md` and
 * its pages) is for the publisher who writes and sends the newsletter; **Self-hosting**
 * (`docs/README.md` and the section folders it lists) is for whoever deploys and runs the
 * instance. The Markdown is bundled into the Worker as Text modules (the `rules` entry in
 * wrangler.jsonc) and served read-only through the authed docs API. The Markdown in `docs/` is
 * the single source of truth — the pages are NOT editable in the app.
 *
 * Each set's index file is its landing page and its table of contents both: its H1 and
 * intro, then a `##` heading per section with a blurb and a list of the section's pages,
 * numbered when they are steps taken in order. The same files are what GitHub shows and what
 * getkestrel.dev builds its docs from, so the order and the sections are written once. The
 * imports below only make each page's Markdown available by its path.
 *
 * Two projections of the same Markdown: a sanitized HTML *fragment* per doc (no page wrapper)
 * that the SPA injects into its own DOM, and the Markdown itself for an agent to read, with
 * its links pointed at the other pages' Markdown routes. The HTML reuses the low-level
 * `markdownToHtml` util plus the HTML hygiene pass. The content is trusted (the repo's own
 * Markdown, hygiene-passed), so injecting the fragments is safe. This is a Markdown→web-page
 * path, deliberately separate from the single Markdown→email render path (I5, see
 * render/render.ts). See docs/SPEC.md §5 / §11.
 */

import { Lexer, type Token, type Tokens } from "marked";
import deploy from "../../docs/get-started/02-deploy.md";
import access from "../../docs/get-started/03-access.md";
import ses from "../../docs/get-started/04-ses.md";
import verify from "../../docs/get-started/05-verify.md";
import goLive from "../../docs/get-started/06-go-live.md";
import connectClaude from "../../docs/guides/01-connect-claude.md";
import notifications from "../../docs/guides/03-notifications.md";
import rateLimit from "../../docs/guides/05-rate-limit.md";
import upgrade from "../../docs/guides/07-upgrade.md";
import tryLocally from "../../docs/guides/08-try-locally.md";
import yourList from "../../docs/publishing/01-your-list.md";
import sendingRules from "../../docs/publishing/02-sending-rules.md";
import nameYourPublication from "../../docs/publishing/03-name-your-publication.md";
import writeAPost from "../../docs/publishing/04-write-a-post.md";
import schedulingAndSending from "../../docs/publishing/05-scheduling-and-sending.md";
import afterASend from "../../docs/publishing/06-after-a-send.md";
import workingWithClaude from "../../docs/publishing/07-working-with-claude.md";
import importFormat from "../../docs/publishing/08-import-format.md";
import shareYourSubscribeLink from "../../docs/publishing/09-share-your-subscribe-link.md";
import checkYourSetup from "../../docs/publishing/10-check-your-setup.md";
import publishingIndex from "../../docs/publishing/README.md";
import selfHostingIndex from "../../docs/README.md";
import configuration from "../../docs/reference/01-configuration.md";
import sendingDomain from "../../docs/reference/02-sending-domain-dns.md";
import {
  type DocFragment,
  type DocSection,
  type DocSet,
  type DocsResponse,
  headingAnchor,
} from "../../shared/docs";
import { markdownToHtml } from "../render/markdown";
import { sanitizeEmailHtml } from "../render/sanitize";

// Each page's Markdown by its path under docs/, the path an index links it by.
const PAGES: Record<string, string> = {
  "publishing/01-your-list.md": yourList,
  "publishing/02-sending-rules.md": sendingRules,
  "publishing/03-name-your-publication.md": nameYourPublication,
  "publishing/04-write-a-post.md": writeAPost,
  "publishing/05-scheduling-and-sending.md": schedulingAndSending,
  "publishing/06-after-a-send.md": afterASend,
  "publishing/07-working-with-claude.md": workingWithClaude,
  "publishing/08-import-format.md": importFormat,
  "publishing/09-share-your-subscribe-link.md": shareYourSubscribeLink,
  "publishing/10-check-your-setup.md": checkYourSetup,
  "get-started/02-deploy.md": deploy,
  "get-started/03-access.md": access,
  "get-started/04-ses.md": ses,
  "get-started/05-verify.md": verify,
  "get-started/06-go-live.md": goLive,
  "guides/01-connect-claude.md": connectClaude,
  "guides/03-notifications.md": notifications,
  "guides/05-rate-limit.md": rateLimit,
  "guides/07-upgrade.md": upgrade,
  "guides/08-try-locally.md": tryLocally,
  "reference/01-configuration.md": configuration,
  "reference/02-sending-domain-dns.md": sendingDomain,
};

// The sets, Publishing first: the editor's Docs tab is read once Kestrel is running, mostly
// by the publisher. Each index's links resolve against the folder it sits in.
const SET_SOURCES: { id: string; name: string; index: string; path: string }[] = [
  { id: "publishing", name: "Publishing", index: publishingIndex, path: "publishing/README.md" },
  { id: "self-hosting", name: "Self-hosting", index: selfHostingIndex, path: "README.md" },
];

// A page's path under docs/: its folder, then the file. The slug is the file's name without
// its NN- prefix, so a link to a page never names its folder.
const PAGE_PATH = /^([a-z0-9-]+)\/\d{2}-([a-z0-9-]+)\.md$/;

/** `href` resolved against the folder of the file at `from` (both relative to docs/), or
 *  null when it climbs out of docs/. */
function resolvePath(from: string, href: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const seg of href.split("/")) {
    if (seg === "..") {
      if (!parts.length) {
        return null;
      }
      parts.pop();
    } else if (seg && seg !== ".") {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

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

interface IndexSection extends Omit<DocSection, "blurb"> {
  blurb: string;
  pages: string[];
}

/** Read an index: the landing's title and intro, its sections, and the pages each one lists,
 *  as paths under docs/, in order. A link to a path no import provides is skipped here; a
 *  spec fails on it. */
function readIndex(
  index: string,
  path: string,
): { title: string; intro: string; sections: IndexSection[] } {
  let title = "";
  let intro = "";
  const sections: IndexSection[] = [];
  for (const t of Lexer.lex(index)) {
    const current = sections[sections.length - 1];
    if (t.type === "heading" && (t as Tokens.Heading).depth === 1) {
      title = (t as Tokens.Heading).text;
    } else if (t.type === "heading" && (t as Tokens.Heading).depth === 2) {
      const text = (t as Tokens.Heading).text;
      sections.push({
        id: headingAnchor(text),
        title: text,
        blurb: "",
        numbered: false,
        pages: [],
      });
    } else if (t.type === "paragraph" && !current) {
      intro += t.raw;
    } else if (t.type === "paragraph" && current && !current.blurb) {
      current.blurb = t.raw;
    } else if (t.type === "list" && current) {
      current.numbered = (t as Tokens.List).ordered;
      for (const href of linksIn([t])) {
        const page = resolvePath(path, href);
        if (page && page in PAGES) {
          current.pages.push(page);
        }
      }
    }
  }
  return { title, intro, sections };
}

const INDEXES = SET_SOURCES.map((s) => ({ ...s, ...readIndex(s.index, s.path) }));

/** The path of every bundled page, for a spec to hold against what the indexes list. */
export function bundledPages(): string[] {
  return Object.keys(PAGES);
}

/** Title = the doc's first `# H1`, so titles live in the source markdown. */
function extractTitle(markdown: string, slug: string): string {
  const m = markdown.match(/^#\s+(.+?)\s*$/m);
  return m?.[1]?.trim() || slug;
}

const DOCS = INDEXES.flatMap((set) =>
  set.sections.flatMap((sec) =>
    sec.pages.flatMap((path) => {
      const slug = path.match(PAGE_PATH)?.[2];
      const markdown = PAGES[path];
      return slug && markdown
        ? [
            {
              slug,
              path,
              set: set.id,
              section: sec.id,
              markdown,
              title: extractTitle(markdown, slug),
            },
          ]
        : [];
    }),
  ),
);

// Where a link between docs lands, by the target's path under docs/: a page by its slug, an
// index by its set's id. Both name a route of the same shape, `#/docs/<name>` in the editor
// and `/api/docs/<name>.md` for an agent, so a set's id never collides with a slug (a spec
// holds that).
const TARGETS = new Map<string, string>([
  ...DOCS.map((d): [string, string] => [d.path, d.slug]),
  ...SET_SOURCES.map((s): [string, string] => [s.path, s.id]),
]);

// The fragment shape lives in shared/ so the editor reads the same definition; re-exported
// here as the guide's own.
export type { DocFragment };

// A relative link to a Markdown file, as the HTML carries it, with its anchor. Written
// relative to the file it sits in so the same file works on GitHub.
const MD_HREF = /href="([^"#:]+\.md)(?:#([^"]*))?"/g;
// A link to a heading on the same page: `[Check it](#check-it)`.
const SAME_PAGE_LINK = /href="#([^"/][^"]*)"/g;

/** Point each link between docs at its in-app route, `#/docs/<slug>`, with its anchor as one
 *  more segment. The room gives each heading GitHub's id for it, so an anchor that works on
 *  GitHub lands on the same heading in the app. A link to a file that is not a doc is left as
 *  written, and a spec catches it. `from` is the linking file's path; `slug` names the page a
 *  same-page link resolves against (a set's index passes the set's id). */
function rewriteDocLinks(html: string, from: string, slug: string): string {
  return html
    .replace(MD_HREF, (whole, href: string, anchor: string | undefined) => {
      const target = TARGETS.get(resolvePath(from, href) ?? "");
      return target ? `href="#/docs/${target}${anchor ? `/${anchor}` : ""}"` : whole;
    })
    .replace(SAME_PAGE_LINK, (_whole, anchor: string) => `href="#/docs/${slug}/${anchor}"`);
}

/** Render Markdown to a sanitized HTML fragment (no page wrapper). Docs carry no post images,
 *  so the image map is empty and the media base is unused. */
function renderFragment(markdown: string, from: string, slug: string): string {
  const warnings: string[] = [];
  const html = markdownToHtml(markdown, {
    images: new Map(),
    mediaBase: "",
    maxWidth: 720,
    warnings,
  });
  return rewriteDocLinks(sanitizeEmailHtml(html), from, slug);
}

/** Each set's landing, from its index: its title, intro, and sections. */
function renderSets(): DocSet[] {
  return INDEXES.map((set) => ({
    id: set.id,
    name: set.name,
    title: set.title,
    // A same-page link in an index resolves against the set's own route, `#/docs/<set>`.
    intro: renderFragment(set.intro, set.path, set.id),
    sections: set.sections.map((sec) => ({
      id: sec.id,
      title: sec.title,
      blurb: sec.blurb ? renderFragment(sec.blurb, set.path, set.id) : "",
      numbered: sec.numbered,
    })),
  }));
}

/** The sets, and every doc in reading order — slug, title, set, section, and rendered
 *  fragment. */
export function renderDocs(): DocsResponse {
  return {
    sets: renderSets(),
    docs: DOCS.map((d) => ({
      slug: d.slug,
      title: d.title,
      set: d.set,
      section: d.section,
      html: renderFragment(d.markdown, d.path, d.slug),
    })),
  };
}

// A relative Markdown link to a Markdown file, `[text](../guides/01-connect-claude.md#x)`.
const MD_LINK = /\]\(([^)\s#:]+\.md)(#[^)\s]*)?\)/g;
// Code, which shows link syntax as written and is never rewritten: a fenced block, or an
// inline span.
const MD_CODE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$|`[^`\n]+`/gm;

/** A doc's Markdown for an agent to read (SPEC §11): a page by its slug, or a set's index by
 *  its id, with its links pointed at the other docs' Markdown routes. Null for a name that is
 *  neither. */
export function docMarkdown(name: string): string | null {
  const doc = DOCS.find((d) => d.slug === name);
  const set = SET_SOURCES.find((s) => s.id === name);
  const from = doc?.path ?? set?.path;
  const markdown = doc?.markdown ?? set?.index;
  return from === undefined || markdown === undefined
    ? null
    : markdownLinksForAgents(markdown, from);
}

/** Point each link to another doc at that doc's own Markdown route, which resolves beside
 *  this one (`connect-claude.md`), so an agent can follow it. `from` is the file's path under
 *  docs/. Code blocks and spans show link syntax as written, so they're left alone. */
export function markdownLinksForAgents(markdown: string, from: string): string {
  const rewrite = (prose: string): string =>
    prose.replace(MD_LINK, (whole, href: string, anchor: string | undefined) => {
      const target = TARGETS.get(resolvePath(from, href) ?? "");
      return target ? `](${target}.md${anchor ?? ""})` : whole;
    });
  let out = "";
  let at = 0;
  for (const m of markdown.matchAll(MD_CODE)) {
    out += rewrite(markdown.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  return out + rewrite(markdown.slice(at));
}
