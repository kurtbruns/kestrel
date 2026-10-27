# Share your subscribe link

Your publication's subscribe page is at `/subscribe` on your publication's address, such as `https://newsletter.example.com/subscribe`. Copy it from the dashboard's checklist or **Settings → Ways to subscribe**, and share it wherever your readers are. A reader joins only once they confirm by email.

**Signups open only once an email provider is connected.** Until then, the page says the newsletter isn't taking subscribers yet, and the dashboard says so too. You can share the link anyway, and it opens once email is connected ([Connect Amazon SES](../get-started/05-ses.md)).

## How a reader joins

A reader enters their address, gets a confirmation email, and presses **Confirm subscription** on the page its link opens. Only then do they receive your posts. Opening the link alone records nothing, since mail scanners open links before a person does. This double opt-in is your record that each reader asked for your newsletter.

Every address gets the same answer, so the form never reveals who subscribes. Behind it, Kestrel sends a confirmation only when one is due:

- **Already subscribed, bounced, or blocked:** no email goes out.
- **Waiting to confirm:** at most one confirmation every 15 minutes, however often the form is submitted. A link works for 7 days, and an expired one offers a fresh link.
- **Unsubscribed earlier, for any reason, a complaint or an erasure included:** they get a confirmation, and confirming puts them back on your list. This form is the only way back for someone who complained or was erased.

## The confirmation email

Change its subject, message, button label, and reassurance line under **Settings → Confirmation email**. Kestrel adds your name, your logo, and the confirm link itself, so no edit can leave them out. The confirmation isn't a post, so it doesn't use your email template.

## Put the form on your own site

**Settings → Ways to subscribe → Embed a form** gives you HTML to paste into any page you control. **Styled** looks like your subscribe page, and **Plain** takes your site's own styles. A reader who submits it confirms by email, as on the subscribe page.

**Settings → Reader pages** shows every page a reader can land on, at desktop and phone widths, without walking through the steps. You can also limit how often anyone submits the form, which slows down abuse ([Rate-limit the subscribe form](../guides/05-rate-limit.md)).
