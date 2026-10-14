# Sending rules

Email law asks a few things of every newsletter. Kestrel handles the ones a sending app can, and the rest are yours, since they depend on what you write and whom you write to.

This page covers what Kestrel handles, what you handle, and when you need a mailing address in your emails. It describes US law (CAN-SPAM) unless it says otherwise. It's general information, not legal advice. When your situation is unclear, ask a lawyer.

## What Kestrel handles

- **Consent.** Kestrel mails only people who confirmed they want your newsletter. Someone who subscribes gets an email with a link, and only once they confirm do they receive posts. People you import come with your old service's record of their consent, and your word for it ([Your list](01-your-list.md#why-your-old-services-record-is-honored)).
- **Unsubscribing.** Every email has an unsubscribe link, and the one-click unsubscribe header that Gmail and Yahoo ask bulk senders for. It takes effect at once. US law allows up to 10 business days.
- **Bounces and complaints.** An address that bounces, or a reader who marks your email as spam, is never mailed again. So a bad address can't keep hurting your sending reputation.
- **Sender authentication.** Your emails are signed for your own domain, with SPF, DKIM, and DMARC. Whoever runs your Kestrel set these up, and mailbox providers now expect them.

## What you handle

- **An honest From name and subject line.** The From name should say who the email is from, and the subject should match what's inside. Whoever runs your Kestrel sets the From name and address.
- **Marking ads as ads.** When an email is an advertisement, say so clearly. In a newsletter that's mostly writing, labeling a sponsor's section is enough.
- **A mailing address, when an email is commercial.** Most newsletters don't need one. [When to provide a mailing address](#when-to-provide-a-mailing-address), below, says when you do.
- **Requests readers send you.** A reader who replies to a post writes to your From address. Replies reach you once that address forwards to an inbox you read, which whoever runs your Kestrel sets up. Kestrel never sees a reply, so carrying out what a reader asks is up to you.

## When a reader asks to leave or to be deleted

Kestrel offers readers no form for deleting their data, so they ask you. In many places the law gives a reader that right. The European Union's GDPR, for example, may apply if you have readers there.

- **Say how to reach you.** Your privacy notice, wherever you publish it, should say how readers ask you about their data. Replying to any post works once replies reach your inbox.
- **To stop the email,** find the reader under **Subscribers**, and choose **Unsubscribe** from their ⋯ menu.
- **To delete their data,** choose **Erase** from the same menu instead. It removes the subscriber and how they joined, and can't be undone. Kestrel keeps only the address, marked do-not-contact, so it's never mailed again. [Your list](01-your-list.md#when-readers-reply) says more.
- **Act promptly.** Under the [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj), you answer within a month in most cases (Article 12). The right to have data deleted is Article 17, and Article 13 asks you to tell readers about it when they sign up.

## When to provide a mailing address

**Probably not, if your newsletter is mostly your own writing. Yes, if you use it to sell.**

US law requires a postal address in commercial email. That's email whose main purpose is to advertise or promote a product or service, at any volume. A newsletter people subscribed to usually isn't commercial email, as long as it's mainly content. A sponsor mention or an ad mixed in doesn't change that. The FTC said so in its [2008 rule](https://www.ftc.gov/sites/default/files/documents/federal_register_notices/definitions-and-implementation-under-can-spam-act-16-cfr-part-316/080521canspamact.pdf). A newsletter that's purely advertising, like a catalog, is commercial.

You need an address in:

- An email that's mainly selling, such as a launch, a sale, a paid course, or event tickets.
- An issue that's mostly sponsor content or promotions.
- A mixed email whose subject line reads like an ad.

A nonprofit isn't exempt as a kind of sender. What the email says decides it.

**What counts.** A street address, a USPS P.O. box, or a private mailbox registered with the Postal Service. You never have to publish a home address.

**Adding it in Kestrel.** In **Settings → Publication identity**, choose **Add a mailing address**. The built-in email templates print it in the footer. If you wrote your own template, keep `{{ .Publication.Address }}` in it, or type the address in yourself. Kestrel warns you when you've added an address and your template leaves it out.

Gmail and Yahoo don't ask for an address. Their [rules for bulk senders](https://support.google.com/a/answer/14229414) are authentication, one-click unsubscribe, and a low spam-complaint rate.

## Outside the US

Other countries have their own rules, and they often ask more. Canada's anti-spam law (CASL) counts more email as commercial, and asks for a mailing address in it. The GDPR covers how you keep readers' data. If many of your readers live outside the US, check the rules where they live.

The FTC's [CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) is the plain-language source for the US rules on this page.
