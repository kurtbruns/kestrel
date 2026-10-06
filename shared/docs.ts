// The setup guide as the API carries it (SPEC §5, §11): its landing page, and each doc's
// slug, title, section, and the sanitized HTML fragment the Worker rendered from the
// repo's own Markdown, in reading order. The Worker's docs route produces this shape and
// the editor injects the fragments into its own DOM; one definition, so neither can drift.

/** One section of the guide, as `docs/README.md` lays it out under a `##` heading. */
export interface DocSection {
  /** The folder its pages live in, such as `get-started`. */
  id: string;
  title: string;
  /** The paragraph under the heading, as a sanitized HTML fragment; empty when there is none. */
  blurb: string;
  /** Its pages are steps taken in order: the README lists them as a numbered list. */
  numbered: boolean;
}

/** The guide's landing page, read from `docs/README.md`: its H1, the intro under it, and
 *  its sections in order. The same file is the folder's index on GitHub. */
export interface DocsLanding {
  title: string;
  /** The intro, as a sanitized HTML fragment. */
  intro: string;
  sections: DocSection[];
}

/** One doc as the SPA consumes it: its slug, title, section, and a sanitized HTML fragment (no page wrapper). */
export interface DocFragment {
  slug: string;
  title: string;
  /** The `id` of the section it belongs to. */
  section: string;
  html: string;
}

/** GET /api/docs: the landing page, and the whole guide in reading order. */
export interface DocsResponse {
  landing: DocsLanding;
  docs: DocFragment[];
}
