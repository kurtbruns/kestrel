---
paths:
  - ".claude/rules/**/*.md"
  - ".claude/maintainer/**"
---

# Writing Claude's context

Kestrel's Claude context is read by Claude Code, not by a person looking for documentation. It comes in three layers, each loading only for the people who need it:

- **Running the instance: `.claude/CLAUDE.md`.** Loads at the start of every session, for everyone. Most people who clone Kestrel deploy and publish with their own copy, so this is their context: following the setup guide, deploying and upgrading, reaching the API, and the safety lines.
- **Changing the code: `.claude/rules/`.** `code.md` and `client.md` are scoped by `paths` to the code, so they load once Claude reads it: for an operator adding a feature to their copy, a contributor, or the maintainer. A rule loads when Claude reads a matching file, not only when it edits one, so no rule here may match a file the setup guide sends an operator to (a guide page, `CHANGELOG.md`, `README.md`, `wrangler.jsonc`, `package.json`).
- **Maintaining Kestrel: `.claude/maintainer/`.** How a change to the upstream project lands. `frame.md` loads only through a gitignored `CLAUDE.local.md` (`.claude/maintainer/README.md`), so a fresh clone never sees it, and points to `guide.md` for guide pages. Their content concerns files operators read (guide pages, `CHANGELOG.md`, `README.md`), which is why it isn't a path-scoped rule in `.claude/rules/`.

This rule's own `paths` leave out `.claude/CLAUDE.md`, since the Connect Claude guide names that file to operators; `frame.md` points here before it changes instead.

A committed hook runs for everyone, so one that serves the maintainer stays quiet without the frame. Skills load only when invoked or when their description matches the task, so a skill costs the other audiences nothing.

## What belongs where

- **`.claude/CLAUDE.md`:** what Claude needs to help someone run an instance that the setup guide and the API reference don't say. It mirrors what the guide (`docs/README.md` and its section folders) teaches. It also loads in the maintainer's sessions, so it must stay true there. Mention a skill only once it exists.
- **`.claude/rules/code.md`:** the commands, conventions, and module boundaries, the facts anyone changing the code needs. Upstream process (pull requests, the changelog, document sync) goes in `.claude/maintainer/`, since an operator's own copy follows none of it.
- In any layer, add a line when Claude makes the same mistake twice, when a review catches something it should have known, or when you type the same correction into chat that you typed last session. Leave out what Claude can read from the code or the guide itself, and keep what it cannot: pitfalls, rationale, and conventions that differ from the tool defaults.
- Something that matters for one part of the codebase goes in a path-scoped rule. A multi-step procedure goes in a skill. A check that must run every time goes in a hook.

## How to write it

- Concrete enough to verify: "run `npm test` before finishing", not "test your changes".
- Under 200 lines per file. Every line costs context in every session it loads, and a code session loads `.claude/CLAUDE.md`, `code.md`, and often `client.md` together, plus `frame.md` for a maintainer.
- Headers and bullets over dense paragraphs.
- One topic per rule file, named for the topic, with `paths` when it applies to part of the tree.
- No contradictions between the files. When a fact changes, replace the old line rather than adding a correction beside it.
- Style as in `.claude/maintainer/frame.md`.

This distills Anthropic's guidance at https://code.claude.com/docs/en/memory and https://code.claude.com/docs/en/best-practices as of October 2026. Those pages are the current word when the two differ; re-read them when this rule stops matching what Claude Code does.
