---
paths:
  - "CHANGELOG.md"
  - "package.json"
  - ".github/workflows/publish.yml"
---

# Releases

A release starts in this repository and reaches three places beyond it: the npm package that instances install, the docs on getkestrel.dev, and the live demo at demo.getkestrel.dev. The package publishes itself from the tag. The site and the demo each pin a release and move only by a PR that moves the pin, so a release isn't finished until both have. The maintainer decides when to cut one, and the `release` skill (`/release`) carries it through all three. What goes in `CHANGELOG.md`, and how each line is written, is `.claude/rules/changelog.md`.

## When

Kestrel is self-hosted, so a release is not tied to any one deploy: operators upgrade on their own schedule, and what the maintainer controls is what `[Unreleased]` would hand them. Cut a release when `[Unreleased]` holds something an operator would want to upgrade for (a feature, or a fix they would notice), and promptly after a `Breaking` line lands, so the break ships under its own version instead of riding a later one. Between releases every build still identifies itself: the build stamp carries the version and the commit, so a build off `main` is never mistaken for the release before it.

## Numbering

Pick the number against the last tag. Versions are `MAJOR.RELEASE.PATCH`, not semver: Kestrel is an app its operators upgrade, so the changelog, not the number, says what breaks.

- **Major:** only when the maintainer decides (a rewrite, or an upgrade that can't be made in one step), never because of a `Breaking` entry. It resets the other two: `1.4.2` → `2.0.0`.
- **Release:** any release with more than fixes, breaking changes included: `1.1.0` → `1.2.0`.
- **Patch:** fixes only: `1.2.0` → `1.2.1`. Never a feature or a `Breaking` entry.

## Publishing to npm

Releases publish through npm's trusted publishing: npmjs.com trusts `publish.yml` in this repository, each run gets a short-lived OIDC token, and no npm token is stored anywhere. Provenance comes with it, so each version on npmjs.com links to the commit and run that built it. The workflow refuses a tag that doesn't match `package.json`. Nothing else publishes; a publish by hand is only for the setup below.

Set up once, by the maintainer, since npm configures a trusted publisher only for a package that already exists:

1. Publish the first version by hand from its release tag, after pushing the tag and before creating the GitHub release: `npm login`, then `npm publish` in a clean checkout of the tag (`npm ci` first; `prepare` builds the package). The workflow that the GitHub release then runs finds the version on npm and leaves it alone.
2. Make the workflow the publisher, on npmjs.com under the package's **Settings → Trusted Publisher** (GitHub Actions; user `kurtbruns`, repository `kestrel`, workflow `publish.yml`), or with `npm trust github @kurtbruns/kestrel --file publish.yml --repo kurtbruns/kestrel --allow-publish` (npm 11.15 or later, two-factor authentication on).
3. Under **Settings → Publishing access**, choose **Require two-factor authentication and disallow tokens**, so only the workflow (or the maintainer with two-factor) can publish.

## What the site and the demo rely on

Two parts of this repository are read by the others, and nothing here checks them, so a change to either is a change for them too:

- **The docs indexes.** getkestrel.dev's sync script parses `docs/README.md` and `docs/publishing/README.md` the way the Docs tab does (`.claude/rules/docs.md`): the H1 and intro, each `##` section with its blurb and list of pages, numbered lists for steps, the `NN-` file prefixes, and relative links. Change that format and the site's sync changes with it.
- **The lines the demo patches.** The demo applies patches to Kestrel's source for its auth, the fake outbox, `noindex`, its chrome, and the import limit (`patches/` there), and its wrapper imports a slice of Kestrel's modules through a hand-written declaration that `tsc` can't check against the source. A release that changes those lines or signatures fails the demo's pin PR or its tests, which is where it is fixed.
