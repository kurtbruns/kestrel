# Write and send a post

Write in Markdown, schedule it, then send yourself a test. Scheduling makes the exact email your list will get, so the test you send is what goes out.

**New post**, on the Dashboard or under **Drafts**, opens a draft.

## Write

The editor takes Markdown, and Kestrel saves as you type. The same Markdown becomes the email, in your [email template](email-template.md), and the post's page in your archive. **Preview** shows the email, and warns under it about anything it found wrong.

- A blank line starts a new paragraph.
- The opening lines are the preview a mail client shows beside the subject.
- Paste or drop an image to add it: PNG, JPEG, WebP, or GIF, up to 5 MB. A file named for a different format than it really is, like a JPEG called `photo.png`, is refused until you rename it. Kestrel may change its file name, turning spaces into hyphens and numbering a name the post already has, and inserts the new name for you.

## Schedule and send

Choose **Schedule**, pick a time under **Send at**, and confirm. The time is your publication's, in its [time zone](name-your-publication.md#set-the-time-zone), wherever you are: 9:00 means 9:00 for your readers. When your browser keeps another clock, the dialog names the zone and shows the same moment in your own time under it. The time must be at least five minutes away by default, or the lead whoever runs your instance set. That's your window to catch a mistake, and you can cancel or move the send until then. **Send now** sends after the same wait.

**Then send yourself a test.** Scheduling locks the post and makes its email, so **Send test email** now sends exactly what your list receives. **Settings → Default test recipients** fills in the addresses. A test needs an email provider, which [Connect Amazon SES](../get-started/ses.md) sets up. When it arrives, check:

- **The From name and address,** which readers see first. The name is your publication's ([Name your publication](name-your-publication.md)); the address is set when your instance is deployed.
- **Where it lands:** the inbox, Promotions, or spam. If it lands in spam, check your sending domain's records, as [Sending-domain DNS](../reference/sending-domain-dns.md) describes.
- **A reply.** Reply to the test, and check that it reaches your inbox. Kestrel never sees replies, so this depends on [forwarding your From address](../get-started/ses.md#8-receive-replies-at-your-from-address).

A test sent from a draft is only a preview, and doesn't check off the dashboard's **Send a test email for your first post**. A change to your template or publication identity re-makes the scheduled email, so test again after one.

To change the post, choose **Cancel** on its banner, and it's a draft again. **Edit schedule** moves the time without unlocking it.

At the send time, the post goes to your confirmed subscribers, and its page goes up in your archive. Watch it go out under **Sent**. Your first post that goes to the archive ends the dashboard's setup steps; an email-only one doesn't. If a send needs you, its page says so, and [Troubleshooting](troubleshooting.md) covers each case.

## Post settings

**Post settings**, at the top right of the editor, holds two choices you can change until the post sends:

- **Include in archive.** Uncheck it to send the post as email only, for a correction or a short notice. It stays off your archive and home page.
- **Archive address.** It follows the subject until you type your own. It's fixed once the post sends.

After a post sends, its page under **Sent** can take it out of your archive or put it back.
