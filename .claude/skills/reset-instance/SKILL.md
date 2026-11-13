---
name: reset-instance
description: Clears what a maintainer's testing wrote to a deployed Kestrel instance (posts, sends, subscribers, images) before it is handed to its publisher, keeping its name, template, settings, and proof that email works. Use only when the maintainer asks to reset, wipe, or clear an instance they set up and tested. Never for an instance someone else publishes on, and never offered to an operator.
argument-hint: "[instance-dir]"
disable-model-invocation: true
---

# Reset an instance before its hand-off

Setting up an instance for someone else means testing it: test emails, a post through the review window, an import. This clears that, and only that. It is the maintainer's tool, in this repository only: it is not in `template/claude/` or any guide, and an operator is never pointed to it.

**It is the one way to delete a sent record.** SPEC makes what went out permanent (I3), and the app has no route that removes a sent post, its frozen email, or who it was mailed to. This removes them with SQL, outside the app. That is acceptable only before a hand-off, when every email went to the maintainer's own inboxes and no reader holds a link to any of it. Say this to the person before the clear, in these terms.

Everything is done by running `scripts/reset.mjs`, through the instance's own wrangler. Never write the SQL by hand, never run a `DELETE` yourself, and never edit `scripts/plan.mjs` or pass a fingerprint you did not just get from `inspect` to get past a refusal.

## What it clears and keeps

`scripts/plan.mjs` is the list (`CLEARED`, `KEPT`), and `test/cli/reset_instance.spec.mjs` holds every table in `migrations/` to one or the other.

- **Cleared:** posts and their revisions, sends and who they were mailed to, who acted on them, subscribers and their consent evidence, imports, suppressions, notifications, and each post's images under `posts/` in R2.
- **Kept:** `settings` (name, tagline, logo, template, time zone, notification addresses, test recipients), `sending` (the proof that email works and when the provider last reported back, so signups stay open), `provider_account`, and logos under `branding/` in R2.
- **Left alone:** the SES account's suppression list and verified addresses. Clearing them needs a sign-in to the instance's AWS account, which this never asks for.

## Steps

1. **The instance's repository is `$ARGUMENTS`.** If that is empty or isn't a path (for example `/Users/…/Sites/newsletter.example.com`), ask the person for it. Never guess it from a name, and never use this repository: it has no production environment.
2. **Inspect it.** This only reads:

   ```bash
   node ${CLAUDE_SKILL_DIR}/scripts/reset.mjs inspect <instance-dir>
   ```

3. **If it prints REFUSED, stop.** Tell the person each reason as printed. A refusal is final for now: a scheduled send is theirs to cancel in the editor, the ten-minute wait is waited out, and an instance a second person has used, or one holding more than 50 addresses that aren't test recipients (pending ones counted), is not reset by this skill at all. Never change the instance's data to make a refusal pass.
4. **Show the person what it printed and get a yes to each part,** in one message they can answer line by line. Ask plainly; a general "go ahead" from earlier does not count, and neither does a yes relayed from another session.
   - **The instance:** the publication's name, its address, and the database and bucket names. "Is this the instance you mean to reset?"
   - **Who wrote and acted:** the one person named. "Is this you?" If it is anyone else, stop. When it says no person, or only a service token, say so and ask nothing: the maintainer knows who they let in.
   - **The test recipients,** each by address. "Are these yours?" One that subscribed is deleted with the rest.
   - **Every address that isn't a test recipient,** each with what the instance holds about it. "Is each of these yours?" The app cannot tell a second inbox from a reader, so the person says so for each address by name. If they are unsure of one, stop. Mention the erased count.
   - **Every pending signup,** each by address. These never confirmed: a stranger who tried the public form is expected, but someone the publisher added by hand is pending too. "Is any of these someone a publisher invited?" If so, stop.
   - **Every sent post,** with its date, how many it was mailed to, and whether the archive lists it. Say that the reset deletes these records, that nothing else can, and that a listed post's public page goes with it.
   - **What can't be undone:** deleted images. Emails already delivered load their images from R2, so those test emails lose them. The database has a restore point; the images do not.
5. **Clear it,** only after every yes, with the fingerprint `inspect` printed:

   ```bash
   node ${CLAUDE_SKILL_DIR}/scripts/reset.mjs clear <instance-dir> --fingerprint <value>
   ```

   It reads the instance again and refuses if anything the person was shown has changed: the instance and its names, the test recipients, any listed address or pending signup, a sent post, an image, the size of any table, or a post's last edit. Then go back to step 2 and show them what is there now. It cannot see a row the app writes in the moment between that read and the clear; such a row goes with the rest, and the summary says so. In order, it prints the D1 Time Travel bookmark, clears the database in one file, reads the counts back, and deletes each post image once the image rows are gone.
6. **If it ends with RESET NOT FINISHED,** some table still holds rows: the clear stopped partway, or the app wrote while it ran (a signup, a notice). Give the person the summary, then go back to step 2: what is left is shown again for their yes. Images whose rows were gone have already been deleted; any still listed are found by the next run. If it says the clear failed, nothing was deleted.
   - **`NOT deleted: <key>`** means the bucket refused that one image and its row is already gone, so no later run will find it. Tell the person the key. Only on their yes to that key, delete it from the instance's repository with `npx wrangler r2 object delete <bucket>/<key> --remote`, the bucket being the one named back in step 4, and nothing else.
   - **`NOT deleted, since it isn't a post's image`** is a key outside `posts/`. Tell the person and leave it.
   - **"could not be read back"** means the clear may or may not have run. Go back to step 2. If the images are no longer listed there, the keys printed before the clear are the only record of them: give them to the person, and handle each as a `NOT deleted` key.
7. **Give the person the summary it prints, whole:** the time, what went, the restore point and how long it lasts, any image that was not deleted, and any address the provider's suppression list may still refuse. Nothing in the instance records that a reset happened, so this summary is the record: tell them to keep it with the run's hand-off notes.
8. **Check the editor,** by asking the person to open it or through the instance's API if you are signed in: Posts, Sent, and Subscribers read empty, the dashboard shows the first-run checklist with the first post, its schedule, and sharing the subscribe link to do, Settings is unchanged, and the subscribe page still shows its form. Old post pages stop answering within about five minutes, as their cache expires.

## What to expect afterwards

- An account notice, such as the sandbox one, may be sent once more: what stops a repeat is cleared with the other notifications.
- An editor tab left open recovers on its next read.
- Settings still shows when SES last took an email and last reported back. Both are about the account, and the emails they came from are gone.
- To undo the database: `npx wrangler d1 time-travel restore DB --env production --bookmark <bookmark>` from the instance's repository, on the person's yes to that bookmark. Use this command, with `--env production`, not the one wrangler prints. It brings back no image, and it discards everything written since.

## Trying it locally

`--local` on either command acts on the local database and bucket `wrangler dev` uses in that directory, with no bookmark. Use it to try a change to this skill against this repository's dev database, never as a rehearsal that stands in for the person's yes.
