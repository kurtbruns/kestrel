// The running build's identity, as the Worker reflects it (GET /api/version and the
// settings surface, SPEC §9) and the editor shows it. Build metadata only, never config.

export interface BuildInfo {
  /** package.json version, e.g. `0.1.0`. */
  version: string;
  /** Short git SHA, or `dev` when git was unavailable at build. */
  sha: string;
  /** The tag on the built commit itself (e.g. `v0.1.0`), or `""`; most builds aren't a release. */
  tag: string;
  /** ISO 8601 build timestamp. */
  buildTime: string;
  /** Browsable repository URL, or `""` when unknown. */
  repoUrl: string;
  /** The commit page for this build (`{repoUrl}/commit/{sha}`), or `""` when unknown. */
  commitUrl: string;
  /** The release page for this build (`{repoUrl}/releases/tag/{tag}`), or `""` when it isn't one. */
  tagUrl: string;
}
