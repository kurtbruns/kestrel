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

import type { BuildInfo } from "../shared/build";
import { BUILD_INFO } from "./generated/version";

// The shape lives in shared/ so the editor reads the same definition; re-exported here.
export type { BuildInfo };

/** The build stamp plus derived repo links; `""` for any link the stamp can't support. */
export function buildInfo(): BuildInfo {
  const { version, sha, tag, buildTime, repoUrl } = BUILD_INFO;
  return {
    version,
    sha,
    tag,
    buildTime,
    repoUrl,
    // No commit link for a "dev" SHA (no commit to point at) or without a repo.
    commitUrl: repoUrl && sha !== "dev" ? `${repoUrl}/commit/${sha}` : "",
    // Only a build sitting exactly on its release tag links there. Deriving the URL from the
    // version instead would point every in-between build at a tag that isn't cut yet, or at
    // a release it has already moved past.
    tagUrl: repoUrl && tag === `v${version}` ? `${repoUrl}/releases/tag/${tag}` : "",
  };
}
