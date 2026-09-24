# Upgrade to a new release

How to move a running instance to a newer release. Do it on **staging** first, prove it, then repeat for **production**, the same order you set the instance up in.

Nothing here runs from inside the app, and the app cannot undo it for you: a deploy is yours to repeat, but a schema change is not something the app can roll back.

## 1. Read the changelog

Find the version you are running: the editor shows it at the foot of the Docs and API tabs' contents rail (version, then commit), and `GET /api/version` returns it with the release tag and build time.

Then read `CHANGELOG.md` for every version between yours and the one you are moving to. Take any **Breaking** entry seriously before starting: it names something you have to change (a variable, a binding, a DNS record) for the new release to run. Note too any entry that says it **touches the database baseline**; step 3 depends on it.

## 2. Bring in the release

Releases are tagged `vX.Y.Z`. Your deploy branch carries your own commits (the D1 ids and origins you set in `wrangler.jsonc` during **Provision**, and your `repository` in `package.json`), so merge the release tag into it rather than checking the tag out, which would leave those behind. With the upstream project as a remote named `upstream`:

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

If you deploy from an untouched clone with no commits of your own, `git fetch --tags && git checkout vX.Y.Z` does the same job.

## 3. Apply the schema

Until 1.0.0, Kestrel changes its database schema by editing the baseline migration in place rather than adding a new one. A database that already ran the old baseline has no way to take the new one, so a 0.x release that changes the schema needs the database **rebuilt**, not migrated. The changelog entry for that release says so ("This touches the database baseline, so rebuild the database").

**If no entry between your version and the target touches the baseline,** apply migrations as usual. This is harmless when there is nothing new:

```bash
npm run migrate:remote -- --env staging
```

**If an entry does,** rebuild the environment's database. A rebuild starts the database empty: posts, subscribers, consent, the send record, and your settings are all gone. Links in emails you already sent stop working too: archive links find no post, and unsubscribe links find no subscriber. Images stay in R2, but nothing refers to them any more. Pick a moment with no send scheduled or in progress, and keep an export as a record. For staging (use `kestrel-production` for production, or whatever you named the database in **Provision**):

```bash
npx wrangler d1 export kestrel-staging --remote --output kestrel-staging-backup.sql
npx wrangler d1 delete kestrel-staging
npx wrangler d1 create kestrel-staging
```

Paste the new `database_id` into that environment in `wrangler.jsonc` (as in **Provision**) and commit it, then:

```bash
npm run typecheck
npm run migrate:remote -- --env staging
```

The export is a record of what was there, not something to load back: it matches the old schema, not the new one. Run the deploy in the next step right away, since the Worker still running is the old release.

From 1.0.0 the baseline is frozen, and this step only ever applies new migrations to the database you already have.

## 4. Deploy

```bash
npm run deploy -- --env staging
```

Prove staging with the checks in **Verify it works** that the changelog entries touch, then repeat steps 3 and 4 for production: `--env production`, and `kestrel-production` in the rebuild commands.

## 5. Confirm the version

Reload the editor and check the version at the foot of the Docs tab's contents rail, or call `GET /api/version`. The version should be the release's, and the commit the one you deployed.

The version links to its release page only when the deployed commit is the tagged commit itself. A build from a merge on your own branch is a different commit, so it shows the version and commit without that link; that is expected, not a sign that something went wrong.

## Going back

To back out, deploy your branch as it was before the merge (or the previous tag, from an untouched clone). The app cannot roll back its schema: if the upgrade rebuilt the database, the previous release expects the old baseline, so going back means rebuilding again, with the same loss.
