# Verify it works

Email's real failure modes — DKIM alignment, inbox rendering, the bounce webhook round-trip, one-click unsubscribe in a real client — only appear once deployed (`docs/SPEC.md` §11). Run this checklist on **staging** first (sending only to addresses you own), then again on production before the first real send.

## 1. Test send to yourself

In the editor (`/dashboard/`), open a draft and use **Send test email** to deliver the rendered post to an address you control. A test goes through the *same* render path as a real send (I5), so a clean test is a real guarantee, not a lookalike.

- [ ] The test arrives in the inbox.
- [ ] It renders correctly (images load, layout holds, links work).
- [ ] The subject and preheader read as intended.

## 2. DKIM alignment

Open the received test's raw source (Gmail: **Show original**) and read the `Authentication-Results` header.

- [ ] `spf=pass`, `dkim=pass`, and `dmarc=pass`, all aligned to `send.example.com`.

If any fail, revisit **Sending-domain DNS** — alignment is the single best predictor of landing in the inbox.

## 3. One-click unsubscribe in a real client

Every message carries a one-click `List-Unsubscribe` header (RFC 8058) and an in-body unsubscribe link. Both point at the app's token-scoped endpoint — no login, no confirmation step (`docs/SPEC.md` §7).

- [ ] The mail client shows its built-in **Unsubscribe** affordance.
- [ ] Clicking it (or the in-body link) records the unsubscribe immediately.
- [ ] The address shows as **unsubscribed** in the editor's Subscribers view and is excluded from the next send (I2).

## 4. Bounce / complaint webhook round-trip

Prove the provider's events reach the app and suppress the address on their own. Use the provider's built-in simulator addresses (they never mail a real person):

- **SES:** send to `bounce@simulator.amazonses.com` (hard bounce) and `complaint@simulator.amazonses.com` (complaint).
- **Resend:** use its documented test addresses for bounce and complaint.

Then check:

- [ ] The event arrives at the webhook (`/webhooks/ses` or `/webhooks/resend`) and passes signature verification. For SES, confirm the SNS subscription shows **Confirmed** (the app completes the handshake automatically) and the Worker logs show the event applied.
- [ ] The simulated address appears **suppressed** in the editor, whatever its consent state, and is excluded from every subsequent send (I1).

## 5. Send-now review window

- [ ] Scheduling (or Send now) creates a visible, **cancelable** Send before any mail leaves, and canceling it stops the send (I6). Nothing fires the instant it is requested.

---

When every box is checked on production, the instance is ready for a real send to your confirmed subscribers.

> These steps are **operator-run and cannot be performed from inside the app or from a development session** — they need your live Cloudflare account, real DNS, a provider out of the sandbox, and real inboxes. Treat them as the acceptance test you run by hand.
