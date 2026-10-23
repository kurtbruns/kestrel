---
name: release
description: Cut a Kestrel release and carry it through to the npm packages, getkestrel.dev, and the live demo. Reviews [Unreleased], opens the release PR, tags the merge, publishes the GitHub release, confirms npm, then moves both downstream pins and checks them live. Use when the maintainer asks to cut, ship, or tag a release ("cut 1.14.0", "release what's on main").
disable-model-invocation: true
argument-hint: "[version]"
---

# Cut a release

When to cut and how to number it are `.claude/rules/release.md`. This is the procedure. Copy the checklist into your plan, and check each step's result before starting the next.

```
- [ ] 1. [Unreleased] reviewed against main
- [ ] 2. Release PR gated, approved, merged
- [ ] 3. Tag pushed, GitHub release published
- [ ] 4. npm serves the version, for both packages
- [ ] 5. Site and demo PRs open, CI green, merged
- [ ] 6. Site and demo live on the version
```

## 1. Review

From the latest `origin/main`, read every commit since the last tag (`git log $(git describe --tags --abbrev=0)..origin/main`).

- Each user-facing or operator-visible commit has its line under the right heading (`.claude/rules/changelog.md`), and an internal one has none.
- The documents describe what this release does. A design that isn't built yet waits in its own PR, to land with its code, and isn't written as shipped behavior in `docs/SPEC.md`, `docs/API.md`, or `docs/DESIGN.md`.
- Pick the number from `.claude/rules/release.md`. Any `Breaking` line means at least a release bump.

Fix a gap in its own PR first, or ask the maintainer when the fix is a decision.

## 2. Release PR

On a branch off `origin/main`:

1. Rename `## [Unreleased]` to `## [X.Y.Z] - <today>`, and add a fresh, empty `## [Unreleased]` above it that keeps the HTML comment hint.
2. `npm version X.Y.Z --no-git-tag-version` (bumps `package.json` and `package-lock.json` together, no commit, no tag), then the client's to match: `npm version X.Y.Z --no-git-tag-version --prefix packages/kestrel`. The two packages always carry one version.
3. At the bottom of `CHANGELOG.md`, point `[Unreleased]` at `compare/vX.Y.Z...HEAD` and add `[X.Y.Z]: …/releases/tag/vX.Y.Z`.
4. Run the gate: `npm test`, `npm run typecheck`, `npm run check:package`, `npm run check`.
5. Open a PR titled "Release X.Y.Z", and merge it as `.claude/CLAUDE.md` says (Issues and pull requests).

## 3. Tag and GitHub release

Tag the squash commit on `main`, after checking that its `package.json` names X.Y.Z. A tag on the branch would point at the wrong commit.

```bash
git tag -a vX.Y.Z -m "kestrel vX.Y.Z" <merge sha>
git push origin vX.Y.Z
awk '/^## \[X.Y.Z\]/{f=1;next} /^## \[|^\[.*\]: /{f=0} f' CHANGELOG.md | gh release create vX.Y.Z --verify-tag --title "kestrel vX.Y.Z" --notes-file -
```

Push that tag alone, never `--tags`. The notes are the changelog section verbatim. `--verify-tag` refuses to run before the tag is on the remote, so the release can't mint its own tag at the wrong commit. Check that `gh release view vX.Y.Z` shows the section.

## 4. npm

Publishing the release runs `.github/workflows/publish.yml`, as two jobs: `build` (the gate and both tarballs) and then `publish`. Watch that run (`gh run watch <id> --exit-status`). A failure in `build` published nothing; one in `publish` is safe to re-run (`gh run rerun <id> --failed`), since it skips a version already on npm. That reuses the run's tarballs, kept 7 days; after that, re-run the whole workflow (`gh run rerun <id>`), which rebuilds them from the tag. Then confirm with `npm view @kurtbruns/kestrel version` and `npm view kestrel version`. For a few minutes after a green run, npm can still report the previous version: when the run's log shows `+ @kurtbruns/kestrel@X.Y.Z` and `+ kestrel@X.Y.Z`, wait and check again. Never publish by hand to make up for the delay.

## 5. Site and demo

Two repositories pin a release in `.kestrel-version` and move only by a PR. Their bumps don't depend on each other, so run them in parallel, one agent each. A session here doesn't load their context, so each agent clones its repo, reads its `.claude/CLAUDE.md`, and follows its skill:

- `kurtbruns/getkestrel.dev`: `.claude/skills/refresh-from-kestrel/SKILL.md` re-syncs the docs, reconciles the landing copy and screenshots, and opens the PR.
- `kurtbruns/demo.getkestrel.dev`: `.claude/skills/update-kestrel/SKILL.md` carries the patch set across, keeps the wrapper's shim honest, re-checks sandbox isolation, and opens the PR.

When a release breaks something downstream, a patch that no longer applies or a spec that expects the old wire, fix it in that repository's PR. Never hold the release back for it. Review each PR's diff yourself before it's merged, then merge it as that repository says.

## 6. Live

Each merge to `main` deploys. Watch both Deploy runs go green, then check what visitors get:

- **Site:** a docs page the release changed shows the new text (`curl -s https://getkestrel.dev/docs/<slug>/`, slugs as in `content/docs/`).
- **Demo:** `curl -s https://demo.getkestrel.dev/api/version` reports `vX.Y.Z`, and a fresh cookie jar's `GET /api/posts?status=sent` lists the seeded posts.

Report the GitHub release, the npm version, both merged PRs, and both deploys, with links.
