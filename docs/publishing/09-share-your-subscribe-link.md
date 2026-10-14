# Share your subscribe link

Your publication has a public subscribe page at `/subscribe` on your Kestrel's address, such as `https://newsletter.example.com/subscribe`. Share that link wherever your readers are, or put the same form on your own website. Either way, a reader joins only once they confirm by email.

This page covers what a reader sees, the confirmation email, putting the form on your site, and previewing every page a reader can land on. You find the link under **Settings → Ways to subscribe**, and on the dashboard's first-run checklist.

## What a reader sees

**A reader enters their address, gets a confirmation email, and presses a button to confirm. Only then do they receive your posts.**

The subscribe page wears your publication's name, tagline, and logo, which you set in [Name your publication](03-name-your-publication.md). Your landing page and archive carry a subscribe prompt too. After a reader submits their address, the page tells them to check their inbox. The email's link opens a page with a **Confirm subscription** button, and pressing it puts them on your list. This is double opt-in, and it's your record that each reader asked for your newsletter.

Opening the link alone records nothing, since mail scanners open links before a person does. A confirmation link also works only for a limited time. An expired link offers to send a fresh one.

## Addresses already on your list, or that left

**Every address gets the same answer, so the form never reveals who subscribes.**

The page always says to check the inbox, whatever the address is. Behind it, Kestrel sends a confirmation only when one is due:

- **Already subscribed:** no email goes out, and they stay subscribed.
- **Waiting to confirm:** they get a confirmation, but at most one every 15 minutes, however often the form is submitted. A confirmation link works for 7 days, and an older one offers to send a fresh link.
- **Unsubscribed earlier:** they get a confirmation, and confirming it puts them back on your list.
- **Bounced, complained, or blocked:** no email goes out. [After a send](06-after-a-send.md) covers those addresses.
- **Erased at their request:** they get a confirmation, and confirming lifts the erasure, so they're back on your list.

## The confirmation email

**You can change its words in Settings → Confirmation email. Its layout and its link are fixed.**

The section shows the email as a reader gets it. Choose **Edit** to change four things:

- **Subject line**
- **Message**, the line above the confirm button
- **Button label**
- **Reassurance line**, a quiet footer for anyone who didn't sign up. Leave it blank to omit it.

A required field left blank uses Kestrel's default wording, and **Reset to Kestrel default** brings all of it back. Save with the page's save bar.

What you can't change keeps every confirmation working. The email always opens with your publication's name and logo, so a reader sees who's asking first. Kestrel adds the confirm link itself, so no edit can leave it out. The confirmation isn't a post, so it doesn't use your email template and has no unsubscribe link. The words on the page the link opens are fixed too, so what a reader agrees to can't be edited away.

## Put the form on your own site

**Copy the form from Settings → Ways to subscribe → Embed a form, and paste it into any page you control.**

Choose a look first:

- **Styled** looks like your subscribe page, with its own fonts and colors carried along, so it fits anywhere.
- **Plain** is bare markup that takes your site's styles, or the browser's own controls where your site has none.

The section shows the form as it will look beside the HTML that makes it. Choose **Copy HTML**, then paste it into your site. The form heads itself "Subscribe to" your publication's name.

A reader who submits it lands on your Kestrel's own check-your-inbox page, and confirms by email as on the subscribe page.

## Preview every reader page

**Settings → Reader pages shows each page a reader can land on, exactly as they see it, without walking through the steps.**

Pick a page from the list: the subscribe form and its check-your-inbox page, the confirm and unsubscribe pages, or your landing page, archive, and a post page. Pages a reader rarely meets, such as an expired link or an archive with no posts yet, are there too. **Desktop** and **Phone** show each at either width. These are samples, so nothing on them subscribes or unsubscribes anyone.

## When signups aren't open yet

**The form takes no addresses until whoever runs your Kestrel connects email.**

Until then, the subscribe page says the newsletter isn't taking subscribers yet, and the dashboard and Settings say so too. You can still share the link, and it opens once email is connected. [Connect Amazon SES](../get-started/04-ses.md) is that step.

Whoever runs your Kestrel can also limit how often anyone submits the form, which slows down abuse. [Rate-limit the subscribe form](../guides/05-rate-limit.md) covers it.

## Already have a list somewhere else

**Import it instead of asking everyone to sign up again.** Readers who opted in with your old service come with that record of their consent. [Bring your existing list](01-your-list.md) covers importing and exporting.

Next, send your first post: [Scheduling and sending](05-scheduling-and-sending.md).
