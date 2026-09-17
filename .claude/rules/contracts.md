---
paths:
  - "docs/SPEC.md"
  - "docs/DESIGN.md"
  - "README.md"
---

# Writing the contracts (SPEC, DESIGN)

`docs/SPEC.md` and `docs/DESIGN.md` are contracts, not notes. Get them right and implementation flows from them: a reader facing a case the doc never names derives the correct answer from what's already written, instead of re-litigating it. This file is how to keep them that way. It loads when you open these docs; the *trigger* to update them (which change touches which doc) lives in CLAUDE.md, because that has to fire while you're editing code, before you've opened the doc.

## What each one owns — and each fact has one home

- **SPEC governs behavior.** What the system guarantees: the invariants (I1–I6), the model, what each value means, and the source of truth for each fact. It's organized as the questions the system exists to answer.
- **DESIGN governs the admin UI's presentation.** The small shared vocabulary — the roles a control can play, one home per notification kind, one meaning per token, the z-index ladder, the save models, the responsive layout. Its job is to tell the next person *which existing thing to reach for*.
- **Neither owns the mechanism.** The exact declarations, the pixel math, the "why this selector" — those live in the code and its comments.

A fact belongs in exactly one of the three. A fact repeated across two of them is a drift bug — the precise thing the sync rule exists to catch. When you find yourself explaining *how* a thing works in a contract, that's the signal it's a code comment, not a contract line. (This is the mistake to watch for: a rationale that argues for the mechanism — column widths, wrap behavior, why-not-approach-B — is almost always narrating the code.)

## The altitude test

Before a line goes in, ask: **would it have to change if I re-implemented the feature differently but kept the same guarantee?** If yes, it's pitched too low — it's describing the code. Raise it to the guarantee, or move it to a comment.

- State the **rule, not the instance**: "the trouble note lists kinds worst first" is a contract; a specific row's counts are not.
- Don't **narrate a change**: no "we changed X to Y", no issue/PR numbers, no "recently" or "now" — write it forward-looking, as if it had always read this way.
- Put the **rationale inline**: the *why* is what lets the next reader extend the rule to a case you didn't foresee, so it's the most valuable part of a contract — but keep it to the guarantee's rationale, not the implementation's.

## Keep them small

New vocabulary is a smell: reach for an existing role, token, or invariant before adding one, and when none fits, change the contract in the same breath as the code. Most edits should **refine an existing sentence, not append a paragraph** — if a section is growing, look for the sentence that should have changed instead. For each line, ask what CLAUDE.md asks of its own lines: *would removing it let a reader get the behavior or the presentation wrong?* If not, cut it.

Prose is unwrapped — one physical line per paragraph (see CLAUDE.md's comment-&-doc-style section). `README.md` is the user-facing subset of SPEC: keep it in step, but pitched at whoever runs the app, not whoever changes it.
