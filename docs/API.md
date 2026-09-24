# Kestrel API

The shape of Kestrel's authoring API: the rules every route follows, so a client that has learned one route can predict the rest. The spec (`docs/SPEC.md`) says what both clients can rely on; this document says the shape they rely on it through. The generated API reference, served in the admin surface and built from the route registration in `src/app.ts`, lists every route, field, and example, so this document names concepts and never restates a route.

**Who this is for.** Whoever adds to the API or builds a client for it, human or Claude.

**Status.** Draft. It describes the API as the principles below would have it. Where `main` differs today (the send's ETag, preconditions on acts, the feed's cursor, tombstones, and pace), the gap is tracked on GitHub as simplification deferred until real use shows which parts matter; this note goes once `main` matches.

---

## The bet

Kestrel has two clients, the web editor and Claude, and both act for one publisher (SPEC §1). They stay on the same page because they read and act through one API over one copy of the data, and neither keeps a rule of its own about what the data means. So the API carries the design weight. It has to be **robust**: a retry, a race, or a late read never leaves a client believing something false. And it has to be **small enough to learn from its reference**: Claude meets it cold in every conversation, and a concept that only the editor's author understands is one Claude will use wrongly.

When those two pull against each other, prefer the smaller API and a documented expectation, as long as no invariant (SPEC §3) rests on the difference.

## Principles

1. **One API, no private door.** The editor uses no route that Claude cannot, and no route exists only to serve the editor's layout. The one exception is the development tooling under `/api/dev/`, which exists only on a local instance.

2. **One shape per noun.** A resource reads the same on every route that carries it: in a list, alone, in the feed, and in the answer to an act or a refusal. A client keeps one copy of each resource and updates it from whichever answer arrives. A new route never invents a lighter or richer variant. A heavy part of a resource, such as a send's frozen email or its per-recipient rows, gets a route of its own rather than a second shape.

3. **The server decides, the client displays.** Whatever needs a rule to work out is worked out once, by the server, and carried on the resource: a send's `phase`, its `conditions` (what is wrong, in words to show as they stand), its `actions` (exactly what the server would accept now, each with the method and path to use), and when to read again. A client never re-derives these from the raw fields. If it has to, the server is missing a field.

4. **An act is safe to repeat because of what it means.** Acting twice on the same decision is answered as done: canceling a canceled send, or moving a send to the time it already has, answers success with `changed: false`. A client that lost an answer simply sends the act again. Acts on a send carry no precondition naming the state the client saw. Both clients act for the same person, and the result shows at once in every answer. The review window (SPEC §6) is there for noticing, and a send act before the fire time can be undone. Saving a post is the one exception, and the reason is what would be lost: a save carries the revision it was based on and is refused if another writer has saved since, because an overwritten paragraph is lost without anyone seeing it (SPEC §4).

5. **A refusal names the client's next move.** Every refusal has a status, a code, and a message written to be shown or relayed as it stands. A refusal about the request names the `field`. A refusal about a resource's state carries the resource as it now stands, so the client can redraw without a second read, and `retry_after` when waiting is the remedy. Codes are grouped by what the client does next (below). A new code is added only when a client would do something different for it. A new cause that calls for an existing remedy gets its own message, not its own code.

6. **Changes have one order, and it is a number.** Every change to a send, whoever or whatever made it, is a write that takes the next number in one sequence across all sends. A send's `rev` is the number of its last change, so of two copies the higher `rev` is newer. A read's `cursor` is the sequence number at that read, and "what changed since" is every change above it. The clock also changes how a send reads with no write, for example when a fire time passes. A read that follows changes therefore also carries every send whose state the clock is setting right now, whatever the cursor, and since at most a few sends are ever in such a state, the cost is negligible. A client that holds two copies at the same `rev` keeps the one it read later.

7. **Strict at the door.** A body that is not the declared type, a field of the wrong shape, an unknown query value, or a cursor this server did not issue is refused with a 400 that names the field. Nothing is dropped or defaulted, so a request is never answered with a success that ignored part of it. A cross-site request from a browser never reaches a handler (SPEC §11).

8. **Sized for one publication.** A publication has hundreds of sends and up to tens of thousands of subscribers (SPEC §1). Paging exists where a collection grows with the list: subscribers, and a send's per-recipient rows. The list of sends pages too, because it sorts and filters. Following changes does not page, because the sends that change between two reads are few.

9. **A concept earns its place.** A new field, header, parameter, or code must change what some client shows or does. Before adding one, ask these questions:
   - Which client reads it, and what does that client do differently because of it?
   - Could an existing concept carry it: a condition, an action, a message, a `rev`?
   - Does it protect an invariant, or a race between two acts of the same person? If the latter, principle 4 applies.
   - Can it be explained in one sentence of the API reference?

## Resources

| Resource | What it is | Notes |
| --- | --- | --- |
| Post | A subject and a Markdown body, plus the slug | Editable only as a draft. A save carries its base revision. |
| Revision | One saved version of a post | Read-only. The post's current revision is its version. |
| Image | A file belonging to a post, referenced by name | Uploaded to the post. It never hands back a URL to paste. |
| Send | One dispatch of a post: the frozen email, the fire time, and the record | The one shape is the send's view. Its email and its rows have routes of their own. |
| Delivery | One recipient's row in a send's record | Paged. Read from the rows, so it is heavier than the view. |
| Subscriber | An address, its consent state, and its suppression | Paged. |
| Settings | The runtime preferences (SPEC §9) | One resource. It never holds a secret. It shows deploy configuration read-only. |

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

## Acting

The client takes an act from the resource's `actions`, so it offers only what the server would accept now. The answer carries the resource as it stands after the act, `changed`, and a new `cursor`, so the client updates its copy without another read. A refused act carries the resource too.

## Refusing

The error body is `{ error, message }`, plus `field` for a refusal about the request. A refusal about a resource's state also carries the resource as it stands, and `retry_after` where waiting is the remedy.

| The client's next move | Status | Codes |
| --- | --- | --- |
| Fix the request | 400, 415 | `bad_request` (with `field`), `subject_required`, `fire_at_too_soon`, `unsupported_media_type` |
| Read again, then decide | 409 | `stale_revision` (a post, with the newer revision and who wrote it), `active_send_exists` (with the send), `cursor_ahead` |
| Try again shortly, unchanged | 409 | `run_in_progress`, `settings_changed`, `conflict` (settings written at the same moment), `remake_too_close` (with `retry_after`) |
| Confirm, then send again | 409 | `remake_required` (naming the sends the change would re-make) |
| Nothing: the act no longer applies | 404, 409 | `not_found`, `window_closed`, `send_canceled`, `post_not_draft`, `not_wedged` |
| Sign in, or stop | 401, 403 | `unauthorized`, `forbidden` |

## Adding to the API

1. Start from the spec. If the change alters what a client can rely on, the spec changes first (`.claude/rules/maintainer.md`).
2. Put it on an existing resource and an existing way of reading or acting if it fits (principles 2 and 3).
3. Pass principle 9's questions, and write the one sentence the reference will carry.
4. Register it in `src/app.ts` with its summary, body types, query parameters, and example, so the reference and the gate come from the same entry.
5. Update this document only if the change adds a rule or a kind of concept, not a field.
