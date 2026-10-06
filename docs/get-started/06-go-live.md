# Go live

The instance works. What's left is making it yours and telling people where to subscribe.

## 1. Name your publication

In the editor, open **Settings → Publication identity** and set the name, tagline, and logo. They brand the landing page, the archive, and every email, so set them before anyone sees those pages. Until then, the name in your From address stands in.

## 2. Share the subscribe link

**Settings → Ways to subscribe** has your subscribe page, `https://newsletter.example.com/subscribe`, and a form you can paste into your own website. Every signup confirms by email before it joins the list. The landing page at `https://newsletter.example.com/` shows your latest post and points readers there too.

## 3. Consider a rate limit on the subscribe form

The subscribe form is public, and the app already sends any one address at most one confirmation every 15 minutes. A Cloudflare rate-limiting rule also caps how often one visitor can submit it. It takes a few minutes and the Free plan includes one rule: see **Rate-limit the subscribe form**.

## What next

Each of these stands on its own; pick the ones you want.

- **Connect Claude to the API** so it can draft, proofread, and schedule posts through the same API the editor uses.
- **Notifications through Cloudflare's email**, so the alert that your provider has refused your account can still reach you.
- **Put the archive on your website**, at `example.com/archive`, or serve images from their own domain.
- **Use Amazon SES instead of Resend**, cheaper at scale.
- **Add a staging environment**, to rehearse a feature or an upgrade before production.

When a new release comes out, **Upgrade to a new release** says how to move to it.
