/** What a public reader page says about itself to search engines and link previews (SPEC §5):
 *  the description and Open Graph tags in its <head>, built only from words the publisher
 *  already wrote (the publication's name, tagline, and logo, and a post's subject and opening
 *  text). No setting of its own feeds them, and a tag whose source is empty is left out. */
import { escapeHtmlAttr } from "./html";

/** About as much as a search result or a link preview shows before cutting it off itself. */
export const DESCRIPTION_MAX = 160;

/** The sources of one page's tags. `url` and `image` are absolute public addresses, or absent
 *  when the page has none to give: a page reached only by a secret link names no address. */
export interface PageDescription {
  type: "website" | "article";
  title: string;
  description: string;
  url?: string;
  image?: string;
}

/** The tags for a page's <head>, each with its value escaped as an attribute. `twitter:card`
 *  rides along because some clients read only it before showing a card at all; the rest of a
 *  card they take from the Open Graph tags. */
export function describeHead(d: PageDescription): string {
  const tags: string[] = [];
  const meta = (attr: "name" | "property", key: string, value: string | undefined) => {
    if (value) {
      tags.push(`<meta ${attr}="${key}" content="${escapeHtmlAttr(value)}">`);
    }
  };
  meta("name", "description", d.description);
  meta("property", "og:type", d.type);
  meta("property", "og:title", d.title);
  meta("property", "og:description", d.description);
  meta("property", "og:url", d.url);
  meta("property", "og:image", d.image);
  if (d.title || d.description) {
    meta("name", "twitter:card", "summary");
  }
  return tags.join("");
}

/** Where the plain-text part's footer starts: render.ts closes the post's text with a blank
 *  line and a line holding only a dash, then the footer (the "view in browser" link, which is
 *  the post's unlisted link, and the unsubscribe slot). Every send ever frozen has it. */
const TEXT_FOOTER_RULE = "\n\n—\n";

/** A line that is only images, as the plain text gives them ("[alt]"). */
const IMAGES_ONLY = /^(?:\[[^\]]*\]\s*)+$/;

/** A link's address, as the plain text puts it after the link's words: " (https://…)". */
const LINK_ADDRESS = /\s?\((?:[a-z][a-z0-9+.-]*:|\/|#)\S*\)/gi;

/** A line that already ends a sentence or clause, so the next one follows after a space. */
const ENDS_CLAUSE = /[.!?…:;,)\]"'”’»]$/;

/**
 * A post's description: its opening text as readers received it, from the send's frozen
 * plain-text part (so no second render, I5), shortened to about `DESCRIPTION_MAX` characters.
 * Only prose is kept: the footer is cut (it carries the unlisted link), and so are a first line
 * that repeats the subject, a line of nothing but images, a link's address after its words, and
 * a list item's dash. A line that doesn't end in punctuation, such as a heading, is joined to
 * the next by a dash so the two don't run together. "" when no prose is left.
 */
export function postDescription(frozenText: string, subject: string): string {
  const end = frozenText.lastIndexOf(TEXT_FOOTER_RULE);
  const body = end === -1 ? frozenText : frozenText.slice(0, end);
  const lines = body
    .split("\n")
    .map((l) =>
      l
        .replace(LINK_ADDRESS, "")
        .replace(/^\s*-\s+/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((l) => l !== "" && !IMAGES_ONLY.test(l));
  if (lines[0] !== undefined && sameWords(lines[0], subject)) {
    lines.shift();
  }
  let text = "";
  for (const line of lines) {
    text = text === "" ? line : `${text}${ENDS_CLAUSE.test(text) ? " " : " — "}${line}`;
    if (text.length > DESCRIPTION_MAX * 2) {
      break;
    }
  }
  return shorten(text, DESCRIPTION_MAX);
}

function sameWords(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

/** `text` cut to at most `max` characters at a word boundary, ending in an ellipsis when cut. A
 *  single word longer than half the limit is cut mid-word rather than leave almost nothing. */
export function shorten(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) {
    return text;
  }
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  const cut = space > head.length / 2 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:—–-]+$/, "")}…`;
}
