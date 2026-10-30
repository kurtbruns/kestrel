---
name: pr-description
description: Write or rewrite a Kestrel pull request's description, which the squash makes the commit on main. Opens with what changes for the operator, publisher, and readers, problem first, then the technical detail a reviewer needs. Use when opening a pull request, editing its description, rereading it before merge, or when asked to explain a pull request plainly.
---

# Write a pull request's description

A pull request lands by squash, so its description becomes the commit on `main`: the record of what the change does and why, for the reviewer now and for whoever reads the history later. Write it so someone with no part in the work can start at the top and stop when they know enough. Put the context in the description itself instead of pointing at a conversation, an artifact, or a session, which won't last. This shape replaces the Summary and Test plan of Claude Code's built-in pull request guidance.

## The opening: What changes for people

A change that earns a changelog line opens with a `## What changes for people` section, before its `Closes #N` lines.

- **Problem first.** Say what was wrong or missing and why it mattered, then what the change does about it.
- **Then each person it touches, in this order:** the operator (an upgrade step, configuration, deploying, the setup guide), the publisher (the editor, Claude as the publisher's client, the send record, the publishing docs), and readers (the subscribe pages, the mail, the archive). Leave out anyone it doesn't touch, unless saying they notice nothing answers a natural worry.
- **Say what doesn't change** when someone would reasonably worry: a send in flight, the list, an existing instance, a reader's inbox.
- **Fit it to the change.** A one-line doc fix gets one sentence. A change with an upgrade step and new screens gets a paragraph. When several people each have more than one thing to know, give each a labeled line.
- **Plain words only.** Name no file, function, field, column, or table. A command or setting the operator types, or a screen or button the publisher sees, is fine, named as the operator or publisher meets it.
- **Start from the changelog line**, which already says it for the operator, and widen it to the others.

A change with no changelog line (a refactor, a test, tooling, maintainer context, a release) has no one in those roles to tell, so it leaves the section out. Its first paragraph still says plainly what the change does and why, never how the work came about.

## The rest: what a reviewer needs

After the opening and the closing lines, the technical detail, under whichever of these headings the change needs:

- **How it works:** what changed, in the code's own names, and why this approach over the obvious other one. A decision the diff doesn't show belongs here.
- **Checks:** what was run and what it showed: the gate, a spec that fails without the fix, a run on a real instance.
- **Where this differs from the issue:** required on every pull request linked to an issue, as `.claude/CLAUDE.md` says.

Merge order, stacking, and other review logistics go in a comment on the pull request, not the description: they matter for a day, and the commit keeps them forever.

## Before merge

Review changes the change, so reread the description against the final diff, after the last push and before the squash:

1. The opening still says what the change does now, and agrees with the changelog line.
2. Each issue it finishes has a `Closes #N` line, and each it only advances a `Part of #N`.
3. "Where this differs from the issue" covers every decision made in review.
4. Checks names the gate run on the final commit, not an earlier one.

## Examples

A change that touches all three, problem first. The description of kurtbruns/kestrel#870 opened with its merge order ("Stacked on #868 at a76f03b3 … Merge #868 first, then retarget this to `main`"). With this skill it would open:

> ## What changes for people
>
> A new SES account starts in the sandbox, where it can mail only addresses you've verified, and nothing in Kestrel said whether you were still there: the publisher had to check AWS's console, and a raise in the send rate meant editing config and redeploying. The app now reads the SES account itself. Operators apply one migration and let the app's AWS key read the account; until then, everything works as before. Publishers see in Settings whether the account is in the sandbox, where the production-access request stands, and the send rate, and sends follow the account's own rate. Readers notice nothing.

The same change with a labeled line per person:

> A new SES account starts in the sandbox, and nothing in Kestrel said whether you were still there. The app now reads the SES account itself.
>
> - **Operators:** apply one migration and let the app's AWS key read the account. Until then nothing changes; after it, the send-rate setting is optional, since sends follow the account's own rate.
> - **Publishers:** Settings shows whether the account is in the sandbox, where the production-access request stands, and the send rate. The dashboard's setup steps add Request production access, and a warning says when bounces would never reach the app.
> - **Readers:** nothing changes.

A one-line fix, kurtbruns/kestrel#875:

> ## What changes for people
>
> Readers who find the home page before the first post, on an instance with no email provider connected yet, now read "No posts yet. Subscribe to get the first one." as two sentences, where a dash had joined them.
