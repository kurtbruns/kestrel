// The docs as the API carries them (SPEC §5, §11): two sets, one per reader (the publisher's
// Publishing and the operator's Self-hosting), each with its own landing, and every page's
// slug, title, set, section, and the sanitized HTML fragment the Worker rendered from the
// repo's own Markdown, in reading order. The Worker's docs route produces this shape and
// the editor injects the fragments into its own DOM; one definition, so neither can drift.
// The rule that names a heading's anchor lives here too, for the same reason.

/** One section of a set's landing, as its index file lays it out under a `##` heading. */
export interface DocSection {
  /** The heading's anchor, such as `get-started`. */
  id: string;
  title: string;
  /** The paragraph under the heading, as a sanitized HTML fragment; empty when there is none. */
  blurb: string;
  /** Its pages are steps taken in order: the index lists them as a numbered list. */
  numbered: boolean;
}

/** One set of docs, written for one reader, with its own landing read from its index file
 *  (`docs/publishing/README.md`, `docs/README.md`): its H1, the intro under it, and its
 *  sections in order. Its id is also its landing's route, `#/docs/<id>`, so no page's slug
 *  may share it. */
export interface DocSet {
  /** `publishing` or `self-hosting`. */
  id: string;
  /** The set's short name, for the switch between sets: `Publishing`, `Self-hosting`. */
  name: string;
  title: string;
  /** The intro, as a sanitized HTML fragment. */
  intro: string;
  sections: DocSection[];
}

/** One doc as the SPA consumes it: its slug, title, set, section, and a sanitized HTML fragment (no page wrapper). */
export interface DocFragment {
  slug: string;
  title: string;
  /** The `id` of the set it belongs to. */
  set: string;
  /** The `id` of the section it belongs to, within its set. */
  section: string;
  html: string;
}

/** GET /api/docs: the sets, Publishing first, and every doc in reading order, set by set. */
export interface DocsResponse {
  sets: DocSet[];
  docs: DocFragment[];
}

/** A heading's anchor as GitHub derives it from the heading's text: lowercased, with
 *  punctuation dropped and each space a hyphen. The guide is read on GitHub too, so a link
 *  written against GitHub's anchors (`05-verify.md#8-read-the-logs`) works in the editor
 *  unchanged. The editor names its headings by it, and the Worker's suite checks the
 *  editor's links to a heading against it. */
export function headingAnchor(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Each heading's anchor, in document order, as the editor names them: the anchor rule,
 *  with a repeat taking GitHub's -1, -2. One rule for the editor and the suite that checks
 *  links against it. */
export function headingAnchors(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = headingAnchor(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  });
}
