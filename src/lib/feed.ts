/**
 * The archive's feed (SPEC §5): the posts the archive index lists, newest first, as an RSS 2.0
 * document a feed reader follows. Each item carries the post in full, as HTML, the way
 * newsletter feeds do, from the send's frozen web copy, which the one render made beside the
 * email (I3, I5), never a second rendering of the post. A send frozen before the web copy was
 * kept gives its frozen plain text instead, one paragraph per block, so every listed post is
 * in the feed. Built only from what the publisher already wrote, like the reader pages'
 * descriptions.
 */
import { escapeHtml, escapeHtmlAttr } from "./html";

/** How many posts the feed carries: the newest, as newsletter feeds do, so a reader's first
 *  fetch brings recent posts and the document stays small however long the archive grows. */
export const FEED_ITEM_LIMIT = 20;

/** One post as the feed gives it. */
export interface FeedItem {
  title: string;
  /** The post's archive address, also its permanent id: a sent post's slug never changes. */
  url: string;
  publishedAt: number;
  /** The short summary a reader shows in its list (the post page's description). */
  summary: string;
  /** The post in full, as HTML. */
  contentHtml: string;
}

export interface FeedChannel {
  title: string;
  description: string;
  /** The archive index, the page the feed mirrors. */
  link: string;
  /** The feed's own address, which a reader re-fetches. */
  self: string;
  logoUrl?: string;
  items: FeedItem[];
}

/**
 * Characters XML 1.0 forbids anywhere in a document. One in a post would make the whole feed
 * unreadable to a reader that parses strictly, so it is dropped from every value.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the control characters XML forbids is the point.
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** A value as XML element text: forbidden characters dropped, markup escaped. */
function xmlText(s: string): string {
  return escapeHtml(s.replace(XML_FORBIDDEN, ""));
}

/** A value as an XML attribute. */
function xmlAttr(s: string): string {
  return escapeHtmlAttr(s.replace(XML_FORBIDDEN, ""));
}

/** The frozen plain text as simple HTML, for a send with no web copy: each block a paragraph,
 *  its line breaks kept, everything escaped, so it reads as the plain-text email does. */
export function plainTextAsHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== "")
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function rssFeed(channel: FeedChannel): string {
  const image = channel.logoUrl
    ? `<image><url>${xmlText(channel.logoUrl)}</url><title>${xmlText(channel.title)}</title><link>${xmlText(channel.link)}</link></image>`
    : "";
  const items = channel.items.map(
    (i) =>
      `<item>` +
      `<title>${xmlText(i.title)}</title>` +
      `<link>${xmlText(i.url)}</link>` +
      `<guid isPermaLink="true">${xmlText(i.url)}</guid>` +
      `<pubDate>${new Date(i.publishedAt).toUTCString()}</pubDate>` +
      `<description>${xmlText(i.summary)}</description>` +
      `<content:encoded>${xmlText(i.contentHtml)}</content:encoded>` +
      `</item>`,
  );
  const latest = channel.items[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title>${xmlText(channel.title)}</title>
<link>${xmlText(channel.link)}</link>
<description>${xmlText(channel.description)}</description>
<atom:link href="${xmlAttr(channel.self)}" rel="self" type="application/rss+xml"/>
${latest ? `<lastBuildDate>${new Date(latest.publishedAt).toUTCString()}</lastBuildDate>\n` : ""}${image}
${items.join("\n")}
</channel>
</rss>
`;
}
