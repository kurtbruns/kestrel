# Updating a GitHub issue

An issue's body is the whole, current statement of the work. Whoever picks it up, agent or person, often reads only the body, so a requirement left in a comment gets missed. When you add to or change what an issue asks for, rewrite the body. Do not append a comment.

## Body or comment

The test: would someone who reads only the body do the work wrong or incompletely without this? If yes, it goes in the body. If no, it is a comment.

A comment is still right for:

- a status or progress note that does not change the scope;
- a question for the author;
- a reply in a discussion;
- a pointer to a PR that addresses the issue;
- a change to an issue someone else wrote (its author is not the `gh` user). Propose it in a comment and let them fold it in, unless the user asks you to edit the body anyway.

## Rewriting the body

1. Read the current body: `gh issue view <n> --json body -q .body > <scratchpad>/issue-<n>.md`.
2. Edit that file. Keep the author's content and voice. Put new material in the section where it belongs, not at the end. Replace a statement the change makes stale rather than adding a correction beside it.
3. Show the user the diff against the original and wait for a yes. This holds for every rewrite, including issues you wrote: saving overwrites the body for everyone.
4. Re-read the body right before saving. If it changed since step 1, merge onto the new version and confirm again.
5. Save with `gh issue edit <n> --body-file <scratchpad>/issue-<n>.md`.

## Keeping the trail

- Do not add an "Updated:" line. The body reads as the current statement, and GitHub's edit history records what changed and when.
- Leave a comment the rewrite supersedes in place. If you wrote it, offer to delete it, and delete it only on a yes.
