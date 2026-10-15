# Name and brand your publication

Give your newsletter a name and a look before your first post. Set the name, tagline, and logo under **Settings → Publication identity**, and the [email template](03-name-your-publication.md#the-email-template) every post is sent in under **Template**. Your identity appears in your emails, on the public pages readers see, and in the confirmation email new subscribers get.

All three are optional and can change at any time. Left blank, the name falls back to your emails' From name. Pick a logo at least 256 × 256 px: Kestrel shows it square everywhere, cropping a wider or taller image to its center. An email already sent, and its archive page, keep the identity they went out with.

## When to provide a mailing address

**If your newsletter is mostly your own writing, you probably don't need one. If an email is mainly selling something, add one.**

US law (CAN-SPAM) asks for a postal address in commercial email. The FTC [treats a newsletter people subscribed to](https://www.ftc.gov/sites/default/files/documents/federal_register_notices/definitions-and-implementation-under-can-spam-act-16-cfr-part-316/080521canspamact.pdf) as a relationship message instead, even with a few ads in it. An email whose main purpose is to sell, such as a launch, a sale, or a sponsor's promotion, is commercial. Canada's law (CASL) asks for an address more often ([Government of Canada guidance](https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en)).

A P.O. box or a registered private mailbox counts, so you never have to publish your home address. To add one, choose **Add a mailing address** under **Settings → Publication identity**. The built-in templates print it in the email footer and keep it off your public pages.

This is general information, not legal advice. The FTC's [CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) has the detail, and [Sending rules](02-sending-rules.md) covers the rest of what the law asks of a newsletter.

## The email template

You write posts in Markdown, and the template is the HTML frame each one is placed in, like a layout in a static site generator. `{{ .Post.Body }}` is where your post goes, and the rest is plain HTML around it. The built-in template works as it comes. To change it, choose **Template** in the sidebar, edit, and save. **Start from example** offers two starting points, and **Send test email** sends a sample post through your saved template.

Kestrel won't save a template without `{{ .Post.Body }}` and `{{ .Email.UnsubscribeURL }}`. Every email has to carry the post and a way to leave. Wrap a part in `{{ if .IsEmail }}` and `{{ end }}` to keep it off each post's public page. The starting templates do this with the unsubscribe link and mailing address.

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

## Who sets the From name and address

The From name and address your emails come from are set when Kestrel is deployed, so **Settings → Email sender** shows them read-only. To change them, follow [Connect Amazon SES](../get-started/04-ses.md#8-set-the-provider-and-deploy).

