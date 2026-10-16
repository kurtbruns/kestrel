# Kestrel API

The shape of Kestrel's authoring API: the rules every route follows, so a client that has learned one route can predict the rest. The spec (`docs/SPEC.md`) says what both clients can rely on; this document says the shape they rely on it through. The generated API reference, served in the admin surface and built from the route registration in `src/app.ts`, lists every route, field, and example, so this document names concepts and never restates a route.

**Who this is for.** Whoever adds to the API or builds a client for it, human or Claude.

**Where it lives.** Every route of the API sits under `/api`, which is also the admin line: the editor at `/dashboard` and the API at `/api` are the publisher's, behind the access layer, and everything else is the public reader surface (SPEC §11). A new route goes under `/api` too, so it is gated with nothing for an instance to add. Before 1.3.0 the posts, sends, subscribers, and suppressions routes sat at the top level (`/posts`, and so on); those paths now answer `404`.

**Status.** Draft. It describes the API as the principles below would have it. Where `main` differs today (the send's ETag, the feed's cursor, tombstones, and pace), the gap is tracked on GitHub as simplification deferred until real use shows which parts matter; this note goes once `main` matches.

---

## The bet

Kestrel has two clients, the web editor and Claude, and both act for one publisher (SPEC §1). They stay on the same page because they read and act through one API over one copy of the data, and neither keeps a rule of its own about what the data means. So the API carries the design weight. It has to be **robust**: a retry, a race, or a late read never leaves a client believing something false. And it has to be **small enough to learn from its reference**: Claude meets it cold in every conversation, and a concept that only the editor's author understands is one Claude will use wrongly.

When those two pull against each other, prefer the smaller API and a documented expectation, as long as no invariant (SPEC §3) rests on the difference.

## Principles

1. **One API, no private door.** The editor uses no route that Claude cannot, and no route exists only to serve the editor's layout. The one exception is the development tooling under `/api/dev/`, which exists only on a local instance.

2. **One shape per noun.** A resource reads the same on every route that carries it: in a list, alone, in the feed, and in the answer to an act or a refusal. A client keeps one copy of each resource and updates it from whichever answer arrives. A new route never invents a lighter or richer variant. A heavy part of a resource, such as a send's frozen email or its per-recipient rows, gets a route of its own rather than a second shape.

3. **The server decides, the client displays.** Whatever needs a rule to work out is worked out once, by the server, and carried on the resource: a send's `phase`, its `conditions` (what is wrong, in words to show as they stand), its `actions` (exactly what the server would accept now, each with the method and path to use), and when to read again. A client never re-derives these from the raw fields. If it has to, the server is missing a field.

4. **An act is safe to repeat because of what it means.** Acting twice on the same decision is answered as done: canceling a canceled send, or moving a send to the time it already has, answers success with `changed: false`. A client that lost an answer simply sends the act again. Acts on a send carry no precondition naming the state the client saw. Both clients act for the same person, and the result shows at once in every answer. The review window (SPEC §6) is there for noticing, and a send act before the fire time can be undone. Saving a post is the one exception, and the reason is what would be lost: a save must carry the revision it was based on, and is refused without one or if another writer has saved since, because an overwritten paragraph is lost without anyone seeing it (SPEC §4). Erasing a subscriber cannot answer a repeat as done, because an erasure keeps nothing that would recognize the subscriber's id (SPEC §7): a repeat answers `not_found`, which a client that sent the erasure reads as done.

5. **A refusal names the client's next move.** Every refusal has a status, a code, and a message written to be shown or relayed as it stands. A refusal about the request names the `field`. A refusal about a resource's state carries the resource as it now stands, so the client can redraw without a second read, and `retry_after` when waiting is the remedy. Codes are grouped by what the client does next (below). A new code is added only when a client would do something different for it. A new cause that calls for an existing remedy gets its own message, not its own code.

6. **Changes have one order, and it is a number.** Every change to a send, whoever or whatever made it, is a write that takes the next number in one sequence across all sends. A send's `rev` is the number of its last change, so of two copies the higher `rev` is newer. A read's `cursor` is the sequence number at that read, and "what changed since" is every change above it. The clock also changes how a send reads with no write, for example when a fire time passes. A read that follows changes therefore also carries every send whose state the clock is setting right now, whatever the cursor, and since at most a few sends are ever in such a state, the cost is negligible. A client that holds two copies at the same `rev` keeps the one it read later.

7. **Strict at the door.** A body that is not the declared type, a field of the wrong shape, an unknown query value, or a cursor this server did not issue is refused with a 400 that names the field. Nothing is dropped or defaulted, so a request is never answered with a success that ignored part of it. A cross-site request from a browser never reaches a handler (SPEC §11).

8. **Sized for one publication.** A publication has hundreds of sends and up to tens of thousands of subscribers (SPEC §1). Paging exists where a collection grows with the list: subscribers, and a send's per-recipient rows. The list of sends pages too, because it sorts and filters. Following changes does not page, because the sends that change between two reads are few. The export pages too, keyed on the address, so a list read across many pages while it changes still gives every address exactly once, and an import takes at most a set number of rows, which the API states for the deployment. Where the server sets a page's size, it sets it from the deployment's plan, never from the client.

9. **A concept earns its place.** A new field, header, parameter, or code must change what some client shows or does. Before adding one, ask these questions:
   - Which client reads it, and what does that client do differently because of it?
   - Could an existing concept carry it: a condition, an action, a message, a `rev`?
   - Does it protect an invariant, or a race between two acts of the same person? If the latter, principle 4 applies.
   - Can it be explained in one sentence of the API reference?

## Resources

| Resource | What it is | Notes |
| --- | --- | --- |
| Post | A subject and a Markdown body, plus the slug, the listing, and the unlisted link's token | Editable only as a draft. A save carries its base revision. The settings are the exception: the listing, `email_only`, and the archive address, `slug` (SPEC §4, §5). Neither is part of the frozen copy, so both change on their own route, `PUT /api/posts/:id/settings`, in any state, a sent post included, and with Schedule or Send now, in the same act; a reschedule moves only the time. Every post's slug is its own, drafts included: one set by hand that is malformed or another post's is refused (`slug_invalid`, `slug_taken`) and nothing is written, and once the post's send starts, or while a scheduled email frozen before unlisted links carries it, a change to it is `slug_permanent`. Every post a route answers carries both its addresses, absolute (`archive_url`, `unlisted_url`), so a client reads where the post goes rather than building it, and where it stands for readers: `published_at`, when its send started (null before), and `archive_live`, whether `archive_url` shows it now. A post carries its addresses and whether each works; a send's `links` carry only what can be followed now. A post's `status` stays `scheduled` while its send is going out, so whether it is public is `published_at`, not `status`. A post's read, every save, and a settings change answer `subject_slug_held`, the subject's slug when another post holds it (null once the post is published), so a client says why the address didn't follow the subject rather than working it out. It reports a numbered slug, not a refusal, which is the 409 `slug_taken`. Each of the post's sends carries the listing and both addresses in its view (`links.archive` while the archive address answers, `links.unlisted` once the send has started), and which one its email carries (`web_link`), so a change gives those sends a new `rev`, and a client following sends sees it like any other change. |
| Revision | One saved version of a post | Read-only. The post's current revision is its version. |
| Image | A file belonging to a post, referenced by name | Uploaded to the post. It never hands back a URL to paste. |
| Send | One dispatch of a post: the frozen email, the fire time, and the record | The one shape is the send's view. Its email and its rows have routes of their own. |
| Delivery | One recipient's row in a send's record | Paged. Read from the rows, so it is heavier than the view. |
| Subscriber | An address, its consent state, its suppression, and how it joined | Paged. Erasing one removes it and answers with what was done, not the resource, since nothing of it is left. The whole list also reads out as an export, a page at a time in the import format's rows: a file format, not a second shape of the subscriber. |
| Suppression | An address that isn't mailed, whatever its consent state, and why | Its reason says whose decision it was: the provider's, an import's, an erasure's, or a block by hand, the publisher's own or one an import brought. A client adds only a block; a bounce or complaint is the provider's to report and an erasure's marker is Erase's to leave. Clearing refuses an erasure's marker; an erasure that found a block already on the address keeps the block instead, so clearing that block clears the address. What each reason and each act on a subscriber means is in the reference, in the editor's own words. |
| Import | A plan of what bringing a list in would do, and the record of one committed | A plan writes nothing. The record never holds a subscriber's address. A `subscribed` or `unsubscribed` row for an address whose suppression is an erasure's `erased` marker, or that the row itself says was erased, plans and applies as `blocked_by_suppression`, so an import never creates a subscriber for it. |
| Settings | The runtime preferences (SPEC §9) | One resource. It never holds a secret. It shows deploy configuration read-only, including whether a deployment with no provider is local development's preview of that state (`deployment.notConnectedPreview`), so a client can say how to leave it. |

## Reading and following

A client learns the state of things in two ways.

- **A snapshot** is a plain read: a list, or one resource. A read of sends also returns a `cursor`, the point in the sequence that the read reflects.
- **Following** is one route, the send feed, read from a cursor. It answers with:
  - every send that changed after that cursor, plus every send the clock is setting right now;
  - every open condition across the sends, whether or not it changed, so one read shows every problem;
  - a new cursor;
  - the server's `now`, and `read_again_at` by the server's clock.

  The server sets the pace for both clients alike. It is fast while a send can move without anyone acting, and about once a minute otherwise. Reading early is always fine. Reading late loses nothing, because the next read reports everything since the cursor.

A cursor from a database that has since gone back in time, such as after a restore, is refused. The client then takes a fresh snapshot and follows from its cursor.

**Documents come two ways.** The instance's own documentation, the docs and the API reference, is read as data the editor renders, and as Markdown an agent reads: the reference at its own path plus `.md`, each doc at `/api/docs/<slug>.md`, and each set's index at `/api/docs/<set>.md`. Each is a projection of one source, the docs' Markdown files or the route registration, so the two can't disagree. In a doc's Markdown, a link to another doc points at that doc's Markdown, so an agent can follow it without knowing where the source files live. A page merged into another still answers at its old slug, with the page that now holds its content.

## Acting

The client takes an act from the resource's `actions`, so it offers only what the server would accept now. The answer carries the resource as it stands after the act, `changed`, and a new `cursor`, so the client updates its copy without another read. A refused act carries the resource too.

A test send is an act whose outcome is the provider's, not the server's, so the provider not taking it is an answer, never a refusal: `sent: false` with `not_sent`, the provider's own words as `error`, a `message` to show or relay as it stands (what happened, then the fix where it is known, worded as a send's `refused` condition is), and `may_have_arrived` for a provider that never answered. A template test carries one per address it missed.

### Planning, then committing

An act that changes many things at once, on the strength of the publisher's consent, is split in two: a **plan** that says what the act would do and writes nothing, and a **commit** that applies that plan whole or not at all. Importing a list is the one such act (SPEC §7). The plan carries a hash of what the publisher's consent rests on, and the commit names it, so a commit applies the plan the publisher saw or is refused with `plan_stale`. Changes to the data in between that the consent doesn't rest on are applied safely and reported in the answer, not refused. The hash is also the commit's idempotency key: a commit repeated after a lost answer returns the first one's result, marked `replayed`, and applies nothing twice.

What the commit needs from a person is named in the plan and refused by code when missing, as `remake_required` is: an attestation the client shows and the publisher accepts, and each send whose audience the act would grow before that audience is fixed. The plan carries the attestation's words whole, with the name they call the publication by, so a client that words anything around them takes that name from the plan rather than working it out from the settings it read. A service token may give the attestation but never the acknowledgement, so an act that would grow a send through Claude is finished by a person in the editor.

## Refusing

The error body is `{ error, message }`, plus `field` for a refusal about the request, a dotted path for a nested field such as `notifications.to`. A refusal about a resource's state also carries the resource as it stands, and `retry_after` where waiting is the remedy.

| The client's next move | Status | Codes |
| --- | --- | --- |
| Fix the request | 400, 413, 415, 428 | `bad_request` (with `field`), `subject_required`, `fire_at_too_soon` (a fire time inside the minimum lead, with `field`; the soonest send is Send now, `POST /api/posts/:id/send`), `unsupported_media_type`, `base_required` (a post save without the revision it was based on, with the post as it stands), `slug_invalid` (a slug set by hand that isn't lowercase letters and numbers joined by single hyphens, with `field`), `unrecognized_format` (a file that isn't in the import format at all: convert it), `invalid_field` (a column or value the format doesn't take, with the `row`, the `column`, and the `allowed` values: fix that cell), `too_many_rows` (over this deployment's `limit`: split the file, or raise the limit where the deployment allows), `body_too_large` (413, over a fixed size: split the file) |
| Read again, then decide | 409 | `stale_revision` (a post, with the post as it stands, its `markdown`, and who wrote the newer revision), `active_send_exists` (with the send), `cursor_ahead`, `plan_stale` (plan the import again), `slug_taken` (another post holds the slug, with `field`: choose another) |
| Try again shortly, unchanged | 409 | `run_in_progress` (a send run holds the send, or, for an erasure, is handing that subscriber to the provider), `settings_changed`, `conflict` (settings written at the same moment), `remake_too_close` (with `retry_after`) |
| Confirm, then send again | 409 | `remake_required` (naming the sends the change would re-make), `attestation_required` (with the `attestation` to show), `sends_acknowledgement_required` (with the `sends`; a service token can't give it), `erasure_acknowledgement_required` (adding an address that was erased, with `erased_at`: send again with `acknowledge_erasure: true` once the publisher says the person asked to join again; the public subscribe form never asks, SPEC §7) |
| Nothing: the act no longer applies | 404, 409 | `not_found`, `window_closed`, `send_canceled`, `post_not_draft` (a save, delete, image change, or schedule of a post that is scheduled or sent), `not_wedged`, `slug_permanent` (a change to the slug of a post whose send has started, or whose scheduled email links its address, with `field`), `erasure_marker` (clearing an erased address's do-not-contact marker, which only the person's own confirmation lifts) |
| Fix the deployment, outside this API | 409, 500 | `provider_not_connected` (409: no email provider connected, so nothing can be sent: scheduling, send now, a test, a confirmation; SPEC §9), `invalid_config` (500: the deployment's configuration is refused, with the setting to fix as `variable`, below; SPEC §9), `schema_behind` (500: the database hasn't run every migration this release ships, with them as `missing` and what to run in `message`, below; SPEC §9) |
| Sign in, or stop | 401, 403 | `unauthorized` (with `reason: "access_not_configured"` when the deployment has no Access yet, below), `forbidden` |

A deployment with no Access configured can authenticate no request at all (SPEC §11), so its admin 401 says so: `{ "error": "unauthorized", "reason": "access_not_configured" }`. Signing in again cannot help; setting up Access can. A 401 under a configured Access, and one in local development, carries no `reason`, and the field never says anything else about the request.

While the configuration is refused, every request is answered before any route is matched, so before authentication, and the answer says nothing about the request itself. Under `/api`, at `/health`, and under `/webhooks/`, it is `invalid_config` naming the `variable`. Every other path is one a reader may open, and answers a plain HTML page with status 503 and a `Retry-After` of five minutes, saying it is temporarily unavailable, which names no setting.

A database behind the release is answered the same way, once the configuration is accepted: under `/api`, at `/health`, and under `/webhooks/`, `schema_behind`, as in `{"error":"schema_behind","missing":["0003_post_slug_auto.sql"],"message":"…"}`, and the same 503 page everywhere else. `missing` lists only the release's own migrations, never an instance's own. `message` names them and says what to run. In local development (a dev-shaped server) that is one command, `npx wrangler d1 migrations apply DB --local`. Anywhere else the server can't tell whether it is deployed or a local `wrangler dev` of the deployed settings, since a local server with routes is served under the route's host, so the message names both, `--remote --env production` for the deployed app and `--local --env production` under a local `wrangler dev`. Either way, it adds that an instance runs `npm run sync-migrations` first if the command finds nothing to apply. So `/health` answers `200` only when the configuration is accepted and the database has every migration the release needs.

An error nothing handled answers `500` `internal_error` on the API. On a reader page it answers a plain HTML page saying something went wrong, never a JSON body.

## Adding to the API

1. Start from the spec. If the change alters what a client can rely on, the spec changes first (`.claude/rules/maintainer.md`).
2. Put it on an existing resource and an existing way of reading or acting if it fits (principles 2 and 3).
3. Pass principle 9's questions, and write the one sentence the reference will carry.
4. Register it in `src/app.ts` with its summary, body types, query parameters, and example, so the reference and the gate come from the same entry.
5. Update this document only if the change adds a rule or a kind of concept, not a field.
