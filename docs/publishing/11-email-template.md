# Edit your email template

You write each post in Markdown, and the template is the HTML frame it's sent in, like a layout in a static site generator. `{{ .Post.Body }}` marks where your post goes, and the rest is plain HTML around it. The built-in template works as it comes, so changing it is optional.

To change it, choose **Template** in the sidebar, edit the HTML, and choose **Save changes**. **Start from example** offers two starting points. **Signed** ends each post with your logo, name, and tagline, and **Plain** has just your post and the footer links.

## What every template needs

Kestrel won't save a template without `{{ .Post.Body }}` and `{{ .Email.UnsubscribeURL }}`. Every email has to carry the post and a way to leave. The two **Required** pills above the editor turn green or red as your template gains or loses them.

Wrap a part in `{{ if .IsEmail }}` and `{{ end }}` to keep it off each post's public page. The starting templates do this with the unsubscribe link, the View in browser link, and the mailing address.

## Variables

A variable is replaced with its value in each email. Type it exactly as shown, or it renders as empty.

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
| `{{ .Email.ViewInBrowserURL }}` | The post's own web link, which opens its page once it's sent, in your archive or not. |

## Test it

**Send test email** on the **Template** page sends a sample post through your saved template, so you see it in a real inbox. With unsaved edits, the button reads **Save & send test**, since a test always uses the saved template.

A change to the template re-makes the email of every scheduled post, as [Schedule and send](04-write-a-post.md#schedule-and-send) describes.
