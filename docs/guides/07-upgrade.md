# Upgrade to a new release

A new release of Kestrel is a new version of the `@kurtbruns/kestrel` package. Upgrading changes the version your instance's repository names, brings in the release's database changes, and deploys. The app can't undo a database change, so you note a restore point first.

In this guide, you read what changed, install the release, and note where your database stands. Then you apply the database changes, deploy, and check the new version. If you run a staging environment, upgrade it first, and repeat each step for production once it checks out.

## 1. Read what changed

A release can ask you to change a setting or a record before it runs. The changelog says so, release by release.

1. Find the version you run. In the editor, open the **Docs** or **API** tab. The foot of its contents list shows the version, then the commit. Your instance's `package.json` names it too, as the version of `@kurtbruns/kestrel`.

1. Read the [release notes](https://github.com/kurtbruns/kestrel/releases) for every version after yours, up to the one you're moving to. Each release opens with an **Upgrading from…** paragraph that says what to do. Its **Breaking** entries say what changed underneath you.

## 2. Install the release

Each step here changes only your instance's repository. Nothing reaches your deployed app until section 5.

1. Install the release. Replace `X.Y.Z` with its version:

    ```bash
    npm install @kurtbruns/kestrel@X.Y.Z
    ```

    Your `package.json` now names exactly that version. Kestrel's versions aren't semantic versioning, so your instance never moves to a release you didn't choose.

1. Bring in the release's database migrations:

    ```bash
    npm run sync-migrations
    ```

    It copies each new migration into `migrations/` and names the ones it added. It never overwrites one that's there.

1. Check the Claude Code files Kestrel gave your instance:

    ```bash
    npm run check-context
    ```

    It compares each file in `.claude/` with the release's, and says what to do for each one:

    - **current**: nothing to do.
    - **Kestrel changed it, and you haven't edited it**: take the new one with `npm run check-context -- --update`.
    - **Kestrel changed it, and you've edited it**: it shows the difference from yours to the release's. Merge what you want into yours, by hand or with Claude, then record that you did with the command it prints.

1. If the release's **Upgrading from…** paragraph names a new setting, add it to `wrangler.jsonc`.

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

1. Commit the upgrade as one commit, and push it. Going back, below, undoes this commit:

    ```bash
    git add -A
    git commit -m "Upgrade Kestrel to X.Y.Z"
    git push
    ```

## 3. Note a restore point

D1 keeps a history of your database, called Time Travel, for 30 days on Workers Paid and 7 on Workers Free. A bookmark marks one moment in it, so you can put the database back if the upgrade goes wrong.

1. In the editor, check that no send is in progress. The dashboard lists any that are. Upgrade between sends.

1. Note where the database stands now:

    ```bash
    npx wrangler d1 time-travel info kestrel-production
    ```

    It prints a bookmark for the database's current state. Copy it, and keep it until the upgrade checks out.

## 4. Apply the database changes

A release changes the database only by adding a migration. Applying it keeps everything already in the database.

```bash
npx wrangler d1 migrations apply DB --remote --env production
```

It lists the migrations it's about to apply, and asks you to confirm. When a release has none, it says there's nothing to apply. Run it on every upgrade.

## 5. Deploy

```bash
npx wrangler deploy --env production
```

The output ends with your app's hostname.

## Check it

1. The app answers:

    ```bash
    curl https://newsletter.example.com/health
    ```

    ```
    {"status":"ok","service":"kestrel"}
    ```

1. Reload the editor. The foot of the **Docs** tab's contents list shows the new version, which links to its release page.

1. Send yourself a test email, as in [Verify it works](../get-started/05-verify.md#1-send-yourself-a-test-email). Don't send a real post to check an upgrade: on a live instance, it goes to your whole list.

1. In the logs, `sweep.tick` still arrives every minute, as in [Verify it works](../get-started/05-verify.md#7-read-the-logs).

## Go back

If the new release misbehaves, deploy the previous one, and put the database back to your bookmark.

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
    npx wrangler d1 time-travel restore kestrel-production --bookmark=REPLACE_WITH_BOOKMARK
    ```

1. Push the revert to your repository:

    ```bash
    git push
    ```

A restore returns the whole database to that moment. Everything written since is gone: edits to posts, new subscribers, and the record of anything sent. Restore only soon after the upgrade.

Never restore past a send that went out, or an unsubscribe recorded since the bookmark. The restored database wouldn't know of them, so it could mail those readers again, or mail someone who left. If either happened, stay on the new release, and fix forward.
