# Sending-domain DNS

Bulk mail lands in spam or is rejected outright without SPF, DKIM, and DMARC on the sending domain. Publish all three for `send.example.com`, the hostname your mail comes from.

**Connect Resend** (or **Use Amazon SES instead of Resend**) lists the records to publish; this page explains what each one does, and how to check and tighten them.

## Choose your sending name

- **Send from a subdomain.** It's recommended to send from a subdomain such as `send.example.com`, rather than from `example.com` itself. Your apex domain carries the reputation of your regular email, and a newsletter shouldn't put that at risk.
- **Keep the app's name and the mail's name distinct.** `newsletter.example.com` is where the app and its public pages live, and `send.example.com` is where mail comes from. Avoid `mail.` as the sending name, since mail servers read `mail.example.com` as a host that receives mail.

## The three records

These live on the `send.example.com` zone. The exact DKIM values come from your provider's verification wizard (SES "Easy DKIM" or the Resend domain page). That console is the source of truth for the CNAME/TXT it wants; copy them verbatim. DMARC you author yourself.

### SPF: authorize the provider's return path

SPF is checked against the message's envelope sender (the MAIL FROM, or return path), not the `From:` header. DMARC needs SPF **or** DKIM to pass *and* align with the From domain, and DKIM (below) aligns with either provider, so an aligned SPF is a second line of defense rather than a requirement.

- **Resend** sends with a return path on a subdomain of `send.example.com`, and its domain page lists that subdomain's MX and SPF TXT records. Publish them exactly as listed and SPF aligns.
- **SES** uses its own domain, `amazonses.com`, as the MAIL FROM unless you configure otherwise. SPF then passes for `amazonses.com` but does not align with `send.example.com`, and an SPF record on `send.example.com` itself is never consulted. DMARC still passes on DKIM. To align SPF too, set a **custom MAIL FROM domain** on the SES identity (in the SES console, the identity's **Custom MAIL FROM domain**), such as `bounce.send.example.com`, and publish the two records the console lists. The MX host names your `AWS_REGION`:

  ```
  bounce.send.example.com.  MX   10 feedback-smtp.us-east-1.amazonses.com.
  bounce.send.example.com.  TXT  "v=spf1 include:amazonses.com ~all"
  ```

Keep a single SPF record with a single `v=spf1` on each name; if one already exists, merge the `include:` rather than adding a second TXT.

### DKIM: let the provider sign

Publish the CNAME (SES) or TXT (varies) records exactly as the provider's wizard lists them. SES Easy DKIM publishes **three** CNAMEs of the form:

```
<token1>._domainkey.send.example.com.  CNAME  <token1>.dkim.amazonses.com.
<token2>._domainkey.send.example.com.  CNAME  <token2>.dkim.amazonses.com.
<token3>._domainkey.send.example.com.  CNAME  <token3>.dkim.amazonses.com.
```

Identity/domain verification only reports **verified** once these resolve, so give DNS time to propagate.

### DMARC: publish a policy and collect reports

A TXT record at `_dmarc.send.example.com`. Start in **monitor** mode so you can watch alignment before enforcing:

```
_dmarc.send.example.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com; fo=1"
```

Once reports show DKIM aligning for your sends (and SPF, where you set it up to align), tighten the policy to `p=quarantine` and then `p=reject`.

## Verify alignment

DKIM **alignment**, the signing domain matching the From domain, is what a test send actually proves. Send yourself a test (see **Verify it works**), open the raw message in your mail client, and read the `Authentication-Results` header. Gmail's "Show original" is the quickest way to read it. Expect:

- `dkim=pass` for `send.example.com`.
- `dmarc=pass` for `send.example.com`.
- `spf=pass`. With Resend, or SES with a custom MAIL FROM domain, its domain is under `send.example.com`. With SES and no custom MAIL FROM domain, it is `amazonses.com`: that is expected and does not fail DMARC.
