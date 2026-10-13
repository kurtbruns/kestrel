# Sending-domain DNS

Inboxes decide whether to trust your mail by checking records in the DNS of the domain it comes from. This page explains the three checks they run: SPF, DKIM, and DMARC. It covers the records [Connect Amazon SES](../get-started/04-ses.md) has you add, what each proves, how to check them, and when to tighten DMARC.

## Why all three

Gmail requires every sender to pass SPF or DKIM. A sender of more than 5,000 messages a day to Gmail must have all three:

- SPF and DKIM, both passing.
- A DMARC record, with a policy of at least `p=none`.
- Alignment: the domain in the `From:` header matches the SPF domain or the DKIM domain.

Gmail also requires one-click unsubscribe for such senders. Kestrel adds the `List-Unsubscribe` and `List-Unsubscribe-Post` headers to every email, so that part needs nothing from you. [Google's sender guidelines](https://support.google.com/a/answer/81126) list the rest.

A small list may never reach 5,000 a day, but the same checks decide whether mail lands in the inbox. Make sure all three pass from the start.

## Choose your sending name

- **Send from a subdomain.** It's recommended to send from a subdomain such as `send.example.com`, rather than from `example.com` itself. Your apex domain carries the reputation of your regular email, and a newsletter shouldn't put that at risk.
- **Keep the app's name and the mail's name distinct.** The app and its public pages live at `newsletter.example.com`, and mail comes from `send.example.com`. Avoid `mail.` as the sending name, since mail servers read `mail.example.com` as a host that receives mail.

## The records

Every record lives in your domain's DNS, `example.com`, under the sending name. In Cloudflare, a record's name leaves off your domain, so `_dmarc.send.example.com` is entered as `_dmarc.send`.

SES generates the DKIM values. Copy them exactly as SES lists them, since they differ by account and region. You write the DMARC record yourself.

SPF needs no record of yours on SES's default path, since it passes for a subdomain of `amazonses.com`. An SPF record, at `bounce.send`, comes only with the optional custom MAIL FROM domain.

### SPF: authorize the return path

SPF checks the message's return path, the address bounces go back to, not its `From:` header. DMARC passes when SPF or DKIM passes and aligns with the `From:` domain. DKIM aligns, so an aligned SPF is a second check in your favor, not a requirement.

SES uses a subdomain of its own domain, `amazonses.com`, as the return path by default. SPF then passes for it but doesn't align, and DMARC passes through DKIM alone. A custom MAIL FROM domain, such as `bounce.send.example.com`, aligns SPF too. [Connect Amazon SES](../get-started/04-ses.md#3-optional-set-a-custom-mail-from-domain) sets one up, with an MX record that names your region and an SPF record:

```
bounce.send.example.com.  MX   10 feedback-smtp.us-east-1.amazonses.com.
bounce.send.example.com.  TXT  "v=spf1 include:amazonses.com ~all"
```

A name holds one SPF record. If one already exists there, add `include:amazonses.com` to it rather than adding a second.

### DKIM: let the provider sign

DKIM signs each message with a key your DNS publishes. An inbox checks the signature to tell the message came from you, unchanged.

SES lists three `CNAME` records, each at `TOKEN._domainkey.send.example.com`. Their targets depend on your region and account, so copy them as SES lists them.

In Cloudflare, set every `CNAME` for DKIM to **DNS only**, not proxied. SES reports the domain as verified only once the records resolve.

### DMARC: publish a policy and collect reports

DMARC tells an inbox what to do with mail that fails both SPF and DKIM, and asks it to send you reports. It's a `TXT` record at `_dmarc.send.example.com`:

```
_dmarc.send.example.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
```

- **`p=none`** is monitor mode. Inboxes report on failing mail, but deliver it as usual.
- **`rua`** is where reports go. They arrive as attachments, usually one a day from each inbox provider.

Leave alignment relaxed, the default, with no `aspf=s` or `adkim=s`. With a custom MAIL FROM domain, your return path is a subdomain of your sending name, so strict SPF alignment would fail.

Once the reports show your sends passing and aligned, tighten the policy to `p=quarantine`, which sends failing mail to spam. Later, tighten it to `p=reject`, which refuses it.

## Verify alignment

A test email proves alignment better than any DNS lookup. Send yourself one, as in [Verify it works](../get-started/05-verify.md#2-check-that-it-passes-authentication), and read its `Authentication-Results` header. In Gmail, open the message's menu, and select **Show original**. Expect:

- `dkim=pass` for `send.example.com`.
- `dmarc=pass` for `send.example.com`.
- `spf=pass`. With a custom MAIL FROM domain, its domain is under `send.example.com`. Without one, it's a subdomain of `amazonses.com`. That's expected, and DMARC still passes.
