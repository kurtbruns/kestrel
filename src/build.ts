/**
 * Build metadata, surfaced read-only to the admin surface and API (SPEC §9).
 *
 * The raw stamp (version, short SHA, tag, commit time, source URL) is resolved at build into
 * the gitignored `src/generated/version.ts` by `scripts/stamp-version.mjs`. This module puts
 * it in its wire shape, so the `GET /api/version` route and the settings `deployment`
 * reflection share one source and can't drift. The pages a build links to are not on the
 * wire: a client derives them (`shared/build.ts`). It is deliberately NOT deploy
 * config or a runtime preference: it never passes through `getConfig` or the settings
 * surface, and it is independent of the D1 schema version and the post-revision token.
 */

import type { BuildInfo } from "../shared/build";
import { BUILD_INFO } from "./generated/version";

// The shape lives in shared/ so the editor reads the same definition; re-exported here.
export type { BuildInfo };

/** The build stamp in its wire shape; `""` for what the build couldn't know. */
export function buildInfo(): BuildInfo {
  const { version, sha, tag, commitTime, sourceUrl } = BUILD_INFO;
  return { version, sha, tag, commit_time: commitTime, source_url: sourceUrl };
}
