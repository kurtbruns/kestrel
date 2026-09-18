/**
 * Build metadata, surfaced read-only to the admin surface and API (SPEC §9).
 *
 * The raw stamp (version, short SHA, build time, repo URL) is resolved at build into the
 * gitignored `src/generated/version.ts` by `scripts/stamp-version.mjs`. This module adds
 * the derived commit/tag links so the `GET /api/version` route and the settings
 * `deployment` reflection share one source and can't drift. It is deliberately NOT deploy
 * config or a runtime preference: it never passes through `getConfig` or the settings
 * surface, and it is independent of the D1 schema version and the post-revision token.
 */

import { BUILD_INFO } from "./generated/version";

export interface BuildInfo {
  /** package.json version, e.g. `0.1.0`. */
  version: string;
  /** Short git SHA, or `dev` when git was unavailable at build. */
  sha: string;
  /** ISO 8601 build timestamp. */
  buildTime: string;
  /** Browsable repository URL, or `""` when unknown. */
  repoUrl: string;
  /** The commit page for this build (`{repoUrl}/commit/{sha}`), or `""` when unknown. */
  commitUrl: string;
  /** The release/tag page for this version (`{repoUrl}/releases/tag/v{version}`), or `""`. */
  tagUrl: string;
}

/** The build stamp plus derived repo links; `""` for any link the stamp can't support. */
export function buildInfo(): BuildInfo {
  const { version, sha, buildTime, repoUrl } = BUILD_INFO;
  return {
    version,
    sha,
    buildTime,
    repoUrl,
    // No commit link for a "dev" SHA (no commit to point at) or without a repo.
    commitUrl: repoUrl && sha !== "dev" ? `${repoUrl}/commit/${sha}` : "",
    tagUrl: repoUrl ? `${repoUrl}/releases/tag/v${version}` : "",
  };
}
