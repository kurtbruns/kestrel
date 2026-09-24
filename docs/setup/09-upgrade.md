# Upgrade to a new release

How to move a running instance to a newer release. Do it on **staging** first, prove it, then repeat for **production**, the same order you set the instance up in.

Nothing here runs from inside the app, and the app cannot undo it for you: a deploy is yours to repeat, but a schema change is not something the app can roll back.

## 1. Read the changelog

Find the version you are running: the editor shows it at the foot of the Docs and API tabs' contents rail (version, then commit), and `GET /api/version` returns it with the release tag and build time.

Then read `CHANGELOG.md` for every version between yours and the one you are moving to. Take any **Breaking** entry seriously before starting: it names something you have to change (a variable, a binding, a DNS record) for the new release to run. Note too any entry that says it **touches the database baseline**; step 3 depends on it.

## 2. Check out the release

Releases are tagged `vX.Y.Z`. Fetch the tags and move to the one you want, then install and run the gate:

```bash
git fetch --tags
git checkout vX.Y.Z
npm install
npm test
npm run typecheck
```

If you keep your own commits (your D1 ids in `wrangler.jsonc`, your `repository` in `package.json`), fetch the tags from the upstream remote and merge the tag into your branch instead of checking it out, then install and run the gate the same way.

## 3. Apply the schema

Until 1.0.0, Kestrel changes its database schema by editing the baseline migration in place rather than adding a new one. A database that already ran the old baseline has no way to take the new one, so a 0.x release that changes the schema needs the database **rebuilt**, not migrated. The changelog entry for that release says so ("This touches the database baseline, so rebuild the database").

**If no entry between your version and the target touches the baseline,** apply migrations as usual. This is harmless when there is nothing new:

```bash
npm run migrate:remote -- --env staging
```

**If an entry does,** rebuild the environment's database. A rebuild starts the database empty: posts, subscribers, consent, the send record, and your settings are all gone, and the archive links in emails you already sent stop resolving. Images stay in R2, but nothing refers to them any more. Pick a moment with no send scheduled or in progress, and keep an export as a record:

```bash
npx wrangler d1 export kestrel-staging --remote --output kestrel-staging-backup.sql
npx wrangler d1 delete kestrel-staging
npx wrangler d1 create kestrel-staging
```

Paste the new `database_id` into that environment in `wrangler.jsonc` (as in **Provision**), then:

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

Prove staging with the checks in **Verify it works** that the changelog entries touch, then repeat steps 3 and 4 with `--env production`.

## 5. Confirm the version

Reload the editor and check the version at the foot of the Docs tab's contents rail, or call `GET /api/version`. The version links to its release only when the deployed commit is the tagged release itself; a build from any other commit shows the version and commit without a release link, so a missing link means you deployed something other than the tag.

## Going back

To back out, check out the previous tag and deploy it. The app cannot roll back its schema: if the upgrade rebuilt the database, the previous release expects the old baseline, so going back means rebuilding again, with the same loss.
