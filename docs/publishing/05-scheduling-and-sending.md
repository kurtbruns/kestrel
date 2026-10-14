# Scheduling and sending

Every post goes out on a schedule. Scheduling makes the email and locks the post, and the send stays visible and cancelable until its time comes. That window is your review, and nothing can skip it, not even **Send now**.

This page covers scheduling, what it freezes, canceling, moving the send time, and sending now. It also covers who receives a post, and what happens when it goes out.

## Scheduling a post

**Schedule** at the foot of the editor opens a dialog where you pick a time under **Send at**, then confirm with **Schedule**. The post goes out at that time, and until then you can cancel it or move it.

The time you pick must be at least the minimum lead away. That's five minutes, unless whoever runs your Kestrel set it differently ([Configuration](../reference/01-configuration.md#min_lead_seconds)). A time closer than that is refused under the picker, with the reason. The lead isn't a setting in the dashboard, and Claude can't change it either. So every send gets a window to catch a mistake, including one Claude prepared.

Send times are to the minute. A time with seconds is rounded up to the next whole minute, which only lengthens the window.

A post needs a subject to schedule. If the subject is empty, pressing **Schedule** marks the **Subject** field with "Add a subject before you schedule." An empty body gets a warning, not a refusal.

After you schedule, you stay on the post. A toast names the send time and suggests you send yourself a test, since the window is where you review. The post now shows the scheduled banner: "Scheduled for" the time, with a countdown ("Sends in …"), and **Reschedule** and **Cancel** beside it.

You manage a scheduled post from that banner, or from the **Scheduled** card on **Sent**. The dashboard's **Scheduled** card shows the countdown and opens the post.

## What scheduling freezes

Scheduling makes the email once, from the post, your email template, and your publication's details as they are at that moment. That frozen copy is what goes out, and it's also the post's page in your archive.

So the post is locked while it's scheduled. It opens on **Preview**, which shows the frozen copy. On **Edit**, you can still read, select, and copy the text, and the composer's foot says "Cancel the schedule to edit". **Send test email** still works, and sends you the frozen copy that will go out.

To change the post's content, cancel the schedule, edit, test again, and schedule it again. That resets your review, so your last test is always of the copy that sends.

A change to your template, or to a publication detail the template shows, is different. It re-makes the email of every scheduled post, at the same send times, with the same content. Kestrel asks before it saves, in a dialog confirmed with **Save and apply**. Afterwards each re-made post's banner asks you to send a new test. The dashboard's card reads "Look changed since your last test" until you do. A save like this is refused while any scheduled post is within the minimum lead of its send time. The refusal says when to try again. [Name your publication](03-name-your-publication.md) covers the template and those details.

## Canceling

**Cancel** on the scheduled banner, or on the **Scheduled** card on **Sent**, stops the send at once. No confirmation is asked, since nothing is lost: the post is a draft again, editable, and you can schedule it again whenever you like.

You can cancel until the send time itself. From then the banner reads "Preparing to send…" and its buttons are unavailable, because the email is going out. A cancel that arrives just after the send time is refused with "Too late to cancel: the send time has passed, so this email is going out."

## Moving the send time

**Reschedule** moves when a scheduled post sends, without canceling it. It opens the same time picker, and **Reschedule** confirms it. The content stays frozen, your tests still count, and the post stays cancelable until the new time.

The new time follows the same rule as scheduling: at least the minimum lead away. Like canceling, you can move a send only before its send time.

## Sending now

Under the time picker in the Schedule dialog, "Or send as soon as possible." leads to **Send now →**. It's for a post you've already reviewed and want out without picking a time.

Sending now still goes through the review window. The **Send now?** view says how many recipients it reaches and when, such as "in 5 to 6 minutes". The range is the minimum lead, plus rounding up to the next minute. Confirm with **Send now**, and the post is locked and scheduled for that time, cancelable until then like any other.

## Who receives it

A post goes to your list as it stands when it sends: every confirmed subscriber, except addresses that bounced, complained, or were blocked. Someone who confirms while the post is scheduled receives it. Someone who unsubscribes before their email is handed to your email provider doesn't, even partway through the send.

So the recipient count the **Send now?** view shows is a snapshot, not a promise. An import that adds subscribers while a post is scheduled adds them to its audience too. The import asks you to acknowledge that first ([Bring your existing list](01-your-list.md#what-an-import-does)).

## Warnings in the Schedule dialog

The Schedule dialog warns you about two things before you schedule.

- **No email provider connected.** The dialog says the post can't be scheduled yet, and its buttons are unavailable. Connecting a provider is for whoever runs your Kestrel, as [Connect Amazon SES](../get-started/04-ses.md) describes. If the provider goes after a post is scheduled, its banner reads "Will be held: no email provider is connected." The post stays cancelable, and goes out once a provider is connected.
- **Daily database writes.** On the Workers Free plan's limits, a large send may use up the day's database writes, which stops your newsletter until midnight UTC. The dialog warns you, and the post's banner repeats the warning for as long as it's scheduled. It never stops you from scheduling. [Bring your existing list](01-your-list.md#limits) explains the limit and when it's worth moving to Workers Paid.

## When it sends

At the send time, the post moves from the editor to its send page under **Sent**, where you can watch it go out. If you have the post open, the page switches over with a toast saying why. From here the post can't be edited, canceled, or moved.

A send goes out a slice at a time. A large list takes several slices, and between them the send still reads **Sending**, with "Paused between ticks. It resumes on the next sweep."

If your email provider refuses to take more, for example because your account's daily sending quota is spent, the send waits. Nobody is marked unsent, and it tries again on its own, picking up where it stopped once the quota frees up. Raising the quota is for whoever runs your Kestrel ([As your list grows](../get-started/06-go-live.md#as-your-list-grows)).

Whatever interrupts a send, it resumes rather than starting over. No reader is ever mailed the same post twice.

[After a send](06-after-a-send.md) covers what the send page shows once it's out: the record, bounces, complaints, unsent recipients, and your archive page.
