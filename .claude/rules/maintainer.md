---
paths:
  - "docs/SPEC.md"
  - "docs/API.md"
  - "docs/DESIGN.md"
  - "README.md"
  - "CONTRIBUTING.md"
  - "CHANGELOG.md"
  - ".claude/CLAUDE.md"
---

# Maintaining Kestrel's documents

Kestrel's documents are part of how it is built, and this file is the contract for maintaining them: what each one is for, what it must not contain, and when a change to one obligates a change to another. This is guidance rather than a gate: anything that must hold every time belongs in code, a test, or a hook.

## Levels of abstraction

Kestrel is built in levels of abstraction, and is kept that way. Each level is precise at its own height and hides the decisions beneath it. The spec says what is guaranteed and nothing about how. The API route table describes the surface and behavior of the application and leaves the functions, comments, and lines of code beneath it out of view. The documents are the upper levels; the code is the rest. A fact belongs at the level where it is precise, and a change starts at the highest level it touches and is carried down. The documents, from the top:

- **`docs/SPEC.md`, the idea.** What Kestrel guarantees: the features, the behavior, the invariants, and the publisher's experience. The system, not the code that implements it.
- **`docs/API.md`, the shape of the API.** The rules every route follows: how a resource is read, followed, acted on, and refused, and the test a new wire concept must pass. It sits between the spec's guarantees and the generated API reference, which lists each route; it names concepts, never a route's every field.
- **The API reference, the API as its clients read it.** Generated from the route registration in `src/app.ts` and from `src/reference/`: the topics every route shares (`concepts.ts`, API.md's rules in the words a client needs), each object field by field (`objects.ts`), and the refusal codes (`refusals.ts`). The editor shows it in its API tab and Claude reads it as Markdown at `/api/reference.md`. Claude never reads API.md, so for Claude as a client this is the contract, and a rule in API.md that a client must follow reaches Claude only once it is here.
- **`docs/DESIGN.md`, the presentation.** How the admin UI presents that behavior: the principles behind it, a map of its screens, how a send reads across them, and the shared vocabulary (where messages go, saving, button roles, color, layout, copy, accessibility). What each means and which to reach for, one level above the exact CSS.
- **`README.md`, getting started.** The package's front page on npm and GitHub, for someone deciding whether to run Kestrel: what it is in a paragraph, trying it locally, and the path to a running instance. Working on Kestrel's own source is `CONTRIBUTING.md`, which points onward to `.claude/CLAUDE.md` instead of repeating details the codebase keeps changing.
- **`CHANGELOG.md`, the record.** What changed between releases, one line per change, for the person deciding whether to upgrade. It cuts across the levels instead of sitting at one. `.claude/rules/changelog.md` says what earns a line, how it is written, and when a release is cut.
- **The code.** Everything beneath the documents, from the API route table down to the line. Every guarantee above has to land here. `.claude/CLAUDE.md` describes this level: how the code is organized, the rules that are not obvious from reading it, and how its comments are written.
- **Claude's context, two sets.** `.claude/CLAUDE.md` and `.claude/rules/` are the maintainer's: how to work on Kestrel. `template/claude/` is the operator's: how Claude runs an instance and publishes through its API, written into each instance by `kestrel init` and the operator's own from then on, so a fix to it reaches an instance only when its operator merges it (`kestrel check-context` reports the change). It restates API rules by their wire names, so it is a copy of the reference that nothing checks. `.claude/rules/context.md` says how both are written.

Beside these sit the docs in `docs/README.md` and its section folders, held by `.claude/rules/docs.md`. The publisher's pages (`docs/publishing/`) describe the app as the publisher meets it, so they sit below SPEC and DESIGN and restate neither: what the system does comes from SPEC, and the names of screens and buttons from DESIGN and the UI, worded for someone who has never read either. A change that alters what a publisher does or sees changes the page in the same commit. A publisher page may also carry what no other document holds, such as which law asks what of a newsletter, as long as it cites its source.

This file holds the rules for keeping them at their height.

## What else moves when one changes

A change starts at the highest level it touches, and everything below that restates it moves in the same commit. Most of these links are kept by hand, so this table is the lookup: find the row, change what it names, and check the last column for what will catch a miss.

| You change | Also change in the same commit | What catches a miss |
| --- | --- | --- |
| A guarantee or behavior | `docs/SPEC.md` first, then the code and a test whose title cites the section. API.md, DESIGN, and the docs pages wherever they describe it. | Tests, by convention: nothing lists a SPEC promise with no test. |
| A rule of the API's shape | `docs/API.md`, and `src/reference/concepts.ts` where a client must follow it. | Nothing. |
| A refusal code or its status | `src/reference/refusals.ts`, API.md's Refusing table, and each route that gives it. | `test/reference.spec.ts`: the codes, statuses, and next moves must match the table. |
| A route, field, or object | Its entry in `src/app.ts`, its wire type in `shared/`, and its object in `src/reference/objects.ts`. API.md only for a new rule or kind of concept. | The generated reference and its OpenAPI document, and the examples typed against the wire types. |
| A wire name, renamed | Every copy made by hand: `template/claude/` (context and skills), `docs/publishing/` and the setup guide, API.md, DESIGN, and a Breaking line in the changelog. Grep those paths for the old name. | Nothing. A stale name in `template/claude/` ships into every new instance. |
| How the editor presents something | `docs/DESIGN.md`, and the docs page that names that screen or label. | `test/docs.spec.ts`, only for links and the headings the editor links to. |
| A docs page, or a docs index | The index that lists it, and any editor link to its headings. getkestrel.dev parses the indexes (`.claude/rules/docs.md`). | `test/docs.spec.ts`. |
| `template/claude/` | A changelog line saying what changed and why. | `kestrel check-context`, on each instance at upgrade. |
| Anything a publisher or operator would notice | A line under `[Unreleased]` (`.claude/rules/changelog.md`). | The Stop hook's reminder, which never blocks. |
| The release itself | `.claude/rules/release.md` (policy) and the `release` skill (procedure). | `publish.yml` re-runs the gate before npm. |

## The rules

1. **Guarantees, not mechanism.** A spec section states what is guaranteed and how the system behaves, never the mechanism that implements it: no endpoints, poll intervals, counter or column names, or storage details. Those live in `.claude/CLAUDE.md` and the code.
2. **Behavior in SPEC, presentation in DESIGN.** SPEC says what the system does; DESIGN says which control, which token, and what layout show it. A feature with both is split at that seam, and neither document restates the other. The same seam runs between SPEC and API: SPEC says what both clients can rely on, API says the shape they rely on it through.
3. **Rationale that stands on its own.** State the why inline and keep it accurate. Do not rest a decision on something the reader cannot see or check, the way citing a draft that no longer exists does. The git history and the issues hold the record of how a decision was reached; the document holds the decision and its reason.
4. **One vocabulary, one example set.** The documents share a single glossary (publisher versus developer) and a single set of example names (hostnames and the like). A rename updates the source; a straggler is drift. The newsletter entity is a **post**, and "issue" is reserved for the GitHub tracker: it never names a post, nor a delivery failure, which is a **bounce**, a **complaint**, or an **unsent** recipient.

When a section keeps growing, check whether its facts still sit at its height before appending more.

## When a document and the code disagree

Every document is kept in step with the behavior it describes, so when they disagree, one of them is a bug. Do not silently edit the document to match the code, or the code to match the document. Flag it, and let the owner decide which is wrong.

## Style

Clear, well-written prose that defaults to simple language, reaching for a technical term only when it is the precise one. No em-dashes. When a sentence has one, rewrite it, and the paragraph around it if that helps, into its best form. The comment and Markdown conventions in `.claude/CLAUDE.md` apply to these documents too.
