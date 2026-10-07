# Lock the dashboard with Access

Cloudflare Access puts a login in front of the editor and the API. Kestrel checks every request against that login as well, so a path left out of Access stays locked. The public pages readers see stay public.

In this guide, you set up Cloudflare Zero Trust, create one Access application that covers the editor and the API, and allow yourself in. Then you give the app two values from that application, and check that the login works. [How the admin gate works](../reference/03-admin-gate.md) explains the design.

## 1. Set up Zero Trust

Access is part of Cloudflare Zero Trust. Your account needs a Zero Trust organization before it can create an Access application. Skip this section if your account already has one.

1. In the [Cloudflare dashboard](https://dash.cloudflare.com/), select **Zero Trust**.

1. Choose a team name. It becomes your team domain, `YOUR_TEAM.cloudflareaccess.com`, where your login page lives.

1. Choose a plan. The Free plan covers a newsletter's editors. Cloudflare asks for payment details even on the Free plan, and doesn't charge them.

## 2. Create the Access application

The editor lives under `/dashboard`, and the API under `/api`. One application covers both, so they share one login.

1. In **Zero Trust**, go to **Access controls → Applications**, and select **Create new application**.

1. Select **Self-hosted and private**.

1. Select **Add public hostname**, and enter your app's hostname with the first path:

    - **Subdomain:** `newsletter`
    - **Domain:** `example.com`
    - **Path:** `dashboard`

1. Add a second public hostname with the same subdomain and domain, and the path `api`:

    | Path | What it covers |
    | --- | --- |
    | `dashboard` | the editor |
    | `api` | everything the editor and Claude read and change: posts, sends, subscribers, settings, and the in-app docs |

    Each path covers everything under it. Leave every other path out. The landing page, the archive, subscribing, unsubscribing, images, and your email provider's webhooks must stay public.

## 3. Allow yourself in

Every Access application denies everyone until a policy allows them.

1. Under **Access policies**, create a new policy:

    - **Policy name:** `Publishers`
    - **Action:** Allow
    - **Include:** the **Emails** selector, with your email address

1. Keep the login method a new Zero Trust organization starts with: you sign in with your Cloudflare account. To sign in another way, such as a one-time code by email, add it under **Zero Trust → Integrations → Identity providers** first.

1. Select **Create**.

## 4. Give the app its two values

The app verifies each login against your team domain, and checks that it was issued for this application.

1. Find your team domain under **Zero Trust → Settings**. It looks like `YOUR_TEAM.cloudflareaccess.com`.

1. Find the application's audience tag. Under **Access controls → Applications**, select **Configure** on your application. On the **Additional settings** tab, copy the **Application Audience (AUD) Tag**.

1. Store the team domain as a secret. The command prompts you for the value. Enter it without `https://`:

    ```bash
    npx wrangler secret put ACCESS_TEAM_DOMAIN --env production
    ```

1. Store the audience tag the same way:

    ```bash
    npx wrangler secret put ACCESS_AUD --env production
    ```

    A secret takes effect as soon as you store it, with no redeploy. The app needs both values. With either one missing, it can't verify any login, so it lets no one in.

1. **(Optional, recommended)** Limit the editor to named people. The Access policy decides who can sign in. This list keeps that true if the policy is widened later, for another app or by mistake. Enter a comma-separated list of email addresses at the prompt:

    ```bash
    npx wrangler secret put ACCESS_ALLOWED_EMAILS --env production
    ```

    Without it, the app lets in anyone your Access policy allows.

## Check it

1. In a private browser window, open `https://newsletter.example.com/dashboard/`. Cloudflare asks you to sign in.

1. Sign in. The editor loads, and its sidebar shows the email address you signed in with.

1. In the same window, open `https://newsletter.example.com/api/whoami`. It shows you as a signed-in person, verified through Access:

    ```
    {"principal":{"kind":"human","email":"you@example.com"},"auth":{"mode":"access"}}
    ```

1. The public pages still need no login:

    ```bash
    curl https://newsletter.example.com/health
    ```

    ```
    {"status":"ok","service":"kestrel"}
    ```

If Cloudflare lets you in but the editor answers `401`, check the two secrets. One may be missing or mistyped, or `ACCESS_ALLOWED_EMAILS` may leave out your address.

Next, [connect Resend](04-resend.md).
