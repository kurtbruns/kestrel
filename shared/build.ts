// The running build's identity, as the Worker reflects it (GET /api/version and the
// settings surface, SPEC §9) and the editor shows it, plus the one rule for the pages a
// build links to. Build metadata only, never config. It names the release and commit an
// instance runs, never when or where it was built.

export interface BuildInfo {
  /** package.json version, e.g. `0.1.0`; a fork marks itself with build metadata (`0.1.0+myfork`). */
  version: string;
  /** Short git SHA, or `dev` when git was unavailable at build. */
  sha: string;
  /** The tag on the built commit itself (e.g. `v0.1.0`), or `""`; most builds aren't a release. */
  tag: string;
  /** ISO 8601 committer time of the built commit, or `""` when git was unavailable at build. */
  commit_time: string;
  /** Browsable URL of the source this build came from, or `""` when unknown. */
  source_url: string;
}

/**
 * The commit page for a build, or `""` when there is none to point at: no source, or a
 * `dev` SHA, which names no commit.
 */
export function buildCommitUrl(build: Pick<BuildInfo, "sha" | "source_url">): string {
  return build.source_url && build.sha !== "dev" ? `${build.source_url}/commit/${build.sha}` : "";
}

/**
 * The release page for a build, or `""` when it isn't one. Only a build sitting exactly on
 * its own version's tag links there: deriving the page from the version instead would point
 * every in-between build at a tag that isn't cut yet, or at a release it has moved past.
 */
export function buildReleaseUrl(build: Pick<BuildInfo, "version" | "tag" | "source_url">): string {
  return build.source_url && build.tag === `v${build.version}`
    ? `${build.source_url}/releases/tag/${build.tag}`
    : "";
}
