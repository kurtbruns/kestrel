# Upgrade to a new release

How to move a running instance to a newer release. If you keep a staging environment, upgrade it first and prove it, then repeat for production.

Nothing here runs from inside the app, and the app cannot undo it for you: a deploy is yours to repeat, but a schema change is not something the app can roll back. Step 3 notes a restore point first, so **Going back** has somewhere to return to.

## 1. Read the changelog

Find the version you are running: the editor shows it at the foot of the Docs and API tabs' contents rail (version, then commit), and `GET /api/version` returns it with the release tag and build time.

Then read `CHANGELOG.md` for every version between yours and the one you are moving to. Take any **Breaking** entry seriously before starting: it names something you have to change (a variable, a binding, a DNS record) for the new release to run. Note too any entry that says it **touches the database baseline**; step 3 depends on it.

## 2. Bring in the release

Releases are tagged `vX.Y.Z`. Your branch carries your own commits (the database id and hostname you set in `wrangler.jsonc` during [Deploy the app](../get-started/02-deploy.md)), so merge the release tag into it rather than checking the tag out, which would leave those behind. Kestrel's repository is your `upstream` remote:

```bash
git fetch upstream --tags
git merge vX.Y.Z
```

Resolve any conflict in `wrangler.jsonc` by keeping your ids and values alongside whatever the release added. Then install exactly the versions the release pins, and run the gate:

```bash
npm ci
npm test
npm run typecheck
```

**(Optional)** To try the release on your computer first, run `npm run dev`. Your local database takes the release's migrations, so you see the new version with your local content. It can't tell you how the migrations treat your real data: that's what the bookmark in the next step, or a [staging environment](06-staging.md), is for.

Push the merge to your repository:

```bash
git push
```

## 3. Apply the schema

Upgrade at a moment with no send in progress. Before applying anything, note where the database is now:

```bash
npx wrangler d1 time-travel info kestrel-production
```

It prints a bookmark for the database's current state; keep it. D1 keeps this history on its own (Time Travel), for 30 days on Workers Paid and 7 on Workers Free, so the bookmark is all **Going back** needs. Use whatever you named the database in **Deploy the app**.

From 1.0.0 the database schema only ever changes by adding a new migration, which this step applies to the database you already have, keeping everything in it. Run it on every upgrade; it is harmless when there is nothing new:

```bash
npm run migrate:remote -- --env production
```

### Coming from a 0.x release

Before 1.0.0, Kestrel changed its schema by editing the baseline migration in place rather than adding a new one. A database that ran a 0.x baseline has no way to take the 1.0.0 one, so moving from any 0.x release to 1.0.0 or later needs the database **rebuilt**, not migrated. This happens once: after it, every upgrade is the command above.

Rebuild the environment's database. A rebuild starts the database empty: posts, subscribers, consent, the send record, and your settings are all gone. Links in emails you already sent stop working too: archive links find no post, and unsubscribe links find no subscriber. Images stay in R2, but nothing refers to them any more. Pick a moment with no send scheduled or in progress, and keep an export as a record:

```bash
npx wrangler d1 export kestrel-production --remote --output kestrel-production-backup.sql
npx wrangler d1 delete kestrel-production
npx wrangler d1 create kestrel-production
```

Paste the new `database_id` into that environment in `wrangler.jsonc` (as in **Deploy the app**) and commit it, then:

```bash
npm run typecheck
npm run migrate:remote -- --env production
```

The export is a record of what was there, not something to load back: it matches the old schema, not the new one. Run the deploy in the next step right away, since the Worker still running is the old release.

## 4. Deploy

```bash
npm run deploy -- --env production
```

Then run the checks in **Verify it works** that the changelog entries touch.

## 5. Confirm the version

Reload the editor and check the version at the foot of the Docs tab's contents rail, or call `GET /api/version`. The version should be the release's, and the commit the one you deployed.

The version links to its release page only when the deployed commit is the tagged commit itself. A build from a merge on your own branch is a different commit, so it shows the version and commit without that link; that is expected, not a sign that something went wrong.

## Going back

To back out, deploy your branch as it was before the merge. The app cannot roll back its schema, but D1 can: once the previous release is deployed, put the database back to the bookmark from step 3:

```bash
npx wrangler d1 time-travel restore kestrel-production --bookmark=<bookmark>
```

A restore returns the whole database to that moment, so everything written since is gone: posts edited, subscribers who signed up, and the record of anything sent. Restore only soon after the upgrade, and never past a send that went out or an unsubscribe recorded since the bookmark: the restored database would not know of them, so it could mail those recipients again or mail someone who left. If either happened, stay on the new release instead.

If the upgrade rebuilt the database, the previous release expects the old baseline, so going back means rebuilding again, with the same loss.
