---
paths:
  - ".claude/CLAUDE.md"
  - ".claude/rules/**/*.md"
---

# Writing Claude's context

`.claude/CLAUDE.md` and the rules under `.claude/rules/` are read by Claude Code, not by a person looking for documentation. CLAUDE.md loads at the start of every session. A rule with `paths` loads when Claude reads a matching file; a rule without `paths` loads at launch like CLAUDE.md. They are context, not configuration: Claude follows them more reliably when they are specific, short, and consistent, and anything that must hold every time belongs in a hook or a test.

## What belongs in CLAUDE.md

Facts Claude needs in every session: the commands, the conventions, the layout, the rules that are not obvious from the code. Add a line when Claude makes the same mistake twice, when a review catches something it should have known, or when you type the same correction into chat that you typed last session. Leave out what Claude can read from the code itself, such as directory listings and dependency lists, and keep what it cannot: pitfalls, rationale, and conventions that differ from the tool defaults.

Something that matters for one part of the codebase goes in a path-scoped rule. A multi-step procedure goes in a skill. A check that must run every time goes in a hook.

## How to write it

- Concrete enough to verify: "run `npm test` before finishing", not "test your changes".
- Under 200 lines per file. Every line costs context in every session it loads.
- Headers and bullets over dense paragraphs.
- One topic per rule file, named for the topic, with `paths` when it applies to part of the tree.
- No contradictions between CLAUDE.md and the rules. When a fact changes, replace the old line rather than adding a correction beside it.
- Style as in `.claude/rules/maintainer.md`.

This distills Anthropic's guidance at https://code.claude.com/docs/en/memory as of September 2026. The page is the current word when the two differ; re-read it when this rule stops matching what Claude Code does.
