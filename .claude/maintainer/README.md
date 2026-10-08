# The `maintainer/` folder

This folder is Claude Code's context for **maintaining Kestrel**: how a change to the upstream project lands, with its documents, changelog, and release in step. If you run your own instance, including one you add features to, you can ignore it. Your context is `.claude/CLAUDE.md`, and `.claude/rules/code.md` loads on its own once Claude reads the code.

## Turn it on

Create `CLAUDE.local.md` at the repository root, holding this one line:

```
@.claude/maintainer/frame.md
```

`CLAUDE.local.md` is gitignored, and Claude Code loads it at the start of every session, after `.claude/CLAUDE.md`. A fresh clone doesn't have it. Contributors add it before opening a pull request. A worktree Claude Code makes inside the repository (under `.claude/worktrees/`) loads the root's file too, since Claude Code reads `CLAUDE.local.md` in every directory above the session's.

## What's here

- **`frame.md`** loads with every maintainer session: how a change lands (documents in sync, pull requests, GitHub issues), the contract for Kestrel's documents, and the changelog, from writing a line to cutting a release.
- **`guide.md`** holds the setup guide's writing rules. The frame points to it rather than loading it, since it matters only when a guide page changes.

None of this lives in `.claude/rules/`, because a path-scoped rule loads whenever Claude reads a matching file, and operators read the setup guide and `CHANGELOG.md` while running their instance. For the same reason the changelog `Stop` hook (`.claude/hooks/changelog-reminder.mjs`) stays quiet unless `CLAUDE.local.md` imports the frame.
