# High-cadence publisher

Sends weekly or more, to a larger list, and reuses a tuned template across posts. Watches deliverability closely: bounce and complaint rates, unsubscribes after a send, suppressions.

**Stresses:** the Sent record's delivery-outcome detail, Settings/Template's "in use by N scheduled posts" and remake behavior, subscriber list hygiene.

## Onboarding

1. Follow the setup guide to deploy a fresh instance.
2. Arrives with an existing audience from another newsletter tool. Most publishers at this cadence already have one, and need to bring that list over.
3. **Gap:** Kestrel has no subscriber import today. A migrating publisher has no supported way to bring an existing, already-consented list in, short of re-running double opt-in on everyone, which is a real cost against a large existing audience. Noted here rather than routed around: this is a first-run journey that currently can't complete, and closing it is worth prioritizing before this archetype is well served.
4. Set up the email template and identity to match their existing brand.
5. Send a first post to confirm deliverability (DKIM/SPF, inbox placement) before trusting the list to it.

## Steady state: send a post on schedule

1. Reuse the existing template for the next post (there is no per-post template today, so this is really "the template already matches").
2. Write the post, preview, schedule for the usual send time.
3. Watch the send drain in the active-send view; confirm dispatch completes.
4. After it sends, check the record's delivery outcomes (delivered, bounced, complained, unsent) against the usual baseline.
5. Investigate anything above baseline: open Subscribers, check for new suppressions.

## Steady state: change the template mid-flight

1. A post is already scheduled: frozen render, soft-locked.
2. Edit the email template or publication identity in Settings.
3. Confirm the "in use by N scheduled posts" prompt, acknowledge the remake.
4. Verify the scheduled post's frozen render now reflects the new template, without the publisher touching the post directly.
