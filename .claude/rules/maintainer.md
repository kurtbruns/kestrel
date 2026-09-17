---
paths:
  - "docs/SPEC.md"
  - "docs/DESIGN.md"
  - "README.md"
  - ".claude/CLAUDE.md"
---

# Maintaining Kestrel's documents

This is the maintainer's contract for Kestrel's four core documents. It says what each one is for, what it must not contain, and when a change to one obligates a change to another. It is guidance rather than a gate: anything that must hold every time belongs in code, a test, or a hook.

## The standard

Each fact sits at the right altitude and lives in one place, and every document is kept in step with the behavior it describes. The prose stays plain and well-structured, and prefers clarity over completeness. No em-dashes. State each document's rationale in its own prose, so it stands on its own; the repository's git history and issues hold the record of how a decision was reached.

## The altitude ladder

Five documents. Each sits at a fixed altitude, and a fact belongs to the one whose height it is written at.

- **`docs/SPEC.md`, the idea.** What Kestrel is and guarantees: the features, the behavior, the invariants, and the publisher's experience. It describes the system, not the code that implements it.
- **`docs/DESIGN.md`, the presentation.** How the admin UI presents that behavior: the button roles, tokens, notification homes, and save models. What each means and which to reach for, one level above the exact CSS.
- **`README.md`, getting started.** What Kestrel is in a paragraph, the prerequisites, and the path to a running instance. It points onward to `.claude/CLAUDE.md` instead of repeating details the codebase keeps changing.
- **`.claude/CLAUDE.md`, the codebase.** How this code is organized and the rules that are not obvious from reading the source. Where implementation detail belongs.
- **`.claude/rules/maintainer.md`, this file.** The rules for keeping the four above at their altitude.

## The rules

1. **Guarantees, not mechanism.** A spec section states what is guaranteed and how the system behaves, never the mechanism that implements it: no endpoints, poll intervals, counter or column names, or storage details, which live in `.claude/CLAUDE.md` and the code.
2. **One home, and the SPEC/DESIGN seam.** Behavior and guarantees live in SPEC; presentation (which control, which token, the layout) lives in DESIGN. A feature with both is split at that seam, and neither doc restates the other.
3. **Self-contained, true rationale.** State the why inline and keep it accurate. Do not rest a decision's justification on something a reader cannot see or check, the way citing a draft that no longer exists does.
4. **One vocabulary, one example set.** The documents share a single glossary (operator versus author, post versus issue) and a single set of example names (hostnames and the like). A rename updates that source; a straggler is drift.

Growth is a signal to re-level a section, not only to add to it. When a section keeps accreting, re-check its altitude rather than continuing to append.

## When to flag instead of edit

If the behavior and a document disagree, one of them is a bug. Do not silently edit the document to match the code, or the code to match the document. Flag it, and let the owner decide which is wrong.
