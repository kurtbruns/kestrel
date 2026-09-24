# Verify it works

Email's real failure modes — DKIM alignment, inbox rendering, the bounce webhook round-trip, one-click unsubscribe in a real client — only appear once deployed (`docs/SPEC.md` §11). Run this checklist on **staging** first (sending only to addresses you own), then again on production before the first real send.

## 1. Test send to yourself

In the editor (`/dashboard/`), open a draft and use **Send test email** to deliver the rendered post to an address you control. A test goes through the *same* render path as a real send (I5), so a clean test is a real guarantee, not a lookalike.

- [ ] The test arrives in the inbox.
- [ ] It renders correctly (images load, layout holds, links work).
- [ ] The subject and preheader read as intended.

## 2. DKIM alignment

Open the received test's raw source (Gmail: **Show original**) and read the `Authentication-Results` header.

- [ ] `dkim=pass` and `dmarc=pass`, both for `send.example.com`.
- [ ] `spf=pass`. Its domain is under `send.example.com` for Resend, or for SES with a custom MAIL FROM domain; for SES without one it is `amazonses.com`, which is expected and still passes DMARC through DKIM.

If any fail, revisit **Sending-domain DNS**: alignment is the single best predictor of landing in the inbox.

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

- [ ] The event arrives at the webhook (`/webhooks/ses` or `/webhooks/resend`) and passes signature verification. For SES, confirm the SNS subscription shows **Confirmed** (the app completes the handshake automatically) and the Worker logs show a `webhook.received` event followed by `receipt.applied`.
- [ ] The simulated address appears **suppressed** in the editor, whatever its consent state, and is excluded from every subsequent send (I1).

## 5. Send-now review window

- [ ] Scheduling (or Send now) creates a visible, **cancelable** Send before any mail leaves, and canceling it stops the send (I6). Nothing fires the instant it is requested.

## 6. Notifications

- [ ] Under **Settings → Notifications**, **Send a test notification** arrives at your address, and **Sent through** names the channel you meant (Cloudflare's email once the `NOTIFY` binding is declared).
- [ ] The first send that goes out brings a **Sent:** notification with its numbers and a link to its record (`docs/SPEC.md` §8).

## 7. Logs

The Worker logs one JSON line per event (the catalog is in `docs/SPEC.md` §12), and Workers Logs indexes each line's fields. In the Cloudflare dashboard, open the Worker's **Observability → Logs** view.

- [ ] Filter on `event` equal to `sweep.tick`: a line arrives every minute, the cron at work.
- [ ] Filter on `sendId` equal to the id of the send from the steps above (the last part of its URL in the editor): its lines read as its timeline, `send.fired`, then `send.batch`, then `send.completed`, then its receipts.
- [ ] Filter on `level` equal to `error`: nothing, on a healthy instance. Anything here is worth a look.

---

When every box is checked on production, the instance is ready for a real send to your confirmed subscribers.

> These steps are **run by hand and cannot be performed from inside the app or from a development session** — they need your live Cloudflare account, real DNS, a provider out of the sandbox, and real inboxes. Treat them as the acceptance test you run by hand.
