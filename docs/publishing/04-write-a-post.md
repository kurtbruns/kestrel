# Write and send a post

You write a post in Markdown, test it, and schedule it. Scheduling locks the post and makes the exact email that will go out. Then you send yourself a test of that copy, so the email you tested is the one your list receives.

**New post**, on the Dashboard or under **Drafts**, opens a draft.

## Writing

Kestrel's editor is a Markdown editor. You write a post in Markdown, the way you would for a static site generator or with an AI assistant. Kestrel places it in your [email template](11-email-template.md). The same Markdown makes the email and the post's archive page, so you never format a post twice. **Preview** shows the email as it will look, and Kestrel saves as you type.

A few things to know as you write:

- **A blank line starts a new paragraph.** In an email, a single line break doesn't.
- **The opening lines** are the preview a mail client shows beside the subject.
- **Images** go in by paste or drop, and Kestrel inserts a reference by file name, such as `![cover.jpg](cover.jpg)`. Replace the words in brackets with a short description. PNG, JPEG, WebP, or GIF, up to 5 MB each.
- **The subject** sets the post's slug, the end of its permanent archive address, such as `newsletter.example.com/archive/spring-update`. The slug is fixed once you schedule.

## Test it

**Send test email** sends the real email, through the same template and code as the send, to the addresses you name. **Settings → Default test recipients** fills them in for you. Nobody on your list gets anything, and a test's unsubscribe link unsubscribes no one.

Mail clients each draw email a little differently, so trust a test over **Preview**, especially for tables, code, and HTML. A test needs an email provider, which [Connect Amazon SES](../get-started/04-ses.md) sets up.

## Schedule and send

Choose **Schedule** at the foot of the editor, pick a time under **Send at**, and confirm. The time must be at least the minimum lead away: five minutes, unless your deployment sets a different [`MIN_LEAD_SECONDS`](../reference/01-configuration.md#min_lead_seconds). Neither the dashboard nor Claude can shorten it. Times are to the minute, and one with seconds rounds up.

Scheduling makes the email once, from the post, your template, and your publication's details as they are at that moment. That frozen copy is what goes out, and it's also the post's page in your archive. So the post is locked, and **Preview** and **Send test email** show the frozen copy.

**Send yourself a test now.** It's the copy your list receives, and the time until the send is your window to catch a mistake, including one Claude made.

Changing your template, or a publication detail it shows, re-makes the email of every scheduled post, with the same content and send time. Kestrel asks before it saves, and each re-made post then asks you to send a new test. A change is refused while a post is within the minimum lead of its send time, and Kestrel says when to try again. Posts already sending or sent never change.

**Send now →**, under the time picker, is for a post you've already reviewed. It still waits out the window, scheduling the post for the minimum lead from now.

### Changing your mind

**Cancel**, on the post's banner or its card under **Sent**, makes the post a draft again at once. Edit it, test again, and schedule it again. **Reschedule** moves the send time without unlocking the post, and your tests still count. You can do either until the send time.

### Who receives it

A post goes to your list as it stands when it sends: every confirmed subscriber, except addresses that bounced, complained, or were blocked. Someone who confirms while it's scheduled receives it. Someone who unsubscribes before their email is handed to your provider doesn't, even partway through the send.

So a recipient count shown before the send is a snapshot. An import that adds subscribers while a post is scheduled adds them to its audience too, and asks you first ([Bring your existing list](01-your-list.md#3-import-it)).

### Warnings when you schedule

- **No email provider connected.** The Schedule dialog can't schedule until one is connected ([Connect Amazon SES](../get-started/04-ses.md)). If the provider goes after a post is scheduled, the post is held, stays cancelable, and goes out once one is connected.
- **Daily database writes.** On Cloudflare's free Workers plan, a large send may use up the day's writes. The dialog warns you without stopping you, as [Bring your existing list](01-your-list.md#limits) explains.

### When it sends

At the send time, the post moves to its send page under **Sent**, where you can watch it go out. From then it can't be edited, canceled, or moved. Its archive page goes up at the same moment, showing exactly the copy that was sent, so every email's "view in browser" link works. Whatever interrupts a send, such as your provider's daily quota running out, it waits and resumes where it stopped. No reader gets the same post twice.

If a send needs your attention, the send page and the dashboard say so. [Troubleshooting](06-troubleshooting.md) covers each case.
