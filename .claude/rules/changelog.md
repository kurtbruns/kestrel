---
paths:
  - "CHANGELOG.md"
  - "package.json"
  - "docs/SPEC.md"
  - "docs/DESIGN.md"
  - "README.md"
---

# Keeping Kestrel's changelog

`CHANGELOG.md` is the human-readable record of what changed between releases. It exists so an operator can upgrade their own instance safely, and so getkestrel.dev can pin its docs to a tagged version and see the delta on each bump. It follows [Keep a Changelog](https://keepachangelog.com/), and its versions are `MAJOR.RELEASE.PATCH` (`.claude/rules/release.md`), not semver: the running instance reports its `package.json` version (see the build stamp), so the version people see is the one this file describes.

## Add an entry in the same commit as the change

A user-facing or operator-visible change earns one line under `## [Unreleased]`, written in the same commit that makes the change, by the same in-sync discipline that ties a behavior change to `docs/SPEC.md`. If a change is worth a SPEC or DESIGN edit, it is worth a changelog line.

What earns a line: a change to behavior, the admin UI, the HTTP API surface, configuration, or a bug an operator would notice. What does not: an internal refactor, a test, a build-tooling tweak, a comment, or a formatting pass. When in doubt, ask whether someone running Kestrel would want to know before they upgrade.

A non-blocking `Stop` hook (`.claude/hooks/changelog-reminder.mjs`, wired in `.claude/settings.json`, the repo's only hook) shows the maintainer a reminder in the transcript when a turn ends with code changed and no changelog line. A Stop hook's message reaches the person, not the model. It is a nudge, never a gate: it cannot block a turn, and an internal-only change correctly gets no entry.

## How to write the line

- **Section.** Group under `Added`, `Changed`, `Fixed`, or `Breaking`. A `Breaking` entry means the next release can't be a patch.
- **Level.** One line, written for the person running Kestrel: what changed for them, not the mechanism. Cite a `docs/SPEC.md` section if it helps; never a file or symbol.
- **Voice.** Match the entries already there. No PR or issue numbers (the repo's comment style keeps those out of prose).
- **Upgrade steps go once.** What an operator must do to upgrade (apply a migration, add a setting, rebuild a local database) lives in the *Upgrading* paragraph at the top of the release, never on an entry, so a later entry added above or below can't strand a pointer to it. A change that adds a step updates that paragraph in the same commit.
- **The operator's Claude context.** A change to `template/claude/` (the context `kestrel init` writes into an instance) gets a line saying what changed in it and why, since an operator who edited theirs merges it by hand. A change that bears on safety, such as a new caution, says so in the line.
- **One story, one line.** When a later change reworks something already under `[Unreleased]`, edit that line rather than adding a second one that half-contradicts it. `[Unreleased]` describes the release as it will ship, not the order the work landed in.

## Cutting a release

How and when to cut one, from the version bump to the docs site and the demo, is `.claude/rules/release.md`.
