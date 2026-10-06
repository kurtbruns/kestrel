# Verify it works

Email's real failure modes (DKIM alignment, inbox rendering, the bounce webhook round-trip, one-click unsubscribe in a real client) only show up once deployed (`docs/SPEC.md` §11). Run this checklist before you share the subscribe link. The list is still empty, so every email here goes only to addresses you own.

These checks need your live Cloudflare account, real DNS, your provider, and real inboxes, so they can't be run from inside the app or from a development session: they are the acceptance test you run by hand.

## 1. Send yourself a test

In the editor (`/dashboard/`), write a short draft and use **Send test email** to send it to an address you own. A test goes through the same render path as a real send (I5), so a clean test is a real guarantee, not a lookalike.

- [ ] The test arrives in the inbox, not in spam.
- [ ] It renders correctly: images load, the layout holds, links work.
- [ ] The subject and preheader read as intended.

## 2. Check DKIM alignment

Open the test's raw source (in Gmail, **Show original**) and read the `Authentication-Results` header.

- [ ] `dkim=pass` and `dmarc=pass`, both for `send.example.com`.
- [ ] `spf=pass`. With Resend, its domain is under `send.example.com`. With SES it is `amazonses.com` unless you set up a custom MAIL FROM domain, which is expected and still passes DMARC through DKIM.

If any fail, recheck the records from **Connect Resend** (or the SES guide), and see **Sending-domain DNS** in the reference. Alignment is the best single predictor of landing in the inbox.

## 3. Set your notification address

Kestrel emails you when a send goes out, and right away if one runs into a problem (`docs/SPEC.md` §8). They go through your provider unless you set up **Notifications through Cloudflare's email**, one of the guides after this path.

- [ ] Under **Settings → Notifications**, enter your address and **Save**.
- [ ] **Send a test notification** arrives at that address.

## 4. Subscribe yourself and send a real post

- [ ] Open `https://newsletter.example.com/subscribe`, subscribe with an address you own, and click the link in the confirmation email. The address shows as confirmed in the editor's **Subscribers** view.
- [ ] Schedule the draft, or use **Send now**. A send appears that you can still cancel before any mail leaves, and nothing goes out the instant you ask (I6). Cancel it once to see that canceling stops it, then schedule it again.
- [ ] Once it fires, the post arrives, and a **Sent:** notification follows with its numbers and a link to the send's record.

## 5. Unsubscribe from a real client

Every email carries a one-click `List-Unsubscribe` header (RFC 8058) and an unsubscribe link in the body. Both work with no login and no confirmation step (`docs/SPEC.md` §7).

- [ ] Your mail client shows its own **Unsubscribe** button on the post from step 4.
- [ ] Using it (or the link in the body) records the unsubscribe at once: the address shows as **unsubscribed** in **Subscribers**, and the next send leaves it out (I2).

## 6. Prove bounces and complaints come back

The provider reports bounces and complaints to the app's webhook, which stops mailing those addresses on its own. Send a test email to the provider's simulator addresses, which never reach a real person:

- **Resend:** `bounced@resend.dev` and `complained@resend.dev`. These count toward your Resend sending quota.
- **SES:** `bounce@simulator.amazonses.com` and `complaint@simulator.amazonses.com`.

- [ ] Each simulator address appears as **suppressed** in the editor, whatever its consent state, and every later send leaves it out (I1).

If they don't, open the Worker's logs (below) and look for a `webhook.received` event followed by `receipt.applied`. With SES, also check that the SNS subscription shows **Confirmed**.

## 7. Read the logs

The Worker writes one JSON line per event (the catalog is in `docs/SPEC.md` §12), and Workers Logs indexes each line's fields. In the Cloudflare dashboard, open the Worker's **Observability → Logs** view.

- [ ] Filter on `event` equal to `sweep.tick`: a line arrives every minute, which is the cron at work. If the cron ever stops, nothing else will tell you.
- [ ] Filter on `sendId` equal to the id of the send from step 4 (the last part of its URL in the editor): its lines read as its timeline, `send.fired`, then `send.batch`, then `send.completed`, then its receipts.
- [ ] Filter on `level` equal to `error`: nothing, on a healthy instance. Anything here is worth a look.

When every box is checked, the instance is ready for subscribers.
