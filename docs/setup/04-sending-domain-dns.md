# Sending-domain DNS

Bulk mail lands in spam or is rejected outright without SPF, DKIM, and DMARC on the sending domain. Publish all three on **`send.example.com`** — the dedicated sending subdomain, kept off the apex so the newsletter's sending reputation can never affect your regular mail (`docs/SPEC.md` §11).

## Two hard rules

- **Never send bulk mail from the apex** (`example.com`). This is the one item here that is not a preference. The apex carries your primary mail reputation; a newsletter must not put it at risk. Send from `send.example.com`.
- **Keep the app name and the mail name unmistakably different.** `newsletter.example.com` is where the app and reader surface live; `send.example.com` is where mail comes from — two different jobs, two names that can't be confused for each other. Avoid `mail.` as the sending subdomain too: the world treats `mail.example.com` as an inbound MX host, not a sending identity, so it invites the opposite confusion. `send.` is the right role name for outbound.

## The three records

These live on the `send.example.com` zone. The exact DKIM values come from your provider's verification wizard (SES "Easy DKIM" or the Resend domain page) — that console is the source of truth for the CNAME/TXT it wants; copy them verbatim. DMARC you author yourself.

### SPF — authorize the provider to send as the domain

A TXT record on `send.example.com`. Use the include your provider specifies:

```
; SES
send.example.com.  TXT  "v=spf1 include:amazonses.com ~all"

; Resend (uses its own send subdomain; follow the dashboard's exact record)
```

Keep a single SPF record with a single `v=spf1`; if one already exists, merge the `include:` rather than adding a second TXT.

### DKIM — let the provider sign

Publish the CNAME (SES) or TXT (varies) records exactly as the provider's wizard lists them. SES Easy DKIM publishes **three** CNAMEs of the form:

```
<token1>._domainkey.send.example.com.  CNAME  <token1>.dkim.amazonses.com.
<token2>._domainkey.send.example.com.  CNAME  <token2>.dkim.amazonses.com.
<token3>._domainkey.send.example.com.  CNAME  <token3>.dkim.amazonses.com.
```

Identity/domain verification only reports **verified** once these resolve, so give DNS time to propagate.

### DMARC — publish a policy and collect reports

A TXT record at `_dmarc.send.example.com`. Start in **monitor** mode so you can watch alignment before enforcing:

```
_dmarc.send.example.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com; fo=1"
```

Once reports show SPF and DKIM aligning for your sends, tighten the policy to `p=quarantine` and then `p=reject`.

## Verify alignment

DKIM **alignment** — the signing domain matching the From domain — is what a test send actually proves. Send yourself a test (see **Verify it works**), open the raw message in your mail client, and confirm the `Authentication-Results` header shows `spf=pass`, `dkim=pass`, and `dmarc=pass` for `send.example.com`. Gmail's "Show original" is the quickest way to read it.
