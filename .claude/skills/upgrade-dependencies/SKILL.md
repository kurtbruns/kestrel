---
name: upgrade-dependencies
description: Checks and upgrades Kestrel's npm dependencies and clears security advisories, looking at publish age, release notes, and what a version moves before anything changes, then proving the email render and the tree didn't move unexpectedly. Use when asked whether dependencies are up to date, to upgrade or bump a package, to run npm audit, to fix an advisory, or to update the lockfile.
---

# Upgrade dependencies

Look first and change nothing until the user has said which packages move, unless their request already named them. A question such as "are we up to date?" ends at the report in step 2, with no test run and no file changed.

```
- [ ] 1. Each candidate looked at and sorted
- [ ] 2. Reported, and the user said go
- [ ] 3. npm version checked, baseline recorded
- [ ] 4. Applied
- [ ] 5. What moved reviewed
- [ ] 6. Gate run on the final tree
```

## 1. Look at each candidate

These only read. If `node_modules` is missing, run `npm ci` first.

```bash
node .claude/skills/upgrade-dependencies/scripts/candidates.mjs
npm audit
npm audit --omit=dev
```

`candidates.mjs` names, for each outdated package, the newest version within its major that has aged the cooldown, and flags a newer major, a newer version still cooling down, and install scripts.

**Cooldown.** Take the newest version at least 3 days old, since a compromised release is usually caught within days. An advisory the project is really exposed to can justify a younger version, as the user's decision.

**Read what changed.** Read the release notes between the current and target version, and each advisory from `npm audit`. Then say who is exposed:

- A finding `--omit=dev` keeps is in a package an instance's Worker runs.
- A finding it drops can still reach people. `wrangler` is a dev dependency here, yet it runs on every operator's machine, and its peer range sets their minimum.
- `dependencies` stay outside the built bundle, and the scaffold ships no lockfile, so a new instance installs the newest version in the published range. The cooldown and comparisons here cover what this repository tests, not what that install gets. Raising a range's minimum reaches every instance.

**Sort each one:**

- **Routine:** the change stays in `package.json` and the lockfile, and nothing below applies.
- **Reaches the email:** `marked` and `@css-inline/css-inline-wasm` shape the render path (I5), so a bump can change what subscribers get with every test green. Each gets its own pull request, a comparison (below), and a changelog line. A difference may be a welcome fix, so report each one instead of treating it as failure. Sent and scheduled posts keep their frozen render (I3), so only later renders change.
- **A project:** a new major, a change that reaches config or source, or a formatter or linter that rewrites the tree. Each gets its own pull request, and the release notes come first. A Biome version of any size can bring new formatting and warnings, so report it as unknown until tried. After the go-ahead, try it with step 6's `npm run check` and `git status`.

**Comparing `marked`.** This is the parser alone. `src/render/markdown.ts` adds its own image renderer and warnings, which only the render specs exercise.

```bash
node .claude/skills/upgrade-dependencies/scripts/compare-render.mjs <old> <new> docs template demo/posts README.md CHANGELOG.md
```

**Comparing `css-inline`.** Save a draft's email before and after, restarting the dev server between them, then diff the two files. Use a draft, since a sent or scheduled post returns its frozen copy. `preview.json` won't do, since it carries no HTML.

```bash
npm run dev                                             # in its own terminal
npm run seed                                            # resets the local database
node bin/kestrel.mjs api --local GET /api/posts         # the id of the post with the slug try-editing-this-draft
node bin/kestrel.mjs api --local GET /api/posts/<id>/preview > <scratchpad>/before.html
```

**Packages that move together:**

- `@cloudflare/vitest-plugin` pins an exact `wrangler`. Move them as a pair, choosing the plugin version that pins the `wrangler` you want.
- `wrangler` is also a peer dependency, and `kestrel init` copies that range into each new instance, so raise it with `npm pkg set peerDependencies.wrangler=^<version>` and add a changelog line. Check what an existing instance does by installing the packed package into two scratch projects locked at the old version. One with a caret range moves up on its own. One with an exact pin gets `ERESOLVE`, which the release's Upgrading paragraph has to cover.
- `@biomejs/biome` is named in the `$schema` in `biome.json`.
- `@types/node` stays on the Node major that `engines` and CI use, whatever the latest is.

## 2. Report and wait

Give each package's from and to, its publish age, what its notes and advisories mean here, and how it's sorted. List what you'd leave out and why. Then wait, unless the request already covers it.

## 3. Check npm and record a baseline

Run `npm -v`, which has to be 12 or later. Older npm, including what CI's Node 22 bundles, silently ignores `--min-release-age` and runs every install script, so stop and tell the user rather than installing with it.

On a clean tree, run `npm test` and note the file and test counts. If it's red or the tree is dirty, stop and say so. A later pass is "the same counts or more", since a skipped suite is also green.

## 4. Apply

Use one pull request per story, so a change to the email can be reverted without undoing a security fix. Pull requests that each change the lockfile conflict, so stack them or land them in turn.

```bash
npm install --min-release-age=3 <pkg>@<version>
npm install --min-release-age=3 --save-exact -D <pkg>@<version>   # for a package pinned exactly in package.json
```

Never delete `package-lock.json`, which re-resolves the whole tree unreviewed. Never run `npm audit fix --force`: it can take a major without a look, and it can downgrade a package.

## 5. Review what moved

```bash
node .claude/skills/upgrade-dependencies/scripts/lock-moves.mjs [ref]
npm audit signatures
```

`lock-moves.mjs` compares the lockfile with where the branch left `origin/main`, or with `ref`, package by package, because reordering and deduping can make the raw diff thousands of lines. On a stacked branch, name the branch beneath it as `ref`. It exits 1 on a package whose address or hash looks wrong or changed, a new install script, or a Linux binary CI needs that's missing or the wrong version.

Each move has to be one you named or one a named package pulls in. npm 12 holds back an install script not listed under `allowScripts` and says so. Whether to add one, to `package.json` and to `template/package.json`, is a question for the user, never a line to add quietly.

## 6. Gate

Run `npm test`, `npm run typecheck`, `npm run check`, `npm run ci`, and `npm run check:package`.

`npm run check` writes files and its exit code doesn't report that, so read `git status` afterward, along with its warning count. A file you didn't mean to change means the upgrade is a project: restore the file, take the package back out, and report it. Never keep a rewrite to get a pass, or update a spec's expectation to absorb a change without reading it.

After merging `main` into the branch, run `lock-moves.mjs` and the gate again, and check any changelog line of yours is still under `[Unreleased]`, since a release may have landed and git won't flag it. Then write the description with the `pr-description` skill: the versions, what you left out and why, and the checks. Tooling alone earns no changelog line.
