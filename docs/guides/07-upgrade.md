# Upgrade to a new release

A new release of Kestrel arrives as a tag in Kestrel's repository, your `upstream` remote. Upgrading merges that tag into your copy, applies any new database changes, and deploys. The app can't undo a database change, so you note a restore point first.

In this guide, you read what changed, merge the release, and note where your database stands. Then you apply the database changes, deploy, and check the new version. If you run a staging environment, upgrade it first, and repeat each step for production once it checks out.

If you've changed Kestrel's code in your copy, such as adding a feature, the steps marked **Changed copy** are for you. They keep your changes working, and keep `main` deployable until the release checks out. In Claude Code, `/upgrade` takes you through this guide.

## 1. Read what changed

A release can ask you to change a setting or a record before it runs. The changelog says so, release by release.

1. Find the version you run. In the editor, open the **Docs** or **API** tab. The foot of its contents list shows the version, then the commit.

1. Read `CHANGELOG.md` for every version after yours, up to the one you're moving to. Each release opens with an **Upgrading from…** paragraph that says what to do. Its **Breaking** entries say what changed underneath you.

1. **Changed copy:** list what your copy changed from Kestrel's:

    ```bash
    git fetch upstream --tags
    git diff --stat upstream/main...HEAD
    ```

    It lists only your own changes, including your settings in `wrangler.jsonc`. Compare the code files against the **Breaking** entries. A change can merge without a conflict and still stop working, when the code it relies on changed meaning.

To move from a 0.x release, read the 1.0.0 entry first. Moving to 1.0.0 or later means rebuilding the database, which starts it empty.

## 2. Merge the release

Your copy carries your own settings, such as your hostname and database id in `wrangler.jsonc`. So you merge the release into your branch, rather than check out the tag.

1. **Changed copy:** merge on a branch of its own, so `main` keeps what's deployed while you resolve and check the merge:

    ```bash
    git switch -c upgrade-vX.Y.Z
    ```

1. Fetch the release, and merge it. Replace `vX.Y.Z` with the release's tag:

    ```bash
    git fetch upstream --tags
    git merge vX.Y.Z
    ```

1. If `wrangler.jsonc` conflicts, keep your own values, and add whatever the release added. The release's **Upgrading from…** paragraph names any new setting. Then mark it resolved with `git add wrangler.jsonc`.

1. **Changed copy:** if `git status` says a file you changed was `deleted by them`, the release removed it. Decide whether your change still belongs, then remove the file with `git rm`, or keep yours with `git add`.

1. **Changed copy:** if a code file conflicts, start from the release's version of it, and add your change back on top. The release's code is what its tests and later releases build on:

    ```bash
    git checkout --theirs src/path/to/file.ts
    ```

    Then make your change again in that file, and mark it resolved with `git add`. Keep Kestrel's guarantees as they are: consent, immediate unsubscribe, the review window, and the rest of section 3 of `docs/SPEC.md`.

1. **Changed copy:** if `package.json` conflicts, keep both the release's versions and your additions, then mark it resolved with `git add package.json`.

1. **Changed copy:** if `package-lock.json` conflicts, take the release's, then install your own additions again from `package.json`:

    ```bash
    git checkout --theirs package-lock.json
    npm install
    git add package-lock.json
    ```

1. If the merge stopped on conflicts, check that `git status` lists no unmerged files, then commit it:

    ```bash
    git commit --no-edit
    ```

1. Install the exact versions the release uses:

    ```bash
    npm ci
    ```

1. Run the tests:

    ```bash
    npm test
    ```

1. Check the configuration and the types:

    ```bash
    npm run typecheck
    ```

1. **(Optional)** Try the release on your computer. Apply its database changes to your local database, then start the app:

    ```bash
    npm run migrate:local
    npm run dev
    ```

    You see the new version with your local content. It can't show how the changes treat your real data. A staging environment can.

1. **Changed copy:** run the step above rather than skip it. The tests cover Kestrel's code, but your feature is checked only if you wrote tests for it. Try what you added, and check that the release's database changes apply cleanly beside your own.

1. **Changed copy:** once the release checks out, bring `main` up to your branch, and delete the branch:

    ```bash
    git switch main
    git merge --ff-only upgrade-vX.Y.Z
    git branch -d upgrade-vX.Y.Z
    ```

    If it doesn't check out, `main` is untouched. Stop the merge if it's still in progress, return to `main`, delete the branch, and put back your copy's packages:

    ```bash
    git merge --abort
    git switch main
    git branch -D upgrade-vX.Y.Z
    npm ci
    ```

    Skip `git merge --abort` if you already committed the merge.

1. Push the merge to your repository:

    ```bash
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

Since 1.0.0, a release changes the database only by adding a migration. Applying it keeps everything already in the database.

```bash
npm run migrate:remote -- --env production
```

It lists the migrations it's about to apply, and asks you to confirm. When a release has none, it says there's nothing to apply. Run it on every upgrade.

**Changed copy:** if your copy adds migrations of its own, the release's migrations apply beside yours. D1 records each migration by file name, and applies every one it hasn't run, whatever its number. A release migration can still fail on a table or column your own migration changed. The local try in section 2 catches that first. If it fails here, restore the database to your bookmark, as in [Go back](#go-back). The new code isn't deployed yet, so there's nothing to redeploy.

## 5. Deploy

```bash
npm run deploy -- --env production
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

1. Reload the editor. The foot of the **Docs** tab's contents list shows the new version, and the commit you deployed.

    The version links to its release page only when you deploy the tagged commit itself. Your merge is a commit of its own, so the version shows without a link. That's expected.

1. Send yourself a test email, as in [Verify it works](../get-started/05-verify.md#1-send-yourself-a-test-email). Don't send a real post to check an upgrade: on a live instance, it goes to your whole list.

1. In the logs, `sweep.tick` still arrives every minute, as in [Verify it works](../get-started/05-verify.md#7-read-the-logs).

## Go back

If the new release misbehaves, deploy the previous one, and put the database back to your bookmark.

1. Find the release's merge. Its id comes first on the line:

    ```bash
    git log --merges -1 --oneline
    ```

1. Check out your branch as it was before that merge. This leaves the branch itself as it is, and works even if you committed a fix after the merge:

    ```bash
    git checkout REPLACE_WITH_MERGE_ID^1
    ```

1. Install that release's versions, and deploy it:

    ```bash
    npm ci
    npm run deploy -- --env production
    ```

1. Restore the database to the bookmark from section 3:

    ```bash
    npx wrangler d1 time-travel restore kestrel-production --bookmark=REPLACE_WITH_BOOKMARK
    ```

A restore returns the whole database to that moment. Everything written since is gone: edits to posts, new subscribers, and the record of anything sent. Restore only soon after the upgrade.

Never restore past a send that went out, or an unsubscribe recorded since the bookmark. The restored database wouldn't know of them, so it could mail those readers again, or mail someone who left. If either happened, stay on the new release, and fix forward.

When you're done, return to your branch with `git checkout -`, and run `npm ci` to install its versions again.
