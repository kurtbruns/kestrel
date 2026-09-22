// The setup guide as the API carries it (SPEC §5, §11): each doc's slug, title, and the
// sanitized HTML fragment the Worker rendered from the repo's own Markdown, in reading
// order. The Worker's docs route produces this shape and the editor injects the fragments
// into its own DOM; one definition, so neither can drift.

/** One doc as the SPA consumes it: its slug, title, and a sanitized HTML fragment (no page wrapper). */
export interface DocFragment {
  slug: string;
  title: string;
  html: string;
}

/** GET /api/docs: the whole guide, in reading order. */
export interface DocsResponse {
  docs: DocFragment[];
}
