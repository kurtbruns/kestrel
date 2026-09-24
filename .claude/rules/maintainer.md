---
paths:
  - "docs/SPEC.md"
  - "docs/API.md"
  - "docs/DESIGN.md"
  - "README.md"
  - "CHANGELOG.md"
  - ".claude/CLAUDE.md"
---

# Maintaining Kestrel's documents

Kestrel's documents are part of how it is built, and this file is the contract for maintaining them: what each one is for, what it must not contain, and when a change to one obligates a change to another. This is guidance rather than a gate: anything that must hold every time belongs in code, a test, or a hook.

## Levels of abstraction

Kestrel is built in levels of abstraction, and is kept that way. Each level is precise at its own height and hides the decisions beneath it. The spec says what is guaranteed and nothing about how. The API route table describes the surface and behavior of the application and leaves the functions, comments, and lines of code beneath it out of view. The documents are the upper levels; the code is the rest. A fact belongs at the level where it is precise, and a change starts at the highest level it touches and is carried down. The documents, from the top:

- **`docs/SPEC.md`, the idea.** What Kestrel guarantees: the features, the behavior, the invariants, and the publisher's experience. The system, not the code that implements it.
- **`docs/API.md`, the shape of the API.** The rules every route follows: how a resource is read, followed, acted on, and refused, and the test a new wire concept must pass. It sits between the spec's guarantees and the generated API reference, which lists each route; it names concepts, never a route's every field.
- **`docs/DESIGN.md`, the presentation.** How the admin UI presents that behavior: the button roles, tokens, notification homes, and save models. What each means and which to reach for, one level above the exact CSS.
- **`README.md`, getting started.** What Kestrel is in a paragraph, the prerequisites, and the path to a running instance. It points onward to `.claude/CLAUDE.md` instead of repeating details the codebase keeps changing.
- **`CHANGELOG.md`, the record.** What changed between releases, one line per change, for the person deciding whether to upgrade. It cuts across the levels instead of sitting at one. `.claude/rules/changelog.md` says what earns a line, how it is written, and when a release is cut.
- **The code.** Everything beneath the documents, from the API route table down to the line. Every guarantee above has to land here. `.claude/CLAUDE.md` describes this level: how the code is organized, the rules that are not obvious from reading it, and how its comments are written.

This file holds the rules for keeping them at their height.

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
