# Name your publication

Give your publication a name, a look, and a time zone before your first post. Set the name, tagline, and logo under **Settings → Publication identity**, then choose **Save changes**. All three are optional, and you can change them at any time.

**Set a name before your first post.** Readers see it as the sender of every email, beside your From address, so without one your emails arrive from the address alone. Readers recognize a newsletter by that name, and some filter on it, so rename rarely.

**Write the tagline as one line that says what the newsletter covers and how often it goes out,** such as "Monthly notes on the birds of the Hudson Valley." Until your first post, it's the only line on your home page that says what readers are signing up for. AWS reads it too if it reviews your site when you [request production access](../get-started/production-access.md).

The name, tagline, and logo appear in your emails wherever your [email template](email-template.md) prints them, on your public pages, and in the confirmation email. Search results and link previews of your public pages show them too. A change while posts are scheduled updates their emails, and Kestrel asks you to confirm first.

## Choose a logo

**Use a square PNG, JPEG, WebP, or GIF, at least 256 × 256 pixels, on a solid background.** Drop it on the logo under **Settings → Publication identity**, or choose **Upload**. It saves right away.

A wider or taller image is cropped to its center square, and a smaller one is scaled up and looks soft. An animated GIF keeps only its first frame. Emails show the logo at 44 × 44 pixels, so a simple mark reads better than fine detail. The built-in templates turn dark when a reader's mail app does, and a solid background keeps a dark mark visible there.

## Set the time zone

**Choose where your readers are, not where you are today.** Under **Settings → Time zone**, choose **Use** beside your browser's time zone if your readers share it, or search for a city or zone, such as Chicago or Eastern. Then choose **Save changes**. Nothing can be scheduled or sent until it's set.

Every time Kestrel shows you or Claude is on this clock: the times you schedule posts at, and the times in your notifications. Your published posts are dated by its day. A post sent at 8 PM in New York is dated that day, even in London.

You can change it at any time. A scheduled post still goes out at the same moment, and Settings shows its time on the new clock before you save. Public dates follow the new zone.

Kestrel's time zone rules come from Cloudflare, which can trail a government's change to them by months. If that affects a time you pick, the **Schedule** dialog says so.

## When to provide a mailing address

**If your newsletter is mostly your own writing, you probably don't need one. If an email is mainly selling something, add one.**

US law (CAN-SPAM) asks for a postal address in commercial email. The FTC [treats a newsletter people subscribed to](https://www.ftc.gov/sites/default/files/documents/federal_register_notices/definitions-and-implementation-under-can-spam-act-16-cfr-part-316/080521canspamact.pdf) as a relationship message instead, even with a few ads in it. An email whose main purpose is to sell, such as a launch, a sale, or a sponsor's promotion, is commercial. Canada's law (CASL) asks for an address more often ([Government of Canada guidance](https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en)).

A P.O. box or a registered private mailbox counts, so you never have to publish your home address. To add one, choose **Add a mailing address** under **Settings → Publication identity**. The built-in templates print it in the email footer and keep it off your public pages.

This is general information, not legal advice. The FTC's [CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) has the detail, and [Sending rules](sending-rules.md) covers the rest of what the law asks of a newsletter.

## Who sets the From name and address

The From address is set when your Kestrel instance is deployed, and [Deploy the app](../get-started/deploy.md#4-configure-production) changes it. **Settings → Email preview** shows a sample email with the sender as readers see it, your publication's name beside that address. If whoever deployed Kestrel wrote a name into the address, that name is the sender whatever you call your publication. **Settings → Email provider** says so.
