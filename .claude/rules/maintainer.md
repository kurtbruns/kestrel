---
paths:
  - "docs/SPEC.md"
  - "docs/DESIGN.md"
  - "README.md"
  - ".claude/CLAUDE.md"
---

# Maintaining Kestrel's documents

This rule governs the four documents above, and loads only when you open one of them. It is the maintainer's contract: what each document is for, what it must not contain, and when a change to one obligates a change to another. It shapes behavior; it does not enforce it. Anything that must hold every time belongs in code, a test, or a hook, not here.

## The standard

This project holds its documents to one bar: each fact sits at the right altitude, lives in one place, reads in plain and well-structured language, and never drifts from the behavior it describes. Prefer clarity over completeness. No em-dashes. State rationale inline; do not cite issues, PRs, or drafts.

## The altitude ladder

Five documents. Each sits at a fixed altitude, and a fact belongs to the one whose height it is written at.

- **`docs/SPEC.md`, the idea.** What Kestrel is and guarantees: the features, the behavior, the invariants, and the publisher's experience. It describes the system, not the code that implements it.
- **`docs/DESIGN.md`, the presentation.** How the admin UI presents that behavior: the button roles, tokens, notification homes, and save models. What each means and which to reach for, one level above the exact CSS.
- **`README.md`, getting started.** What Kestrel is in a paragraph, the prerequisites, and the path to a running instance. It points onward to `.claude/CLAUDE.md` instead of repeating details the codebase keeps changing.
- **`.claude/CLAUDE.md`, the codebase.** How this code is organized and the rules that are not obvious from reading the source. Where implementation detail belongs.
- **`.claude/rules/maintainer.md`, this file.** The rules for keeping the four above at their altitude.

## Deciding where a fact goes

- **The greenfield test.** Ask whether a fresh reimplementation of Kestrel would still need the sentence. If it would change when you swap the platform or rename a table, it is written too low for the spec. This is a maintainer's tool, not a promise the product makes, and not language for the copy.
- **Name the reader.** SPEC answers the implementer, DESIGN the UI builder, README the newcomer, CLAUDE.md the contributor. When a fact could sit in two docs, the reader whose question it answers is the tiebreaker.
- **One home per fact.** A fact lives in exactly one document. The others point to it rather than restate it.

## The rules

1. **Guarantees, not mechanism.** A spec section states what is guaranteed and how the system behaves, never the mechanism that implements it. It must not name endpoints, poll intervals, counter or column names, or storage details; those live in `.claude/CLAUDE.md` and the code.
2. **One home, and the SPEC/DESIGN seam.** Behavior and guarantees live in SPEC; presentation (which control, which token, the layout) lives in DESIGN. A feature with both is split at that seam, and neither doc restates the other.
3. **Self-contained, true rationale.** State the why inline and keep it accurate. Never justify a decision by pointing to an artifact a reader cannot see: a past draft, an issue, a PR.
4. **One vocabulary, one example set.** The documents share a single glossary (operator versus author, post versus issue) and a single set of example names (hostnames and the like). A rename updates that source; a straggler is drift.

Growth is a signal to re-level a section, not only to add to it. When a section keeps accreting, re-check its altitude rather than continuing to append.

## When to flag instead of edit

If the behavior and a document disagree, one of them is a bug. Do not silently edit the document to match the code, or the code to match the document. Flag it, and let the owner decide which is wrong.
