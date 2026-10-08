# Maintaining Kestrel

You are **maintaining Kestrel itself**, the upstream project, not running an instance of it. `.claude/CLAUDE.md` above is the context Kestrel ships to whoever runs an instance. Treat it as a product you maintain, not as instructions about this session: keep it true to what the setup guide teaches and the app does, and mention a skill there only once it exists.

The code's own context, `.claude/rules/code.md`, loads when you read the code, as it does for anyone. This file adds how a change to Kestrel lands. Read `.claude/maintainer/guide.md` before you write or change a page of the setup guide (`docs/README.md`, `docs/get-started/`, `docs/guides/`, `docs/reference/`, or `src/docs/`), and `.claude/rules/context.md` before you change `.claude/CLAUDE.md`.

## How a change lands

- **The documents move with the code.** A change to what the system does, or how the admin UI presents it, changes the governing document in the same commit: behavior and guarantees in `docs/SPEC.md`, the API's shape (a new wire field, header, error code, or way of reading) in `docs/API.md`, admin-UI presentation in `docs/DESIGN.md`, and `README.md` when whoever runs the app would see it. A change to what an operator does checks `.claude/CLAUDE.md`, which mirrors the guide.
- **So does the changelog.** A user-facing or operator-visible change earns its `CHANGELOG.md` line in the same commit (below).
- **Land a pull request by squash,** one gated commit with the PR's title and description as its message. Rebase-merge a branch whose commits were shaped on purpose (each coherent, with its own message, no sync merges). A merge commit only when a branch's merges cannot be replayed and its commits are worth keeping anyway, since it puts every sync merge into `main` forever. A stack is a review shape, not a merge shape: land it in order, squash each, and rebase the next onto the new `main`.
- **Rewrite a GitHub issue's body** when the user asks you to change what it asks for, instead of adding a comment, since whoever picks it up often reads only the body. Work the change in where it belongs rather than appending, with no "Updated:" line; GitHub keeps the edit history.

## The documents

Kestrel's documents are part of how it is built. This is guidance rather than a gate: anything that must hold every time belongs in code, a test, or a hook.

### Levels of abstraction

Kestrel is built in levels of abstraction, and is kept that way. Each level is precise at its own height and hides the decisions beneath it. The spec says what is guaranteed and nothing about how. The API route table describes the surface and behavior of the application and leaves the functions, comments, and lines of code beneath it out of view. The documents are the upper levels; the code is the rest. A fact belongs at the level where it is precise, and a change starts at the highest level it touches and is carried down. The documents, from the top:

- **`docs/SPEC.md`, the idea.** What Kestrel guarantees: the features, the behavior, the invariants, and the publisher's experience. The system, not the code that implements it.
- **`docs/API.md`, the shape of the API.** The rules every route follows: how a resource is read, followed, acted on, and refused, and the test a new wire concept must pass. It sits between the spec's guarantees and the generated API reference, which lists each route; it names concepts, never a route's every field.
- **`docs/DESIGN.md`, the presentation.** How the admin UI presents that behavior: the button roles, tokens, notification homes, and save models. What each means and which to reach for, one level above the exact CSS.
- **`README.md`, getting started.** What Kestrel is in a paragraph, the prerequisites, and the path to a running instance. It points onward to `.claude/rules/code.md` and `.claude/maintainer/README.md` instead of repeating details the codebase keeps changing.
- **`CHANGELOG.md`, the record.** What changed between releases, one line per change, for the person deciding whether to upgrade. It cuts across the levels instead of sitting at one.
- **The code.** Everything beneath the documents, from the API route table down to the line. Every guarantee above has to land here. `.claude/rules/code.md` describes this level: how the code is organized, the rules that are not obvious from reading it, and how its comments are written.

### Keeping each at its height

1. **Guarantees, not mechanism.** A spec section states what is guaranteed and how the system behaves, never the mechanism that implements it: no endpoints, poll intervals, counter or column names, or storage details. Those live in `.claude/rules/code.md` and the code.
2. **Behavior in SPEC, presentation in DESIGN.** SPEC says what the system does; DESIGN says which control, which token, and what layout show it. A feature with both is split at that seam, and neither document restates the other. The same seam runs between SPEC and API: SPEC says what both clients can rely on, API says the shape they rely on it through.
3. **Rationale that stands on its own.** State the why inline and keep it accurate. Do not rest a decision on something the reader cannot see or check, the way citing a draft that no longer exists does. The git history and the issues hold the record of how a decision was reached; the document holds the decision and its reason.
4. **One vocabulary, one example set.** The documents share a single glossary (publisher versus developer) and a single set of example names (hostnames and the like). A rename updates the source; a straggler is drift. The newsletter entity is a **post**, and "issue" is reserved for the GitHub tracker: it never names a post, nor a delivery failure, which is a **bounce**, a **complaint**, or an **unsent** recipient.

When a section keeps growing, check whether its facts still sit at its height before appending more. When a document and the code disagree, one of them is a bug: do not silently edit either to match the other. Flag it, and let the owner decide which is wrong.

### Style

Clear, well-written prose that defaults to simple language, reaching for a technical term only when it is the precise one. No em-dashes. When a sentence has one, rewrite it, and the paragraph around it if that helps, into its best form. The comment and Markdown conventions in `.claude/rules/code.md` apply to these documents too.

## The changelog

`CHANGELOG.md` is the human-readable record of what changed between releases. It exists so an operator can upgrade their own instance safely, and so getkestrel.dev can pin its docs to a tagged version and see the delta on each bump. It follows [Keep a Changelog](https://keepachangelog.com/), and its versions are `MAJOR.RELEASE.PATCH` (below), not semver: the running instance reports its `package.json` version (see the build stamp), so the version people see is the one this file describes.

### When a change earns a line

A user-facing or operator-visible change earns one line under `## [Unreleased]`, written in the same commit that makes the change. If a change is worth a SPEC or DESIGN edit, it is worth a changelog line. What earns a line: a change to behavior, the admin UI, the HTTP API surface, configuration, or a bug an operator would notice. What does not: an internal refactor, a test, a build-tooling tweak, a comment, or a formatting pass. When in doubt, ask whether someone running Kestrel would want to know before they upgrade.

A non-blocking `Stop` hook (`.claude/hooks/changelog-reminder.mjs`, wired in `.claude/settings.json`, the repo's only hook) shows the maintainer a reminder in the transcript when a turn ends with code changed and no changelog line. A Stop hook's message reaches the person, not the model. It is a nudge, never a gate, and it runs only with this frame on, so an operator changing their own copy is never nudged.

### How to write the line

- **Section.** Group under `Added`, `Changed`, `Fixed`, or `Breaking`. A `Breaking` entry means the next release can't be a patch.
- **Level.** One line, written for the person running Kestrel: what changed for them, not the mechanism. Cite a `docs/SPEC.md` section if it helps; never a file or symbol.
- **Voice.** Match the entries already there. No PR or issue numbers.
- **Upgrade steps go once.** What an operator must do to upgrade (apply a migration, add a setting, rebuild a local database) lives in the *Upgrading* paragraph at the top of the release, never on an entry, so a later entry added above or below can't strand a pointer to it. A change that adds a step updates that paragraph in the same commit.
- **One story, one line.** When a later change reworks something already under `[Unreleased]`, edit that line rather than adding a second one that half-contradicts it. `[Unreleased]` describes the release as it will ship, not the order the work landed in.

### Cutting a release

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

**Which number.** Pick it against the last tag. Versions are `MAJOR.RELEASE.PATCH`, not semver: Kestrel is an app its operators upgrade, so the changelog, not the number, says what breaks.

- **Major:** only when the maintainer decides (a rewrite, or an upgrade that can't be made in one step), never because of a `Breaking` entry. It resets the other two: `1.4.2` → `2.0.0`.
- **Release:** any release with more than fixes, breaking changes included: `1.1.0` → `1.2.0`.
- **Patch:** fixes only: `1.2.0` → `1.2.1`. Never a feature or a `Breaking` entry.
