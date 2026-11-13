# Upgrade to a new release

A new release of Kestrel is a new version of the `@kurtbruns/kestrel` package. Upgrading changes the version your instance's repository names, brings in the release's database changes, and deploys. The app can't undo a database change, so you note a restore point first.

In this guide, you first read what changed and check that your repository is clean, which changes nothing. Then you install the release, note where your database stands, apply the database changes, deploy, and check the new version. If you run a staging environment, upgrade it first, and repeat each step for production once it checks out.

## 1. Check before you change anything

The upgrade starts from a clean repository. A release can also ask you to change a setting or a record before it runs, and the changelog says so, release by release.

1. Check that your repository is clean, so the upgrade's commit holds only the upgrade and going back undoes nothing else:

    ```bash
    git status
    ```

    It has to say `nothing to commit, working tree clean`. If it lists anything, untracked files included, the upgrade waits until it doesn't.

1. Find the version your repository pins. It's the version you run, and the one the upgrade starts from:

    ```bash
    npm pkg get "dependencies.@kurtbruns/kestrel"
    ```

    It prints the version, such as `1.24.0`.

1. Read the [release notes](https://github.com/kurtbruns/kestrel/releases) for every version after yours, up to the one you're moving to. Each release opens with an **Upgrading from…** paragraph that says what to do. Its **Breaking** entries say what changed underneath you. If you're more than one release behind, read [Skipping releases](#skipping-releases) too.

Nothing has changed yet. If you aren't going on, stop here.

## 2. Install the release

Each step here changes only your instance's repository. Nothing reaches your deployed app until section 5.

1. Install the release. Replace `X.Y.Z` with its version:

    ```bash
    npm install @kurtbruns/kestrel@X.Y.Z
    ```

    Your `package.json` now names exactly that version.

    If npm stops with `ERESOLVE` and names wrangler, your `package.json` pins a wrangler older than the release needs. The error's `peer wrangler@` line gives the range it needs. Install both together, with that range in place of `WRANGLER_RANGE`:

    ```bash
    npm install @kurtbruns/kestrel@X.Y.Z "wrangler@WRANGLER_RANGE"
    ```

1. Bring in the release's database migrations:

    ```bash
    npm run sync-migrations
    ```

    It copies each new migration into `migrations/` and names the ones it added. It never overwrites one that's there.

1. Check the Claude Code files Kestrel gave your instance. Run it before you commit, since it finds the release you're upgrading from in your last commit:

    ```bash
    npm run check-context
    ```

    It names each file in `.claude/` and says what to do with it. A file you haven't edited takes Kestrel's change with `npm run check-context -- --update`. A file you've edited is never overwritten: merge Kestrel's change into it, by hand or with Claude. [What check-context reports](#what-check-context-reports) explains each answer.

1. If the release's **Upgrading from…** paragraph names a setting to add or remove, change `wrangler.jsonc` as it says. When you remove one, remove any comment that describes it too.

1. Check the configuration and the types:

    ```bash
    npm run typecheck
    ```

1. **(Optional)** Try the release on your computer. Apply its database changes to your local database, then start the app:

    ```bash
    npx wrangler d1 migrations apply DB --local
    npm run dev
    ```

    You see the new version with your local content. It can't show how the changes treat your real data. A staging environment can.

1. Commit the upgrade as one commit. Going back, below, undoes this commit:

    ```bash
    git add -A
    git commit -m "Upgrade Kestrel to X.Y.Z"
    ```

    If your repository has a remote, push it:

    ```bash
    git push
    ```

## 3. Note a restore point

D1 keeps a history of your database, called Time Travel, for 30 days on Workers Paid and 7 on Workers Free. A bookmark marks one moment in it, so you can put the database back if the upgrade goes wrong.

1. In the editor, check that no send is in progress. The dashboard lists any that are. Upgrade between sends.

1. Note where the database stands now:

    ```bash
    npx wrangler d1 time-travel info DB --env production
    ```

    It prints a bookmark for the database's current state. Copy it, and keep it until the upgrade checks out.

    It also prints a restore command. Don't use it: it leaves out `--env production`, so it aims at the database the top level of your `wrangler.jsonc` names, not production's. [Go back](#go-back) has the command to use.

## 4. Apply the database changes

A release changes the database only by adding a migration. Applying it keeps everything already in the database. The new release's code expects them, so the deploy in section 5 waits until this section's check says nothing is left.

1. Apply the migrations. Run it on every upgrade:

    ```bash
    npx wrangler d1 migrations apply DB --remote --env production
    ```

    It lists the migrations it's about to apply, asks you to confirm, then marks each one as it applies it. A shell that isn't interactive, such as Claude's, confirms on its own. When a release has none, it says there are no migrations to apply.

    If it fails, don't deploy. Run the same command again: an applied migration is recorded, so a second run applies only what's left. If it fails again, stop the upgrade here. The release you run now keeps working.

1. Check that nothing is left to apply:

    ```bash
    npx wrangler d1 migrations list DB --remote --env production
    ```

    ```
    ✅ No migrations to apply!
    ```

    If it prints `Migrations to be applied:` and a list instead, those are still missing. Apply them as in the step above, and check again.

## 5. Deploy

Deploy only once section 4's check says there are no migrations to apply.

```bash
npx wrangler deploy --env production
```

Near its end, the output names your app's hostname, then its schedule and a version ID.

## Check it

1. The app answers:

    ```bash
    curl https://newsletter.example.com/health
    ```

    ```
    {"status":"ok","service":"kestrel"}
    ```

    If it answers `500` with `{"error":"schema_behind","missing":[…],…}` instead, the release was deployed before its database changes: the public pages say the newsletter is temporarily unavailable and nothing is sent. Apply them as in section 4; the app answers as soon as they're applied, with no new deploy.

1. Reload the editor. The foot of the **Docs** tab's contents list shows the new version, which links to its release page.

1. If an email provider is connected, send yourself a test email, as in [Verify it works](../get-started/verify.md#1-send-yourself-a-test-email). Don't send a real post to check an upgrade: on a live instance, it goes to your whole list.

1. In the logs, filter on `event` equal to `sweep.tick`: a line still arrives every minute. [Read the logs](../get-started/verify.md#7-read-the-logs) shows where the logs are.

## Go back

If the new release misbehaves, deploy the previous one, and put the database back to your bookmark.

A restore returns the whole database to that moment. Everything written since is gone: edits to posts, new subscribers, and the record of anything sent. Restore only soon after the upgrade.

Never restore past a send that went out, or an unsubscribe recorded since the bookmark. The restored database wouldn't know of them, so it could mail those readers again, or mail someone who left. If either happened, stay on the new release, and fix forward.

1. Find the upgrade's commit. Replace `X.Y.Z` with the release you're backing out. Its id comes first on the line:

    ```bash
    git log -1 --oneline --grep="Upgrade Kestrel to X.Y.Z"
    ```

1. Undo it. This adds a commit that puts back the previous release, its migrations, and your Claude Code files, and leaves anything you committed since as it is:

    ```bash
    git revert --no-edit REPLACE_WITH_COMMIT_ID
    ```

1. Install the previous release, and deploy it:

    ```bash
    npm ci
    npx wrangler deploy --env production
    ```

1. Restore the database to the bookmark from section 3:

    ```bash
    npx wrangler d1 time-travel restore DB --env production --bookmark=REPLACE_WITH_BOOKMARK
    ```

1. If your repository has a remote, push the revert to it:

    ```bash
    git push
    ```

## Skipping releases

If you're more than one release behind, upgrade straight to the release you're moving to, in one pass through this guide. Each paragraph names an `npm install` of its own release, but you install only the target, once. Section 2 brings in every release between: `sync-migrations` copies each migration you don't have, and `check-context` compares from the release in your last commit.

Do every other step each paragraph names, oldest release first, where it falls in this guide. Keep in mind:

- A number in a paragraph counts that release alone. If one says it changes two of your Claude Code files, `check-context` can report more, counting every release you skip.
- A release's change to how you upgrade, such as a new check in the upgrade skill, isn't in force until that release is installed. Until the install, you upgrade on the guide and skill you have now. After it, the new release's guide and skill apply, from the step after the install.
- A paragraph may say it removed or renamed something your current skill or guide uses, such as a file or a command. Use what it names instead.

## What check-context reports

`npm run check-context` compares each file in `.claude/` with the copy the installed release ships. Where they differ, it also compares with the copy of the release you're upgrading from, which it fetches from npm. Each file gets one of these answers:

- **current**: nothing to do, with or without your edits.
- **Kestrel changed it, and you haven't edited it**: take the new one with `npm run check-context -- --update`.
- **new in this release**: a file the release you're upgrading from didn't have. Add it with `npm run check-context -- --update`.
- **you removed it**: a file you deleted stays deleted, and `--update` never brings it back. The line names this release's copy, so to bring it back, copy it from there, or ask Claude to.
- **Kestrel changed it, and you've edited it**: it shows what Kestrel changed, then your own edits, each from the release you're upgrading from. Merge Kestrel's change into yours, by hand or with Claude, keeping your edits.
- **Kestrel's change can't be shown apart from your edits**: something it needs is missing, such as the network, `tar`, git, or a commit naming the release you came from. It says what, and shows one difference from yours to the release's; merge what you want of it. If you've already committed the upgrade, name the release you came from with `npm run check-context -- --from X.Y.Z`.

When a file has a change to take, its last line names the changelog sections that describe it, one for each release since yours. A change you don't take now isn't offered again at the next upgrade, which starts from the release you're on.
