# Name your publication

Give your publication a name and a look before your first post. Set the name, tagline, and logo under **Settings → Publication identity**. They appear in every email your template prints them in, on the public pages readers see, and in the confirmation email new subscribers get.

All three are optional, and you can change them at any time. How they appear in each email comes from your email template, which you can [edit](11-email-template.md).

Write the tagline as one line that says what the newsletter covers and how often it goes out, such as "Monthly notes on the birds of the Hudson Valley." Until your first post, it's the only line on your home page that says what readers are signing up for. It's also what AWS sees if it reviews your site when you [request production access](../get-started/04-ses.md#4-request-production-access).

## When to provide a mailing address

**If your newsletter is mostly your own writing, you probably don't need one. If an email is mainly selling something, add one.**

US law (CAN-SPAM) asks for a postal address in commercial email. The FTC [treats a newsletter people subscribed to](https://www.ftc.gov/sites/default/files/documents/federal_register_notices/definitions-and-implementation-under-can-spam-act-16-cfr-part-316/080521canspamact.pdf) as a relationship message instead, even with a few ads in it. An email whose main purpose is to sell, such as a launch, a sale, or a sponsor's promotion, is commercial. Canada's law (CASL) asks for an address more often ([Government of Canada guidance](https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en)).

A P.O. box or a registered private mailbox counts, so you never have to publish your home address. To add one, choose **Add a mailing address** under **Settings → Publication identity**. The built-in templates print it in the email footer and keep it off your public pages.

This is general information, not legal advice. The FTC's [CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) has the detail, and [Sending rules](02-sending-rules.md) covers the rest of what the law asks of a newsletter.

## Who sets the From name and address

The From name and address your emails come from are set when Kestrel is deployed, so **Settings → Email sender** shows them read-only. To change them, follow [Deploy the app](../get-started/02-deploy.md#4-configure-production).

