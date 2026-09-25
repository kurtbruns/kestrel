---
paths:
  - "CHANGELOG.md"
  - "package.json"
  - "docs/SPEC.md"
  - "docs/DESIGN.md"
  - "README.md"
---

# Keeping Kestrel's changelog

`CHANGELOG.md` is the human-readable record of what changed between releases. It exists so an operator can upgrade their own instance safely, and so getkestrel.dev can pin its docs to a tagged version and see the delta on each bump. It follows [Keep a Changelog](https://keepachangelog.com/), and its versions are `MAJOR.RELEASE.PATCH` (below), not semver: the running instance reports its `package.json` version (see the build stamp), so the version people see is the one this file describes.

## Add an entry in the same commit as the change

A user-facing or operator-visible change earns one line under `## [Unreleased]`, written in the same commit that makes the change, by the same in-sync discipline that ties a behavior change to `docs/SPEC.md`. If a change is worth a SPEC or DESIGN edit, it is worth a changelog line.

What earns a line: a change to behavior, the admin UI, the HTTP API surface, configuration, or a bug an operator would notice. What does not: an internal refactor, a test, a build-tooling tweak, a comment, or a formatting pass. When in doubt, ask whether someone running Kestrel would want to know before they upgrade.

A non-blocking `Stop` hook (`.claude/hooks/changelog-reminder.mjs`, wired in `.claude/settings.json`, the repo's only hook) shows the maintainer a reminder in the transcript when a turn ends with code changed and no changelog line. A Stop hook's message reaches the person, not the model. It is a nudge, never a gate: it cannot block a turn, and an internal-only change correctly gets no entry.

## How to write the line

- **Section.** Group under `Added`, `Changed`, `Fixed`, or `Breaking`. A `Breaking` entry means the next release can't be a patch.
- **Level.** One line, written for the person running Kestrel: what changed for them, not the mechanism. Cite a `docs/SPEC.md` section if it helps; never a file or symbol.
- **Voice.** Match the entries already there. No PR or issue numbers (the repo's comment style keeps those out of prose).
- **Upgrade steps go once.** What an operator must do to upgrade (apply a migration, add a setting, rebuild a local database) lives in the *Upgrading* paragraph at the top of the release, never on an entry, so a later entry added above or below can't strand a pointer to it. A change that adds a step updates that paragraph in the same commit.
- **One story, one line.** When a later change reworks something already under `[Unreleased]`, edit that line rather than adding a second one that half-contradicts it. `[Unreleased]` describes the release as it will ship, not the order the work landed in.

## Cutting a release

**When.** Kestrel is self-hosted, so a release is not tied to any one deploy: operators upgrade on their own schedule, and what the maintainer controls is what `[Unreleased]` would hand them. Cut a release when `[Unreleased]` holds something an operator would want to upgrade for (a feature, or a fix they would notice), and promptly after a `Breaking` line lands, so the break ships under its own version instead of riding a later one. Between releases every build still identifies itself: the build stamp carries the version and the commit, so a build off `main` is never mistaken for the release before it.

**How.** A release is cut by the maintainer, by hand. The edit below can land through a pull request like any other change; the tag goes on `main` once it is there (a tag on a feature branch would point at the wrong commit), and the GitHub release follows the tag:

1. Rename `## [Unreleased]` to `## [X.Y.Z] - <date>` and add a fresh, empty `## [Unreleased]` above it.
2. Run `npm version X.Y.Z --no-git-tag-version`, which bumps `package.json` and `package-lock.json` together without committing or tagging.
3. Update the link references at the bottom of `CHANGELOG.md` (`[Unreleased]` compare, new `[X.Y.Z]` tag).
4. Commit, then `git tag -a vX.Y.Z -m "kestrel vX.Y.Z"` and `git push origin vX.Y.Z` (that tag alone, not `--tags`, which would push every local tag).
5. Publish the GitHub release from the tag, with that version's section of the changelog as its notes, so the release page (the one the changelog's version links and the build stamp point at) says what changed instead of showing a bare tag:

   ```bash
   awk '/^## \[X.Y.Z\]/{f=1;next} /^## \[|^\[.*\]: /{f=0} f' CHANGELOG.md | gh release create vX.Y.Z --verify-tag --title "kestrel vX.Y.Z" --notes-file -
   ```

   A tag and a release are separate objects: pushing the tag alone leaves the Releases page empty. The notes are the changelog section verbatim, so the two never say different things, and `--verify-tag` refuses to run before the tag is on the remote, so a release can never mint its own tag at the wrong commit.

Pick the number against the last tag. Versions are `MAJOR.RELEASE.PATCH`, not semver: Kestrel is an app its operators upgrade, so the changelog, not the number, says what breaks.

- **Major:** only when the maintainer decides (a rewrite, or an upgrade that can't be made in one step), never because of a `Breaking` entry. It resets the other two: `1.4.2` → `2.0.0`.
- **Release:** any release with more than fixes, breaking changes included: `1.1.0` → `1.2.0`.
- **Patch:** fixes only: `1.2.0` → `1.2.1`. Never a feature or a `Breaking` entry.
