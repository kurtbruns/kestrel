---
paths:
  - "CHANGELOG.md"
  - "package.json"
  - ".github/workflows/publish.yml"
---

# Cutting a release

A release starts in this repository and reaches three places beyond it: the npm package that instances install, the docs on getkestrel.dev, and the live demo at demo.getkestrel.dev. The package publishes itself from the tag. The site and the demo each pin a release and move only when someone opens a PR to move the pin, so a release isn't finished until both have. What goes in `CHANGELOG.md`, and how each line is written, is `.claude/rules/changelog.md`.

**When.** Kestrel is self-hosted, so a release is not tied to any one deploy: operators upgrade on their own schedule, and what the maintainer controls is what `[Unreleased]` would hand them. Cut a release when `[Unreleased]` holds something an operator would want to upgrade for (a feature, or a fix they would notice), and promptly after a `Breaking` line lands, so the break ships under its own version instead of riding a later one. Between releases every build still identifies itself: the build stamp carries the version and the commit, so a build off `main` is never mistaken for the release before it.

**How.** A release is cut by the maintainer, by hand. The edit below can land through a pull request like any other change; the tag goes on `main` once it is there (a tag on a feature branch would point at the wrong commit), and the GitHub release follows the tag:

1. Rename `## [Unreleased]` to `## [X.Y.Z] - <date>` and add a fresh, empty `## [Unreleased]` above it.
2. Run `npm version X.Y.Z --no-git-tag-version`, which bumps `package.json` and `package-lock.json` together without committing or tagging.
3. Update the link references at the bottom of `CHANGELOG.md` (`[Unreleased]` compare, new `[X.Y.Z]` tag).
4. Commit, then `git tag -a vX.Y.Z -m "kestrel vX.Y.Z"` and `git push origin vX.Y.Z` (that tag alone, not `--tags`, which would push every local tag).
5. Publish the GitHub release from the tag, with that version's section of the changelog as its notes, so the release page (the one the changelog's version links and the build stamp point at) says what changed instead of showing a bare tag:

   ```bash
   awk '/^## \[X.Y.Z\]/{f=1;next} /^## \[|^\[.*\]: /{f=0} f' CHANGELOG.md | gh release create vX.Y.Z --verify-tag --title "kestrel vX.Y.Z" --notes-file -
   ```

   A tag and a release are separate objects: pushing the tag alone leaves the Releases page empty. The notes are the changelog section verbatim, so the two never say different things, and `--verify-tag` refuses to run before the tag is on the remote, so a release can never mint its own tag at the wrong commit.

6. Publishing the release runs `.github/workflows/publish.yml`, which builds the package from the tag and publishes it to npm as `@kurtbruns/kestrel`, the version instances install. Watch the run go green, then confirm with `npm view @kurtbruns/kestrel version`. It refuses a tag that doesn't match `package.json`, so a release cut by the steps above publishes the version it names.

7. Move the docs site to the release: in `kurtbruns/getkestrel.dev`, a PR that sets `.kestrel-version` to the tag. Its deploy clones Kestrel at that tag and builds the docs from it, so the setup guide people read before they install matches what npm serves. Check the deploy goes green and the site's docs show the release.
8. Move the demo to the release: in `kurtbruns/demo.getkestrel.dev`, a PR that sets `.kestrel-version` to the tag. Its build clones Kestrel at the tag and applies the demo's patches to its source, so a patch that no longer applies fails that PR, naming the patch; fix the patch there, never by holding the release back. Check the deploy goes green and a fresh sandbox loads.

Pick the number against the last tag. Versions are `MAJOR.RELEASE.PATCH`, not semver: Kestrel is an app its operators upgrade, so the changelog, not the number, says what breaks.

- **Major:** only when the maintainer decides (a rewrite, or an upgrade that can't be made in one step), never because of a `Breaking` entry. It resets the other two: `1.4.2` → `2.0.0`.
- **Release:** any release with more than fixes, breaking changes included: `1.1.0` → `1.2.0`.
- **Patch:** fixes only: `1.2.0` → `1.2.1`. Never a feature or a `Breaking` entry.

## Publishing to npm

Releases publish through npm's trusted publishing: npmjs.com trusts `publish.yml` in this repository, each run gets a short-lived OIDC token, and no npm token is stored anywhere. Provenance comes with it, so each version on npmjs.com links to the commit and run that built it. Nothing else publishes; a publish by hand is only for the setup below.

Set up once, by the maintainer, since npm configures a trusted publisher only for a package that already exists:

1. Publish the first version by hand from its release tag, after step 4 of cutting it and before step 5: `npm login`, then `npm publish` in a clean checkout of the tag (`npm ci` first; `prepare` builds the package). The workflow that step 5 then runs finds the version on npm and leaves it alone.
2. Make the workflow the publisher, on npmjs.com under the package's **Settings → Trusted Publisher** (GitHub Actions; user `kurtbruns`, repository `kestrel`, workflow `publish.yml`), or with `npm trust github @kurtbruns/kestrel --file publish.yml --repo kurtbruns/kestrel --allow-publish` (npm 11.15 or later, two-factor authentication on).
3. Under **Settings → Publishing access**, choose **Require two-factor authentication and disallow tokens**, so only the workflow (or the maintainer with two-factor) can publish.

## What the site and the demo rely on

Two parts of this repository are read by the others, and nothing here checks them, so a change to either is a change for them too:

- **The docs indexes.** getkestrel.dev's sync script parses `docs/README.md` and `docs/publishing/README.md` the way the Docs tab does (`.claude/rules/docs.md`): the H1 and intro, each `##` section with its blurb and list of pages, numbered lists for steps, the `NN-` file prefixes, and relative links. Change that format and the site's sync changes with it.
- **The lines the demo patches.** The demo applies patches to Kestrel's source, for its auth, the fake outbox, `noindex`, its chrome, and the import limit (`patches/` there). A release that changes those lines fails the demo's pin PR, which is where it is fixed.
