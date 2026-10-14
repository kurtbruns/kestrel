# Sending rules

Email law asks a few things of every newsletter. Kestrel handles the ones a sending app can, and the rest are yours, since they depend on what you write and whom you write to.

This page covers what Kestrel handles, what you handle, and how to act on a reader's request to leave or be deleted. It describes US law (CAN-SPAM) unless it says otherwise. It's general information, not legal advice. When your situation is unclear, ask a lawyer.

## What Kestrel handles

- **Consent.** Kestrel mails only people who confirmed they want your newsletter. Someone who subscribes gets an email with a link, and only once they confirm do they receive posts. People you import come with your old service's record of their consent, and your word for it ([Bring your existing list](01-your-list.md#why-your-old-services-record-is-honored)).
- **Unsubscribing.** Every email has an unsubscribe link, and the one-click unsubscribe header that Gmail and Yahoo ask bulk senders for. It takes effect at once. US law allows up to 10 business days.
- **Bounces and complaints.** An address that bounces, or a reader who marks your email as spam, is never mailed again. So a bad address can't keep hurting your sending reputation.
- **Sender authentication.** Your emails are signed with DKIM for your own domain, and SPF and DMARC records in its DNS vouch for them. Whoever runs your Kestrel sets these up, and mailbox providers now expect them.

## What you handle

- **An honest From name and subject line.** The From name should say who the email is from, and the subject should match what's inside. Whoever runs your Kestrel sets the From name and address.
- **Marking ads as ads.** When an email is an advertisement, say so clearly. In a newsletter that's mostly writing, labeling a sponsor's section is enough.
- **A mailing address, when an email is commercial.** Most newsletters don't need one. [When to provide a mailing address](03-name-your-publication.md#when-to-provide-a-mailing-address) says when you do, beside where you add one.
- **Requests readers send you.** A reader who replies to a post writes to your From address. Replies reach you once that address forwards to an inbox you read, which whoever runs your Kestrel sets up. Kestrel never sees a reply, so carrying out what a reader asks is up to you.

## When a reader asks to leave or to be deleted

Kestrel offers readers no form for deleting their data, so they ask you. In many places the law gives a reader that right. The European Union's GDPR, for example, may apply if you have readers there.

- **Say how to reach you.** Your privacy notice, wherever you publish it, should say how readers ask you about their data. Replying to any post works once replies reach your inbox.
- **To stop the email,** find a confirmed reader under **Subscribers**, and choose **Unsubscribe** from their ⋯ menu. It records that they asked, and they can rejoin by subscribing again. A reader who never confirmed gets no posts, so **Erase** is the choice for them.
- **To stop mailing someone on your own judgment,** not at their request, choose **Block** instead. It stops every email to the address whatever its status, and **Unblock** undoes it.
- **To delete their data,** choose **Erase** from the same menu. It removes the subscriber and how they joined, and can't be undone. Past send records show an erased recipient in their place. Kestrel keeps the address only so it's never mailed again, as [Bring your existing list](01-your-list.md#when-readers-reply) explains.
- **Act promptly.** Under the [GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj), you answer within a month in most cases (Article 12). The right to have data deleted is Article 17, and Article 13 asks you to tell readers about it when they sign up.

## Outside the US

Other countries have their own rules, and they often ask more. Canada's anti-spam law (CASL) usually counts more email as commercial, and asks for a mailing address in it ([Government of Canada guidance](https://ised-isde.canada.ca/site/canada-anti-spam-legislation/en)). The GDPR covers how you keep readers' data. If many of your readers live outside the US, check the rules where they live.

The FTC's [CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) is the plain-language source for the US rules on this page.
