# Changelog

All notable changes to Kestrel are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Kestrel follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). How an entry is written, and how a release is cut, lives in [`.claude/rules/changelog.md`](.claude/rules/changelog.md).

## [Unreleased]

<!-- Add entries under Added / Changed / Fixed / Breaking. One operator-facing line each; see .claude/rules/changelog.md. -->

### Added

- The email template keeps a history: every save is a revision, any past revision can be restored (as a new save, never by rewriting history), and every scheduled send records the revision it was made with. Saving the template reports which scheduled posts keep the template they were made with, and each can be updated to the current template in one step, keeping its place in the queue (SPEC §9).
- Scheduling or sending a post again after the template has changed asks which template to use, the one it had or the current one, and refuses until told; nothing about a post's look is decided silently (SPEC §6).
- The API carries the same facts and choices: a post reports its template facts, schedule and send accept `template_revision`, a scheduled send can be updated to the current template, and the template's history can be listed and restored.

### Changed

- The template editor states the rule plainly: a saved change applies to posts scheduled from now on, a post already scheduled keeps the template it was made with until updated, and a sent post never changes. Wherever a scheduled send is listed, one made with an older template than the current one is marked, with Update beside Reschedule and Cancel.
- Saving the template while posts are scheduled shows which of them keep the previous template, with Update and Update all.

### Fixed

- A scheduled post's test email and preview are its frozen copy, exactly what will fire, so a template or identity change made after scheduling can no longer make the test disagree with what goes out (SPEC §5). A sent post's preview and test are the record's frozen copy.

### Changed

- The migration history is squashed into a single baseline, `0001_init.sql`; no deployed database had run the old chain. A local database created before the squash keeps working; to rebuild one from the baseline, delete `.wrangler/state/v3/d1` and run `npm run migrate:local`.
- The send list's status filter no longer accepts `failed`: a send never fails, it keeps retrying and hands the one ambiguous case to you (SPEC §12). The dashboard alert for it, which could never fire, is gone.

## [0.1.0] - 2026-09-19

The first tagged release: a self-contained newsletter app on a Cloudflare Worker over D1 and R2, with a cron-driven send sweep and a swappable email provider.

### Added

- Markdown authoring with a single render path shared by preview, test, schedule, and send, so a clean test proves exactly what ships.
- Scheduling behind a cancelable review window: the render is frozen and the post soft-locked when scheduled, and stays cancelable until it fires. "Send now" runs the same path after a short cancelable buffer.
- Batched, idempotent delivery: a retry or restart never re-mails a recipient the provider already accepted.
- A double opt-in subscriber list the app owns end to end: consent, one-click unsubscribe, and suppression from bounces and complaints via provider webhooks.
- A permanent per-post public archive (view-in-browser), self-contained on the app's own origin, with an optional archive-on-your-apex enhancement.
- A public reader surface: landing page, archive index, and subscribe / confirm / unsubscribe.
- An admin editor and authoring API behind Cloudflare Access (human SSO plus a service token for Claude), with a local dev token for local-only development.
- Configurable publication identity (name, tagline, logo), email template, and confirmation-email wording, plus default test recipients. Preferences only, never secrets.
- A swappable email-provider seam with a fake in-memory transport for local dev and tests, alongside SES and Resend adapters.
- An in-app reference room: the setup guide and the API reference, served read-only inside the editor.
- A build-version stamp: every instance reports its version, commit, and build time, read-only in the editor and at `GET /api/version`.
- This changelog and a semantic-versioning release process.

[Unreleased]: https://github.com/kurtbruns/kestrel/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kurtbruns/kestrel/releases/tag/v0.1.0
