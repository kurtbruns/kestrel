---
name: upgrade
description: Upgrade this Kestrel instance to a new release by following docs/guides/07-upgrade.md, including its Changed copy steps when the copy has code changes of its own. Use when the person asks to upgrade, update to a new release, or merge a new Kestrel version into their copy.
argument-hint: "[vX.Y.Z]"
---

# Upgrade the instance

`docs/guides/07-upgrade.md` is the procedure. Read it now, and follow it section by section, running each step's commands as written. This skill holds only what the page leaves to you, and never adds or replaces a step. If anything here seems to disagree with the page, the page wins; say so.

## What's yours to judge

- **Which steps apply.** Run section 1's diff of the copy's changes and show the person the result. Changes beyond their own settings mean the **Changed copy** steps apply. Name each **Breaking** entry that touches a file in that list.
- **Each conflict.** Show what you took from the release and what you added back, file by file. If the copy's change no longer fits the release's code, stop and ask rather than forcing it.
- **The checks.** Report each one's result. A failure stops the upgrade until it's fixed or the person decides.
- **The local try.** Ask the person to try their own feature; you can't judge that alone.

## Ask first

Everything in `.claude/CLAUDE.md`'s **Ask first** applies, which covers the page's migration, deploy, and any secret or setting a release asks for. Ask before anything in the page's **Go back** section too. Its database restore erases everything written since the bookmark.

Finish with the page's **Check it** list, reporting each result.
