# Name your publication

Give your newsletter a name and a look before your first post. Readers see your name, tagline, and logo in every email and on every public page. It's the first step of **Set up your publication** on your dashboard.

You set them under **Settings → Publication identity**. Every email takes its look from one template, which works as it comes and which you can edit on the **Template** page. This page also covers the optional mailing address, what a change does to scheduled posts, and who sets the From name and address.

## Name, tagline, and logo

All three are optional, and you can change them at any time under **Settings → Publication identity**. The name and tagline save with **Save changes** in the bar at the bottom of the page. The logo saves the moment you pick it.

- **Name.** Left blank, your publication uses the From name of your emails instead. If that has no name either, your publication goes unnamed, and every page reads whole without one.
- **Tagline.** A short line under the name.
- **Logo.** A PNG, JPEG, WebP, or GIF image. Kestrel shows it square everywhere, so a wider or taller image is cropped to its center square. Pick one at least 256 × 256 px. **Replace** swaps it, and **Remove** takes it away.

Sent emails never change. An email already sent, and its archive page, keep the logo and name they went out with.

## Where each part appears

Your identity shows in four places:

- **In your emails,** wherever your template prints it. The built-in template signs off each post with your logo, name, and tagline. The sample email under **Settings → Email template** shows which parts your template prints.
- **On the public pages readers see.** Your home page, your archive, and each post's page carry your identity. So do the pages for subscribing, confirming, and unsubscribing. Your logo is the browser tab's icon. **Settings → Reader pages** shows each of these pages as a reader gets it.
- **In the confirmation email** a new subscriber gets, which opens with your logo, name, and tagline.
- **In the dashboard.** The top of the sidebar shows your logo, name, and tagline.

A post's page shows your publication as it is now at the top, and the sign-off as it was sent.

## When to provide a mailing address

**Probably not, if your newsletter is mostly your own writing. Yes, if you use it to sell.** The address is optional, and you can add it or remove it at any time.

US law (CAN-SPAM) requires a postal address in commercial email. That's email whose primary purpose is to advertise or promote a product or service, at any volume. In its [2008 rule](https://www.ftc.gov/sites/default/files/documents/federal_register_notices/definitions-and-implementation-under-can-spam-act-16-cfr-part-316/080521canspamact.pdf), the FTC treats a newsletter someone subscribed to as a "transactional or relationship" message instead. That holds when it's mainly content, even with ads mixed in. A subscription that's purely advertising, like a catalog, stays commercial.

An email whose primary purpose is selling is a different matter. The FTC's [primary-purpose test](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-316/section-316.3) looks at what the email says and what its subject line suggests. So you probably need an address in:

- An email that's mainly selling, such as a launch, a sale, a paid course, or event tickets.
- A post that's mostly sponsor content or promotions.
- A mixed email whose subject line reads like an ad.

A nonprofit isn't exempt as a kind of sender. What the email says decides it. Canada's anti-spam law (CASL) usually counts more email as commercial, and asks for a mailing address in it too ([Government of Canada guidance](https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en)). Gmail and Yahoo don't ask for one: their [rules for bulk senders](https://support.google.com/a/answer/14229414) are authentication, one-click unsubscribe, and a low spam-complaint rate.

**What counts.** A street address, a USPS P.O. box, or a private mailbox registered with the Postal Service. You never have to publish a home address.

**Adding it.** Under **Settings → Publication identity**, choose **Add a mailing address**. The built-in template and both starting templates print it in the footer as soon as it's set, and print nothing while it isn't. They keep it off each post's public page, so your address isn't on the web.

If you've added an address and your template doesn't include `{{ .Publication.Address }}`, Kestrel saves your change and warns you. A line under the address says so in Settings, and the **Template** page says so when you save. If you typed your address into the template yourself, or don't need one, you can ignore the warning.

This is general information, not legal advice. The FTC's [CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) is the plain-language source, and [Sending rules](02-sending-rules.md) covers the rest of what the law asks of a newsletter.

## The email template

The template is the layout every post is sent in: HTML with a style block, and variables Kestrel fills in when it sends. There is one template, used by every post. Choose **Template** in the sidebar, or **Edit template →** under **Settings → Email template**.

You start from a built-in default. **Start from example** offers two starting templates to replace what's in the editor:

- **Signed:** your post, then your logo, name, and tagline as a sign-off.
- **Plain:** just your post and the footer links.

Both put the unsubscribe link, a View in browser link, and your mailing address in the footer, and both end with "Powered by Kestrel". From there, edit the HTML as you like, then press **Save changes**. **Discard** throws your edits away.

### Variables

A variable is replaced with its value in each email. Type it exactly as shown, or it renders as empty. The **Variables** list at the bottom of the **Template** page says what each one holds.

| Variable | What it holds |
| --- | --- |
| `{{ .Post.Body }}` | Your post, rendered from Markdown. Required. |
| `{{ .Post.Subject }}` | The post's subject line. |
| `{{ .Publication.Name }}` | Your publication's name. |
| `{{ .Publication.Tagline }}` | Your tagline. |
| `{{ .Publication.Logo }}` | Your logo as an image, or nothing when no logo is set. |
| `{{ .Publication.LogoURL }}` | Your logo's address, or empty. |
| `{{ .Publication.Address }}` | Your mailing address, or empty. |
| `{{ .Email.SentTo }}` | The address this email was sent to. |
| `{{ .Email.UnsubscribeURL }}` | This reader's one-click unsubscribe link. Required. |
| `{{ .Email.ViewInBrowserURL }}` | The post's public page. |

Kestrel won't save a template without `{{ .Post.Body }}` or `{{ .Email.UnsubscribeURL }}`. Every email has to carry the post and a way to leave. The two **Required** pills above the editor turn green or red as your template gains or loses them.

### Email-only parts

Wrap part of the template in `{{ if .IsEmail }}` and `{{ end }}` to keep it off each post's public page. The starting templates wrap the unsubscribe link, the View in browser link, and the mailing address this way. To show your address on the web too, move it outside the wrapped part.

### Test the template

The sample email at the top of the **Template** page shows the layout with sample content. Mail apps each draw email their own way, so send yourself a test to see it in a real inbox.

**Send test email** sends a sample post through your saved template, to the addresses you choose. Your default test recipients, from **Settings → Default test recipients**, fill in first. With unsaved edits, the button reads **Save & send test**, since a test always uses the saved template.

## Changes and scheduled posts

When you schedule a post, Kestrel makes its email then, with your template and identity as they stand. So when you change the template, or a part of your identity the template prints, Kestrel makes each scheduled post's email again. Nothing changes until you confirm.

When you save, a dialog lists the scheduled posts by subject and send time. Each email's look changes, while its content and send time stay the same. **Save and apply** goes ahead, and **Cancel** leaves your edits unsaved. A logo upload or removal asks the same way.

Afterwards, each of those posts says its look changed since your last test. The mark shows in the editor and on the dashboard until you send a fresh test. Send one, since your earlier test no longer shows what goes out. [Scheduling and sending](05-scheduling-and-sending.md) covers tests of a scheduled post.

- **Changing a part the template doesn't print** asks nothing, since it doesn't change any email.
- **A post about to send** blocks the change. Kestrel says when you can try again, once that post has gone out.
- **Posts already sending or sent** never change.

## Who sets the From name and address

Whoever runs your Kestrel sets the From name and address your emails come from. You can't change them in the dashboard, and **Settings → Email sender** shows them read-only. [Connect Amazon SES](../get-started/04-ses.md#8-set-the-provider-and-deploy) covers setting them.

Next, [Check your setup](10-check-your-setup.md).
