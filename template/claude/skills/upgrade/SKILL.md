---
name: upgrade
description: Upgrade this Kestrel instance to a new release by following the setup guide's upgrade page. Use when the person asks to upgrade, update Kestrel, or move to a new release.
argument-hint: "[X.Y.Z]"
---

# Upgrade the instance

An upgrade moves the instance to a newer release of `@kurtbruns/kestrel`. The guide's upgrade page is the procedure: `node_modules/@kurtbruns/kestrel/docs/guides/upgrade.md`. Read it now, and again after installing the new release, whose page then replaces it from the step after the install. Follow it section by section, running each step's commands as written. This skill holds only what the page leaves to you, and never adds or replaces a step. If anything here seems to disagree with the page, the page wins; say so.

## What's yours to judge

- **Which release, and what it asks.** The installed version is in `package.json`. Read every changelog section between it and the target, in the release notes at `https://github.com/kurtbruns/kestrel/releases`, and work out what each **Breaking** entry and each step in an *Upgrading* paragraph means for this instance.
- **Anything not yet committed.** If the page's `git status` lists anything, report what it lists and stop until it lists nothing. How it gets clean is the person's call, so don't offer to commit it or move it.
- **The go-ahead.** The page's section 1 changes nothing, and neither do you until this is settled. Name the releases, each **Breaking** entry, and each *Upgrading* step, say what each means for this instance, and ask whether to go ahead. Run nothing from section 2 until they say yes. "Not now" ends the upgrade with nothing changed.
- **The context check.** `npm run check-context` compares this repository's Claude files with the release's, and runs before the upgrade is committed, since it finds the release being upgraded from in the last commit. Show the person what it reports. When Kestrel changed a file the person has edited, show them what Kestrel changed and what their own edits are, then apply Kestrel's change to their file, keeping their edits; where both changed the same lines, ask the person which way to go, and show them the result. When it can show only one difference, merge from that. A change marked as bearing on safety comes first. The files it changes are part of the upgrade's commit.
- **The local try.** Ask the person to try what they care about on `npm run dev` before anything reaches production.
- **The checks.** Report each one's result. A failure stops the upgrade until it's fixed or the person decides.

The production migration, the deploy, and anything in the page's **Go back** section reach real readers: say what each does and confirm first. Going back's database restore erases everything written since the backup.

## The migration before the deploy

A deploy onto a database missing the release's migrations takes the instance down until they're applied: the public pages say the newsletter is unavailable, and nothing sends.

- **Run the migration as a command of its own,** never in one command with the deploy, so you can read its output, run the check, and confirm the deploy in between. Never pipe it (`| tail`) or follow it with `;`: a pipe reports the last command's exit code, and `;` runs the next command whatever happened, so a failure reads as success.
- **Read its whole output before going on.** Check that every migration `sync-migrations` added for this release is listed with a ✅, or, when it added none, that it says there are none to apply. Then run the page's check that nothing is left, and report what it prints.
- **If it fails, stop, and don't deploy.** Tell the person, quoting the error line, which wrangler may bury under account details it prints after it. A temporary error from Cloudflare's API is the likely cause, and running the same command again is safe, since an applied migration is recorded and never applied twice. Run it again, and deploy only once the check says nothing is left.

Finish with the page's **Check it** list, reporting each result.
