---
name: upgrade
description: Upgrade this Kestrel instance to a new release by following the setup guide's upgrade page. Use when the person asks to upgrade, update Kestrel, or move to a new release.
argument-hint: "[X.Y.Z]"
---

# Upgrade the instance

An upgrade moves the instance to a newer release of `@kurtbruns/kestrel`. The guide's upgrade page is the procedure: `node_modules/@kurtbruns/kestrel/docs/guides/07-upgrade.md`. Read it now, and again after installing the new release, whose page then replaces it. Follow it section by section, running each step's commands as written. This skill holds only what the page leaves to you, and never adds or replaces a step. If anything here seems to disagree with the page, the page wins; say so.

## What's yours to judge

- **Which release, and what it asks.** The installed version is in `package.json`. Read every changelog section between it and the target (the release notes at `https://github.com/kurtbruns/kestrel/releases`, or the new `CHANGELOG.md` once installed). Name each **Breaking** entry and each step in an *Upgrading* paragraph, and say what it means for this instance.
- **The context check.** `npm run check-context` compares this repository's Claude files with the release's. Show the person what it reports. When Kestrel changed a file the person has edited, show what changed, merge it with their edits, and run the command it suggests to record the merge. A change marked as bearing on safety comes first.
- **The local try.** Ask the person to try what they care about on `npm run dev` before anything reaches production.
- **The checks.** Report each one's result. A failure stops the upgrade until it's fixed or the person decides.

The production migration, the deploy, and anything in the page's **Go back** section reach real readers: say what each does and confirm first. Going back's database restore erases everything written since the backup.

Finish with the page's **Check it** list, reporting each result.
