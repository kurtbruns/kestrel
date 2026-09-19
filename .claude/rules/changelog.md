---
paths:
  - "CHANGELOG.md"
  - "package.json"
  - "docs/SPEC.md"
  - "docs/DESIGN.md"
  - "README.md"
---

# Keeping Kestrel's changelog

`CHANGELOG.md` is the human-readable record of what changed between releases. It exists so an operator can upgrade their own instance safely, and so getkestrel.dev can pin its docs to a tagged version and see the delta on each bump. It follows [Keep a Changelog](https://keepachangelog.com/) and [semver](https://semver.org/): the running instance reports its `package.json` version (see the build stamp), so the version people see is the one this file describes.

## Add an entry in the same commit as the change

A user-facing or operator-visible change earns one line under `## [Unreleased]`, written in the same commit that makes the change — the same in-sync discipline that ties a behavior change to `docs/SPEC.md`. If a change is worth a SPEC or DESIGN edit, it is worth a changelog line.

What earns a line: a change to behavior, the admin UI, the HTTP API surface, configuration, or a bug an operator would notice. What does not: an internal refactor, a test, a build-tooling tweak, a comment, or a formatting pass. When in doubt, ask whether someone running Kestrel would want to know before they upgrade.

## How to write the line

- **Section.** Group under `Added`, `Changed`, `Fixed`, or `Breaking`. A `Breaking` entry also decides the next release is a major bump.
- **Altitude.** One line, written for the person running Kestrel: what changed for them, not the mechanism. Cite a `docs/SPEC.md` section if it helps; never a file or symbol.
- **Voice.** Match the entries already there. No PR or issue numbers (the repo's comment style keeps those out of prose).

## Cutting a release

A release is cut by the maintainer, by hand, on `main` after the change has merged (a tag on a feature branch would point at the wrong commit):

1. Rename `## [Unreleased]` to `## [X.Y.Z] - <date>` and add a fresh, empty `## [Unreleased]` above it.
2. Bump `version` in `package.json` to `X.Y.Z`.
3. Update the link references at the bottom of `CHANGELOG.md` (`[Unreleased]` compare, new `[X.Y.Z]` tag).
4. Commit, then `git tag -a vX.Y.Z -m "kestrel vX.Y.Z"` and `git push --tags`.

Pick the number by semver against the last tag: a `Breaking` entry forces a major bump; new features are a minor bump; fixes alone are a patch.
