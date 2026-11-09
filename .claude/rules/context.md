---
paths:
  - ".claude/CLAUDE.md"
  - ".claude/rules/**/*.md"
  - "template/claude/**"
---

# Writing Claude's context

`.claude/CLAUDE.md`, the rules under `.claude/rules/`, and the operator context an instance starts with (`template/claude/`, which `kestrel init` writes to the instance's `.claude/`) are read by Claude Code, not by a person looking for documentation. CLAUDE.md loads at the start of every session. A rule with `paths` loads when Claude reads a matching file; a rule without `paths` loads at launch like CLAUDE.md. They are context, not configuration: Claude follows them more reliably when they are specific, short, and consistent, and anything that must hold every time belongs in a hook or a test.

## What belongs in CLAUDE.md

Facts Claude needs in every session: the commands, the conventions, the module boundaries, the rules that are not obvious from the code. Add a line when Claude makes the same mistake twice, when a review catches something it should have known, when you type the same correction into chat that you typed last session, or when a new teammate would need the same context. Leave out what Claude can read from the code itself, such as directory listings, the file layout, and dependency lists, and keep what it cannot: pitfalls, places where the code is misleading, decisions the repository doesn't record, rationale, and conventions that differ from the tool defaults.

Something that matters for one part of the codebase goes in a path-scoped rule. A multi-step procedure goes in a skill. A check that must run every time goes in a hook.

A path-scoped rule is invisible to a session that never opens a matching file, such as one planning from issues and milestones. When a fact from a scoped rule is needed to plan or decide, state the fact in CLAUDE.md in a sentence and leave the full rule where it is.

## How to write it

- Concrete enough to verify: "run `npm test` before finishing", not "test your changes".
- Under 200 lines per file. Every line costs context in every session it loads.
- Headers and bullets over dense paragraphs.
- Plain wording, with no IMPORTANT or capitals for emphasis: current models follow a plain line and over-apply an emphasized one. A line that keeps being missed means the file is too long, or the rule belongs in a hook.
- One topic per rule file, named for the topic, with `paths` when it applies to part of the tree.
- No contradictions between CLAUDE.md and the rules. When a fact changes, replace the old line rather than adding a correction beside it. `/doctor prompt-audit`, run in an interactive session, reports contradictions, references to files that no longer exist, and wording written for older models.
- Style as in `.claude/rules/maintainer.md`.

This distills Anthropic's guidance at https://code.claude.com/docs/en/memory and https://code.claude.com/docs/en/best-practices as of November 2026. Those pages are the current word when the two differ; re-read them when this rule stops matching what Claude Code does.
