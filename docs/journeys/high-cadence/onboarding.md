# High-cadence onboarding: arriving with an audience

**Goal.** A publisher moving from another newsletter tool, with an existing audience, gets far enough to trust Kestrel with their next post: their brand is set, their list is here with its consent intact, and a first post reaches exactly the people it should.

**Archetype:** [High-cadence publisher](README.md)

**Environment.** Local, except the real-inbox half of step 6, which needs staging. So does any check of deliverability (DKIM, SPF, inbox placement).

## Starting world

1. `.dev.vars` sets `SIMULATE_SENDS="1"`, so a send unfolds over real time instead of finishing instantly.
2. `npm run dev`, then `npm run reset`: a fresh install with no posts, no subscribers, and default settings.
3. [`fixtures/existing-audience.csv`](fixtures/existing-audience.csv) is the export from their previous tool: 36 rows, with the mess real exports carry.

## Steps

1. Open the dashboard. Take stock of the first-run state: what does the app tell a new publisher to do first?
2. Set the publication identity (name, tagline, logo, mailing address) to match their existing brand.
3. Bring the existing audience over from the fixture. Look for a way in the dashboard first, then in the API reference, where a publisher working through Claude would look.
4. Check that the email template renders their identity correctly, and adjust it if it doesn't match their look.
5. Set the default test recipients to their own address.
6. Write a first post and send a test email to themself. Local: read it from the fake outbox (`GET /api/dev/outbox`). Staging: open it in a real inbox.
7. Schedule the post and watch it send.
8. Once it settles, read the send's record: who received it, and who didn't.

## Expectations

**First run**

- The dashboard points a new publisher at a useful first step rather than an empty page.
- Nothing about the empty state reads as broken: no stray zero, blank panel, or missing image.

**The import, against the fixture**

- Consent from the previous tool is respected. A row marked `unsubscribed` or `cleaned` never becomes a subscriber who can be mailed.
- An address listed as both active and unsubscribed resolves to not mailed (`vint.cerf@example.net`).
- Duplicates collapse case-insensitively and after trimming whitespace.
- Invalid addresses are reported back, not silently dropped.
- The publisher sees a summary of what happened and why: imported, skipped as unsubscribed or cleaned, merged as a duplicate, rejected as invalid. For this fixture: 36 rows name 32 distinct valid addresses and 1 invalid one. Of the 32, 25 are active and never unsubscribed, 5 are unsubscribed (the conflict included), and 2 are cleaned. Three rows repeat an address already seen: two plain duplicates and the conflict.

**The first send**

- It goes only to confirmed subscribers (I1). No fixture row marked unsubscribed or cleaned appears among its recipients.
- The recipient count on the record matches the confirmed audience at the moment it fired.
- While it sends, the page tells the truth about what is happening at every moment.

**Throughout**

- No console errors, no failed requests except where a step expects one, and nothing at error level in the `wrangler dev` log.

## Known gaps

- **Subscriber import does not exist.** There is no import in the dashboard or the API. Attempt step 3 anyway, and report what a publisher would be left doing instead. Steps 7 and 8 then run against whatever audience the publisher can build by hand, and the report says so.
- **Locally, the sweep never runs on its own.** `wrangler dev` doesn't fire cron triggers, so a scheduled send never starts and a sent one never settles its delivery receipts. When a step waits on the sweep, fire it by hand (`curl <origin>/cdn-cgi/local/scheduled`) and report how long the page sat stalled first.
- **With the send simulation on, the fake outbox stays empty.** The simulator replaces the fake transport for all mail, so step 6's test email and every confirmation email are invisible locally. Report it and move on.
- **Import needs a SPEC decision before it needs code.** I1 requires consent confirmed through Kestrel's own double opt-in, so an address confirmed by another tool doesn't qualify as written. Either an import carries the prior consent over as a recorded consent, with its source and date, or every imported address goes through double opt-in again. The second keeps I1 as it stands but costs a large list a real share of its readers. The expectations above hold either way, and the summary must say which rule applied.
