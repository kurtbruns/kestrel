# Changelog

All notable changes to Kestrel are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Kestrel follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). How an entry is written, and how a release is cut, lives in [`.claude/rules/changelog.md`](.claude/rules/changelog.md).

## [Unreleased]

<!-- Add entries under Added / Changed / Fixed / Breaking. One operator-facing line each; see .claude/rules/changelog.md. -->

### Changed

- The migration history is squashed into a single baseline, `0001_init.sql`; no deployed database had run the old chain. The baseline is edited in place until the first deployment, and it has since gained a column, so a local database created before this change must be rebuilt: delete `.wrangler/state/v3/d1` and run `npm run migrate:local`.
- The send list's status filter no longer accepts `failed`: a send never fails, it keeps retrying and hands the one ambiguous case to you (SPEC §12). The dashboard alert for it, which could never fire, is gone.
- Scheduling a post, or sending it now, keeps you on the post in its scheduled state instead of moving to the Sent page; the confirmation names the fire time.
- The composer's tabs are Edit and Preview, with icons. A scheduled post opens on Preview; its Edit tab keeps the text readable and copyable, says "Cancel the schedule to edit" beneath it (and pulses that line when an edit is attempted), and keeps the formatting toolbar in view, disabled.

### Fixed

- Two settings writers at once (the identity fields and the logo, or the editor and Claude) no longer overwrite each other's change.

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
