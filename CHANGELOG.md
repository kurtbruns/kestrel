# Changelog

All notable changes to Kestrel are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Kestrel follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). How an entry is written, and how a release is cut, lives in [`.claude/rules/changelog.md`](.claude/rules/changelog.md).

## [Unreleased]

<!-- Add entries under Added / Changed / Fixed / Breaking. One operator-facing line each; see .claude/rules/changelog.md. -->

### Added

- Kestrel now emails you when a send goes out (how many the provider accepted, how many are unsent or skipped, and a link to the record), and right away if a send runs into a problem (SPEC §8). Each event is one email. Set the address under Settings → Notifications, where you can send a test and see how the last one went. Declare a `send_email` binding named `NOTIFY` so notifications go through Cloudflare's own email and still arrive when your provider refuses the account; without it they go through your provider (see the setup guide's new Notifications step). This touches the database baseline, so rebuild the database as described in the first Fixed entry below.
- `GET /api/reference` now tags each route with the resource it acts on (posts, sends, subscribers, and so on) and lists each tier's resources, so a client can group the routes the way the reference does.

### Changed

- A `SUBREQUEST_BUDGET` below 30 is now raised to 30 (it was 25), so each sweep tick keeps room to send a notification.
- The Settings page's publication identity section drops its "No posts scheduled" / "In use" chip, and its note is shorter: it says the identity appears in every email and, only while posts are scheduled, how many emails a save would update.
- The API reference groups each tier's routes by resource, shows each route as one line that opens to its details, and adds a filter above the routes (press `/` to focus it). An opened route shows its examples with syntax colors and a curl command for your instance, each with a copy button.
- A send the provider has halted (an outage, a rate limit, or a refused account) is retried with growing gaps instead of every minute: an outage after 1, 2, 5, 15, and 30 minutes, a refused account after 5, 15, and 30, then hourly, until the provider answers, at which point the send is back to full speed. Nobody is marked unsent while it waits, and the send's watch says when the next retry is due; once you fix a refused account, the send resumes at that retry, at most an hour later. `GET /api/reference` documents the new `halt_retries`, `halt_retry_at`, and `provider.halt.retry_at` fields. This touches the database baseline, so rebuild the database as described in the first Fixed entry below (SPEC §12).

### Fixed

- A send through Resend to 100 or more subscribers now goes out; before, it never left `sending`. Until 1.0.0 the database baseline is edited in place, and this change touches it, so any database that ran the old baseline is rebuilt, not migrated: locally, stop `wrangler dev`, delete `.wrangler/state/v3/d1`, and run `npm run migrate:local`; a deployed database is recreated and `npm run migrate:remote` run against it.
- A large send now spans several sweep ticks, each staying inside Cloudflare's per-invocation limits, instead of being cut off partway through a batch; a Resend batch interrupted after it was accepted is re-sent under the same idempotency key, so no one is mailed twice. The default fits the Workers Free plan; on Workers Paid, set `SUBREQUEST_BUDGET` to 1000 for faster sends (see the setup guide's Provision step).
- A provider outage (Resend or SES down, erroring, or rate-limiting) no longer uses up recipients' retries: the send stays open and retries until the provider is back, and mails everyone exactly once, instead of recording the whole audience unsent after about five minutes and closing as sent (SPEC §12).
- A Resend key that is invalid, revoked, or restricted, a sender that is not verified, a spent Resend sending quota, or an SES account that is paused or suspended now pauses the send with nobody marked unsent, instead of recording the whole audience unsent (one SES request per recipient, each with the same error). The dashboard, the Sent page, and the send's watch show it as one alert carrying the provider's message and what to fix, linked to the send, and the send resumes on its own once the account is fixed; anyone who unsubscribes meanwhile is not mailed. `GET /api/reference` documents the new `halt_*`, `provider.halt`, and `attention.refused` fields. This touches the database baseline, so rebuild the database as described in the first entry above.
- A Resend batch whose outcome was unknown (the request failed after it may have been accepted) is no longer re-sent once Resend has forgotten its idempotency key, about a day later; its recipients wait for Resolve instead of risking a second copy.
- Scheduling a post, or sending it now, no longer goes ahead when the save it runs first was refused because the draft had changed elsewhere; it would have frozen the other writer's version. The dialog closes on the out-of-date banner instead, and your unsaved edits are left as they were.
- Uploading or removing the publication logo now updates the confirmation email's preview at once, instead of leaving the old logo there until another field is edited.
- The API reference's method badges (GET/POST/PUT/DELETE) now follow dark mode instead of staying their light-mode colors.
- A malformed API request is now a 400 that names the problem instead of a silent no-op or a server error: a body that is not a JSON object, a field of the wrong type (named in the message and as `field` on the error), and a path with a broken percent-escape. Saving a post with a wrongly typed field, or a `base_revision` that is not a string, is refused instead of saved without that field or without the out-of-date check, and a post save must send a JSON body. A database failure while saving settings is now reported as a server error, not as a bad request.

## [0.2.0] - 2026-09-21

### Changed

- The migration history is squashed into a single baseline; no deployed database had run the old chain. Until 1.0.0 the baseline is edited in place, so when it changes an existing database is rebuilt, not migrated: delete `.wrangler/state/v3/d1` and run `npm run migrate:local`.
- The send list's status filter no longer accepts `failed`: a send never fails, it keeps retrying and hands the one ambiguous case to you (SPEC §12). The dashboard alert for it, which could never fire, is gone.
- Scheduling a post, or sending it now, keeps you on the post in its scheduled state instead of moving to the Sent page; the confirmation names the fire time.
- The composer's tabs are Edit and Preview, with icons. A scheduled post opens on Preview; its Edit tab keeps the text readable and copyable, says "Cancel the schedule to edit" beneath it (and pulses that line when an edit is attempted), and keeps the formatting toolbar in view, disabled.
- Saving the email template, or a part of the publication identity the template renders (name, tagline, mailing address, logo), while posts are scheduled re-makes their emails, after you confirm, so no scheduled email goes out on an older look; the API asks for an explicit acknowledgement naming the sends, and refuses while a scheduled send is within five minutes of firing. Their content and fire times are untouched, and a re-made send says so until it fires (SPEC §6, §9).
- The Template and Settings pages say, standing, whether the template and identity are in use by scheduled posts, ask before a save that would apply to their emails, and say afterward how many it applied to. A notice on the post and on the dashboard says when a template or identity change was applied to scheduled posts, until you clear it: the first use of the app's dismissible notice.

### Fixed

- An edit typed while the editor was saving in the background read as saved without having been sent, and leaving the page then could lose it. It now stays unsaved and goes with the next save.
- A test or preview of a scheduled post sends its frozen copy, exactly as it will fire, and of a sent post its record, instead of a live render that could differ from either (SPEC §5).
- Two settings writers at once (the identity fields and the logo, or the editor and Claude) no longer overwrite each other's change.
- In the reference room, the tab for the page you are already on (and the Kestrel wordmark on the docs index) now scrolls back to the top instead of doing nothing.

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

[Unreleased]: https://github.com/kurtbruns/kestrel/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/kurtbruns/kestrel/releases/tag/v0.2.0
[0.1.0]: https://github.com/kurtbruns/kestrel/releases/tag/v0.1.0
