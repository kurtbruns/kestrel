# Create an AWS account for your newsletter

Kestrel sends the newsletter's email through Amazon SES, which runs in an Amazon Web Services (AWS) account. This guide creates that account, so it's ready when you reach [Connect Amazon SES](../get-started/04-ses.md). Do it before you start Get started. Sign-up asks for things that can take time to set up, such as an email address that receives mail.

Create one account for each publication. SES keeps the sandbox, sending quotas, verified identities, and suppression list separately for each account and region. AWS can also pause an account's sending, so publications that share an account share each other's problems. To run several, [AWS Organizations](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_introduction.html) keeps their accounts under one bill. Keep its management account apart, with no newsletter in it.

In this guide, you choose the account's email address, sign up, and secure the account's root user. Then you set a monthly budget, so AWS emails you if the account ever costs more than you expect.

## Before you begin

- A phone number, and a credit or debit card for AWS's charges.
- Your domain's DNS on Cloudflare, if the account's email address will be forwarded with Cloudflare Email Routing.

## 1. Choose the account's email address

The address you sign up with belongs to the account's root user, the identity that owns the account and everything in it. You sign in as the root user with it, AWS contacts you there about the account, and it's how you recover the account. AWS recommends an address used for nothing else, which forwards to whoever looks after the account, as its [root user best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html) describe.

1. Choose an address named for its purpose, on your own domain, such as `aws@example.com`. Use one you'll keep, since recovering the account depends on it.

1. Make sure it receives mail before you sign up, since AWS emails it a code right away. If `example.com` receives no mail yet, forward the address to your inbox with Cloudflare Email Routing, as [Enable Email Routing](https://developers.cloudflare.com/email-routing/get-started/enable-email-routing/) describes. If `example.com` already receives mail at a mail host, create the address there instead, since Email Routing replaces a domain's mail servers.

## 2. Sign up

AWS may offer two ways to sign up. Choose **Sign up for AWS (advanced)**. The other way, **Sign up for AWS (new)**, makes an account with no root user, and chooses its region from your address. Its console differs from the one this guide describes. AWS's [Compare sign-up options](https://docs.aws.amazon.com/accounts/latest/reference/sign-up-for-aws.html) explains both.

1. Open [Sign up for AWS](https://signin.aws.amazon.com/signup?request_type=register). If it offers a choice, select **Sign up for AWS (advanced)**.

1. Enter the address from section 1 as the root user's email address, and an account name, such as your publication's name. Verify the address with the code AWS sends to it, and choose a password for the root user.

1. Choose the paid plan. The free plan closes the account automatically after six months, or sooner once its credits are used, unless you upgrade it before then. The paid plan gets the same sign-up credits, and keeps running once they're used. [AWS Free Tier plans](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html) describes both.

1. Enter your contact information and payment details, and confirm your phone number if AWS asks.

1. Choose the free Basic support plan. It's enough for everything the setup guide does. Asking AWS to let SES send to anyone is a form in the SES console, with no paid support plan needed.

1. Complete the sign-up. The console opens, signed in as the root user, and AWS emails the account's address when the account is ready.

## 3. Secure the root user

The root user can do anything in the account, including close it, so it needs more than a password. AWS requires multi-factor authentication (MFA) for it, and asks you to set it up soon after your first sign-in.

1. In the console, select your account name at the top right, and then **Security credentials**.

1. Under **Multi-factor authentication (MFA)**, choose **Assign MFA device**. Enter a device name, select **Passkey or Security Key**, and follow the prompts. A passkey on your computer or phone works.

1. Leave **Access keys** empty. A root user's key could do anything the root user can. [Connect Amazon SES](../get-started/04-ses.md#5-create-the-apps-aws-key) makes a separate key that can only send email.

## 4. Set a budget alert

AWS charges for what you use, with no spending limit, so a mistake or a leaked key could run up a bill before you notice. A budget emails you as the month's costs near an amount you choose. SES charges for each email it sends, as [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) lists.

1. In the console, open **Billing and Cost Management**, then **Budgets**, and choose **Create budget**.

1. Under **Use a template (simplified)**, select **Monthly cost budget**.

1. Enter a name, and an amount a little above what you expect to spend each month. Add the account's email address, or your own, as an email recipient. Choose **Create budget**.

1. AWS emails each recipient to verify it, and sends alerts only to a verified address. Open that email while you're signed in to the account, and verify the address within 12 hours, as [Budgets email recipients](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-email-recipients.html) describes.

## Check it

1. Sign out, and sign in again as the root user, with the address from section 1. After the password, AWS asks for your passkey or security key.

1. Under **Security credentials**, the MFA list shows your device, and **Access keys** lists none.

1. Under **Budgets**, your budget is listed, and its email recipient shows as **Active**.

The account is ready for [Connect Amazon SES](../get-started/04-ses.md), once the app is deployed and behind Access.
