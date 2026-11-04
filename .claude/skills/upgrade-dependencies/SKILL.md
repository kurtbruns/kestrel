---
name: upgrade-dependencies
description: Checks and upgrades Kestrel's npm dependencies and clears security advisories, looking at publish age, release notes, and what a version moves before anything changes, then proving the email render and the tree didn't move unexpectedly. Use when asked whether dependencies are up to date, to upgrade or bump a package, to run npm audit, to fix an advisory, or to update the lockfile.
---

# Upgrade dependencies

Look first and change nothing until the user has said which packages move, unless their request already named them. A question such as "are we up to date?" ends at the report in step 3.

```
- [ ] 1. Baseline recorded
- [ ] 2. Each candidate looked at and sorted
- [ ] 3. Reported, and the user said go
- [ ] 4. Applied
- [ ] 5. What moved reviewed
- [ ] 6. Gate run on the final tree
```

## 1. Baseline

On a clean tree, run `npm test` and note the file and test counts. If it's red or the tree is dirty, stop and say so. A later pass is "the same counts or more", since a skipped suite is also green.

## 2. Look at each candidate

```bash
node .claude/skills/upgrade-dependencies/scripts/candidates.mjs
npm audit
npm audit --omit=dev
```

`candidates.mjs` names, for each outdated package, the newest version within its major that has aged the cooldown, and flags a newer major, a newer version still cooling down, and install scripts.

**Cooldown.** Take the newest version at least 3 days old, since a compromised release is usually caught within days. Pass `--min-release-age=3` on every install so npm refuses anything newer, transitive packages included. An advisory the project is really exposed to can justify a younger version, as the user's decision.

**Read what changed.** Read the release notes between the current and target version, and each advisory from `npm audit`. Say whether the project is exposed: only `--omit=dev` findings can reach an instance's running Worker.

**Sort each one:**

- **Routine:** the change stays in `package.json` and the lockfile, and nothing below applies.
- **Reaches the email:** `marked` and `@css-inline/css-inline-wasm` shape the render path (I5), so a bump can change what subscribers get with every test green. Each gets its own pull request and a changelog line. Compare `marked` with `scripts/compare-render.mjs <old> <new> docs template demo/posts README.md CHANGELOG.md`. For `css-inline`, compare a seeded post's `/api/posts/:id/preview.json` before and after. A difference may be a welcome fix, so report each one instead of treating it as failure. Sent and scheduled posts keep their frozen render (I3), so only later renders change.
- **A project:** a new major, a change that reaches config or source, or a formatter or linter that rewrites the tree. Each gets its own pull request, and the release notes come first. Biome can bring new formatting and warnings on any version, so find out with a trial `npm run check` and `git status` before calling it routine.

**Packages that move together:**

- `@cloudflare/vitest-plugin` pins an exact `wrangler`. Move them as a pair, choosing the plugin version that pins the `wrangler` you want.
- `wrangler` is also a peer dependency, and `kestrel init` copies that range into each new instance, so raise it with `npm pkg set peerDependencies.wrangler=^<version>` and add a changelog line. Before the line says an existing instance moves up on its own, install the packed package into a scratch project locked at the old version and see that it does.
- `@biomejs/biome` is named in the `$schema` in `biome.json`.
- `@types/node` stays on the Node major that `engines` and CI use, whatever the latest is.

## 3. Report and wait

Give each package's from and to, its publish age, what its notes and advisories mean here, and how it's sorted. List what you'd leave out and why. Then wait, unless the request already covers it.

## 4. Apply

Use one pull request per story, so a change to the email can be reverted without undoing a security fix. Pull requests that each change the lockfile conflict, so stack them or land them in turn.

```bash
npm install --min-release-age=3 <pkg>@<version>
npm install --min-release-age=3 --save-exact -D <pkg>@<version>   # for a package pinned exactly in package.json
```

Never delete `package-lock.json`, which re-resolves the whole tree unreviewed. Never run `npm audit fix --force`: it can take a major without a look, and it can downgrade a package.

## 5. Review what moved

```bash
node .claude/skills/upgrade-dependencies/scripts/lock-moves.mjs [base-ref]
npm audit signatures
```

`lock-moves.mjs` compares the lockfile with `base-ref` (`HEAD` by default) package by package, because reordering and deduping can make the raw diff thousands of lines. It flags anything not from the npm registry, without an integrity hash, or newly running an install script, and it checks that the Linux binaries CI needs are present. Each move has to be one you named or one a named package pulls in. An install script not listed under `allowScripts` in `package.json` is a question for the user, never a line to add quietly.

## 6. Gate

Run `npm test`, `npm run typecheck`, `npm run check`, `npm run ci`, and `npm run check:package`.

`npm run check` writes files and its exit code doesn't report that, so read `git status` afterward, along with its warning count. A file you didn't mean to change means the upgrade is a project: restore the file, take the package back out, and report it. Never keep a rewrite to get a pass, or update a spec's expectation to absorb a change without reading it.

Run the gate again after merging `main` into the branch, then write the description with the `pr-description` skill: the versions, what you left out and why, and the checks. Tooling alone earns no changelog line.
