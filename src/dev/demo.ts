/**
 * The demo publication's content: the Markdown files under `demo/`, bundled into the
 * Worker as Text modules (the `rules` entry in wrangler.jsonc) and read by the dev seed.
 *
 * Each file opens with a small front-matter block of `key: value` lines. The reader here
 * is deliberately tiny (no dependency): it knows every key a demo file may carry and
 * fails loud on anything else, so a typo in a post's front matter stops the seed with
 * the file's name instead of seeding a post that quietly lost a field. The order of
 * the posts in `loadDemo` is the order the posts appear in the dashboard's history: sent posts take
 * the seed timeline's completed sends oldest first, in the order they are listed.
 */

import hunter from "../../demo/posts/1-the-hovering-hunter/index.md";
import oldFashionedList from "../../demo/posts/2-an-old-fashioned-list/index.md";
import publishing from "../../demo/posts/3-publishing/index.md";
import robots from "../../demo/posts/4-working-with-robots/index.md";
import quickNote from "../../demo/posts/5-a-quick-note/index.md";
import tryEditing from "../../demo/posts/6-try-editing-this-draft/index.md";
import ideas from "../../demo/posts/7-ideas-for-next-month/index.md";
import publicationFile from "../../demo/publication.md";

export type DemoPostStatus = "sent" | "scheduled" | "draft";

export interface DemoPost {
  /** The file it came from, for error messages. */
  file: string;
  /** The post's folder under `demo/posts` (a page bundle: `index.md` plus its images). */
  bundle: string;
  subject: string;
  slug: string;
  status: DemoPostStatus;
  markdown: string;
  /** The images the post shows by a bare filename (`![…](kestrel.webp)`): files beside its
   *  `index.md` in its bundle, which the seed uploads and attaches to this post. */
  images: string[];
  /** Drafts only: how many days ago the draft was last edited. */
  editedDaysAgo?: number;
}

export interface DemoPublication {
  name: string;
  tagline: string;
  address: string;
  testRecipients: string[];
}

/** Split a file into its front-matter fields and the body after them. */
export function parseFrontMatter(
  file: string,
  text: string,
): { fields: Map<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) {
    throw new Error(`${file}: expected a front-matter block between --- lines at the top`);
  }
  const fields = new Map<string, string>();
  for (const line of (m[1] ?? "").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) {
      throw new Error(`${file}: front-matter line is not "key: value": ${line}`);
    }
    const [, key = "", value = ""] = kv;
    if (fields.has(key)) {
      throw new Error(`${file}: front-matter key "${key}" appears twice`);
    }
    fields.set(key, value.trim());
  }
  return { fields, body: (m[2] ?? "").trim() };
}

/** Read the named keys, refusing a missing required key or any key not named. */
function readFields(
  file: string,
  fields: Map<string, string>,
  required: readonly string[],
  optional: readonly string[],
): Record<string, string | undefined> {
  for (const key of fields.keys()) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(`${file}: unknown front-matter key "${key}"`);
    }
  }
  const out: Record<string, string | undefined> = {};
  for (const key of required) {
    const value = fields.get(key);
    if (!value) {
      throw new Error(`${file}: front matter is missing "${key}"`);
    }
    out[key] = value;
  }
  for (const key of optional) {
    out[key] = fields.get(key);
  }
  return out;
}

const STATUSES: readonly DemoPostStatus[] = ["sent", "scheduled", "draft"];

/** The bare filenames a post's Markdown shows as images. A URL or a path isn't one of the
 *  demo's own files, so only a plain name (no scheme, no slash) counts. */
export function postImages(markdown: string): string[] {
  const names = [...markdown.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)].map((m) => m[1] ?? "");
  return [...new Set(names.filter((n) => n && !n.includes("/") && !n.includes(":")))];
}

/** Parse one demo post: the `index.md` of the bundle folder `bundle`. */
export function parseDemoPost(bundle: string, text: string): DemoPost {
  const file = `demo/posts/${bundle}/index.md`;
  const { fields, body } = parseFrontMatter(file, text);
  const f = readFields(file, fields, ["subject", "slug", "status"], ["edited"]);
  const status = f.status as DemoPostStatus;
  if (!STATUSES.includes(status)) {
    throw new Error(`${file}: status must be sent, scheduled, or draft, not "${f.status}"`);
  }
  let editedDaysAgo: number | undefined;
  if (f.edited != null) {
    const days = /^(\d+) days? ago$/.exec(f.edited);
    if (!days || status !== "draft") {
      throw new Error(`${file}: "edited" is for drafts, written like "2 days ago"`);
    }
    editedDaysAgo = Number(days[1]);
  }
  if (!body) {
    throw new Error(`${file}: the post has no body`);
  }
  return {
    file,
    bundle,
    subject: f.subject ?? "",
    slug: f.slug ?? "",
    status,
    markdown: body,
    images: postImages(body),
    ...(editedDaysAgo != null ? { editedDaysAgo } : {}),
  };
}

/** Parse the publication identity file. */
export function parseDemoPublication(file: string, text: string): DemoPublication {
  const { fields } = parseFrontMatter(file, text);
  // `logo` names the image `scripts/seed.mjs` uploads; the worker only needs to accept it.
  const f = readFields(file, fields, ["name", "tagline", "test_recipients"], ["address", "logo"]);
  return {
    name: f.name ?? "",
    tagline: f.tagline ?? "",
    address: f.address ?? "",
    testRecipients: (f.test_recipients ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** The demo publication, parsed when the seed runs. Parsed on demand, never at import:
 *  this module ships in every bundle, and a broken demo file must fail the seed, not the
 *  Worker's startup. */
export function loadDemo(): { publication: DemoPublication; posts: DemoPost[] } {
  const posts = [
    ["1-the-hovering-hunter", hunter],
    ["2-an-old-fashioned-list", oldFashionedList],
    ["3-publishing", publishing],
    ["4-working-with-robots", robots],
    ["5-a-quick-note", quickNote],
    ["6-try-editing-this-draft", tryEditing],
    ["7-ideas-for-next-month", ideas],
  ].map(([bundle, text]) => parseDemoPost(bundle ?? "", text ?? ""));
  return {
    publication: parseDemoPublication("demo/publication.md", publicationFile),
    posts,
  };
}
