# Write your first post

You write a post in Markdown, in the editor. Kestrel saves it as you type and shows you the exact email under **Preview**. A test sends that same email to any inbox you name.

This page covers the subject and slug, the Markdown Kestrel reads, images, and saving. It also covers sharing a post with Claude or another tab, the preview, and test emails. It stops where scheduling starts.

## Start a post

**New post**, on the Dashboard or on **Drafts**, creates a draft and opens it in the editor. A draft stays under **Drafts** until you schedule it, and you can edit it as often as you like until then.

To remove a draft, choose **Delete draft** from its ⋯ menu under **Drafts**. Its saved versions and images go with it, and it can't be undone.

## The subject and the slug

The **Subject** is the email's subject line. It also names the post in your lists and sets its web address. A post needs a subject before you can schedule it.

The **Slug** is the last part of the post's public address. Every post you send gets a permanent page in your publication's archive, and every email links to it. With the default setup, a post with the slug `spring-update` lives at `newsletter.example.com/archive/spring-update`. Whoever runs your Kestrel chose the part before the slug, as [Configuration](../reference/01-configuration.md#archive_base_path) describes.

While **Auto-generate from subject** is checked, the slug follows the subject, so "Spring update" becomes `spring-update`. Type a slug of your own to set it by hand, and it stops following the subject. Clear the field, or check the box again, to have it follow the subject.

A slug uses lowercase letters, numbers, and hyphens, and Kestrel converts what you type to that form. No two posts share a slug, drafts included. When the one a post would take is already held, Kestrel adds a number, such as `spring-update-2`. The field shows the slug the post really has, so it can update a moment after you change the subject.

A draft's slug can change until you schedule it, and a test email sent before a change links to the old address. Once the post is scheduled, its address never moves. **Web version ↗** shows the post's public page as it will look, and the address it will have.

## Markdown

Kestrel reads Markdown in GitHub's flavor and turns it into the body of your email template. The toolbar covers the common cases: **Heading**, **Bold**, **Italic**, **Quote**, **Code**, **Link**, **Bulleted list**, **Numbered list**, and **Indent**. ⌘B, ⌘I, and ⌘K work too.

Tables and strikethrough work as well, since they're part of GitHub's Markdown. How a mail client draws them varies, and so does code, so check anything unusual in a test email.

A few things work differently in an email:

- **Line breaks.** A single line break inside a paragraph doesn't start a new line. Leave a blank line between paragraphs.
- **HTML.** You can write HTML where Markdown falls short. Kestrel removes scripts, `<style>` blocks, forms, and event handlers, since no email needs them. Style a piece with an inline `style` attribute instead.
- **The inbox preview.** The snippet a mail client shows beside the subject comes from the start of your post. There's no separate field for it, so make the opening lines count.
- **The plain-text version.** Every email also carries a plain-text version made from the same post. A link becomes its text followed by its address, and an image becomes its alt text.

## Images

To add an image, paste it, drop it on the composer, or click **Paste, drop, or click to add images** below it. Kestrel uploads the file to the post and inserts a reference by its file name, such as `![cover.jpg](cover.jpg)`. The reference is only the name, never an address to paste.

The words in square brackets are the image's alt text, which screen readers read aloud and many mail clients show while images are blocked. Kestrel starts it as the file name, so replace that with a short description: `![A stack of paperbacks on a windowsill](cover.jpg)`.

- **Formats.** PNG, JPEG, WebP, or GIF. SVG isn't accepted, since most email apps don't show it.
- **Size.** Up to 5 MB per image. Kestrel doesn't shrink the file, and every reader downloads it, so a smaller file opens faster. An image wider than the email's column is shown at the column's width.
- **Warnings.** The preview and each test warn you about an image with no alt text, or a reference to a file the post doesn't have.

Images are public, so any mail client and your archive page can load them. You can add or replace images only while the post is a draft. Uploading a file with the same name as an earlier one replaces it. Once a post is scheduled its images are fixed, and a sent post's images stay, so its emails and archive page keep showing them. Deleting a draft deletes its images.

## Saving and versions

The editor saves on its own, after a short pause in your typing and never more than half a minute late. **Save draft**, or ⌘S, saves at once.

Beside **Save draft**, the save cue says where you stand: Unsaved, Saving…, or Saved. If a save fails, the cue turns red with "Not saved:" and the reason, until a save succeeds. After a dropped connection the editor tries again on its own.

Every save keeps a whole version of the post. The editor doesn't show that history, but Claude can read it, as [Working with Claude](07-working-with-claude.md) describes.

## When someone else edits the same post

Kestrel never lets one save silently overwrite another. That matters when the same post is open in a second tab or browser, or Claude is editing it for you.

When another writer saves a newer version, a banner says so and names who, with Claude's saves shown as "Claude". It appears while you're still writing, not only when you save. Saving pauses until you choose:

- **Reload** loads their version, and discards your unsaved edits.
- **Keep editing** keeps yours, and your next save replaces their version.

Both choices lose something, so read what changed before you pick. If the post is scheduled elsewhere, the banner says it can no longer be edited here. If it's deleted elsewhere, the editor says so and returns to **Drafts**.

## Preview

**Preview** shows the post as the email, made by the same code that makes your test emails and the send itself. It saves your latest edits first, so what you see is the post as it stands. Any warnings, such as a missing subject or alt text, show beneath it.

Three views show the post, each for one purpose:

- **Preview** is the email, for a quick look at layout.
- **Send test email** is the email in a real inbox, where rendering finally counts.
- **Web version ↗** is the post's public archive page, before it's public.

Inside the preview, the email's "view in browser" link opens the web version, since the public page doesn't exist until the post sends. Mail clients each draw email a little differently, so trust a test over the preview.

## Test emails

**Send test email** opens a dialog that takes one or more addresses, one per line. Each gets its own copy of the email, and nobody on your list receives anything. The addresses in **Settings → Default test recipients** fill the dialog for you.

A test is the real email. It saves your draft first, then sends it through the same template and code as the send to your list. So a clean test means a clean send. Once a post is scheduled, a test sends the exact copy that will go out.

When some addresses don't get the test, the dialog stays open with only those left, and says why. **Send test** again tries just those, so no one gets a second copy.

A few links in a test behave differently from the real send:

- **Unsubscribe.** A test carries an unsubscribe link and the one-click unsubscribe header, so you can check both. Neither unsubscribes anyone. The link opens the page a subscriber sees, marked as a test and showing a sample address.
- **View in browser.** The link points at the post's public address, which shows a page saying the post appears there once it's sent. It works once the send starts.

A test needs an email provider. Until whoever runs your Kestrel connects one, the editor lets you write and preview but not send tests. [Connect Amazon SES](../get-started/04-ses.md) is their step.

## Next

When the test looks right, [Scheduling and sending](05-scheduling-and-sending.md) covers putting the post on the schedule. On a new publication, finish setting up first: [Share your subscribe link](09-share-your-subscribe-link.md).
