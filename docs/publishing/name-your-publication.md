# Name your publication

Give your publication a name, a look, and a time zone before your first post. Set the name, tagline, and logo under **Settings → Publication identity**. They appear in every email your template prints them in, on the public pages readers see, and in the confirmation email new subscribers get. The name is also what readers see as the sender of every email, beside the From address, so set one before your first post: without it, your emails arrive with no name, from the address alone.

All three are optional, and you can change them at any time. How they appear in each email comes from your email template, which you can [edit](email-template.md). Renaming the publication while posts are scheduled updates their emails, and Kestrel asks you to confirm first. Readers recognize a newsletter by its sender's name, and some filter on it, so rename rarely.

Write the tagline as one line that says what the newsletter covers and how often it goes out, such as "Monthly notes on the birds of the Hudson Valley." Until your first post, it's the only line on your home page that says what readers are signing up for. It's also what AWS sees if it reviews your site when you [request production access](../get-started/production-access.md).

## Choose a logo

**Use a square PNG, JPEG, WebP, or GIF, at least 256 × 256 pixels, on a solid background.** Drop it on the logo under **Settings → Publication identity**, or choose **Upload**, which reads **Replace** once you have a logo. It saves right away, without **Save changes**. If that would change scheduled emails, Kestrel asks you to confirm first.

Kestrel makes a 256 × 256 PNG from your image before uploading it, so the original's file size doesn't matter. A wider or taller image is cropped to its center square, and a smaller one is scaled up and looks soft. An animated GIF keeps its first frame. Emails show the logo at 44 × 44 pixels, so a simple mark reads better than fine detail.

A transparent background shows whatever is behind the logo, and the built-in templates turn dark when a reader's mail app is in dark mode. A solid background keeps a dark mark visible there.

## Set the time zone

**Choose where your readers are, not where you are today.** A New York newsletter keeps New York's clock wherever you are that week. Kestrel uses the time zone for the times you schedule posts at, the dates on your published posts, and the times in your notifications, so nothing can be scheduled or sent until it's set. Pick it under **Settings → Time zone** and choose **Save time zone**. Kestrel fills in your browser's time zone as a suggestion, but saves nothing until you click.

Your published posts are dated by your publication's day, so a post sent at 8 PM in New York is dated that day, even for a reader in London, where it's already the next morning. The date names no time zone, like a newspaper's dateline.

You can change it at any time. A post that's already scheduled keeps its moment and doesn't move, and Kestrel tells you how it now reads ("now Fri Nov 13, 8:00 AM Central Time. Move it if you meant 9:00 AM."), so you can move it yourself with **Edit schedule**. Public dates follow the new zone, so a post sent near midnight may show a different date afterward.

Kestrel's time zone rules come from Cloudflare's servers, which can trail a recent government change, such as a country dropping daylight saving time, by months. If your zone's rules changed recently, times near the change may read an hour off until Cloudflare catches up.

## When to provide a mailing address

**If your newsletter is mostly your own writing, you probably don't need one. If an email is mainly selling something, add one.**

US law (CAN-SPAM) asks for a postal address in commercial email. The FTC [treats a newsletter people subscribed to](https://www.ftc.gov/sites/default/files/documents/federal_register_notices/definitions-and-implementation-under-can-spam-act-16-cfr-part-316/080521canspamact.pdf) as a relationship message instead, even with a few ads in it. An email whose main purpose is to sell, such as a launch, a sale, or a sponsor's promotion, is commercial. Canada's law (CASL) asks for an address more often ([Government of Canada guidance](https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en)).

A P.O. box or a registered private mailbox counts, so you never have to publish your home address. To add one, choose **Add a mailing address** under **Settings → Publication identity**. The built-in templates print it in the email footer and keep it off your public pages.

This is general information, not legal advice. The FTC's [CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) has the detail, and [Sending rules](sending-rules.md) covers the rest of what the law asks of a newsletter.

## Who sets the From name and address

The From address your emails come from is set when Kestrel is deployed, so **Settings → Email sender** shows it read-only, with how readers see the sender: your publication's name beside that address. To change the address, follow [Deploy the app](../get-started/deploy.md#4-configure-production). If whoever deployed Kestrel wrote a name into the address, that name is the sender whatever you call the publication here; **Settings → Email sender** says so, and the deploy is where it changes.

