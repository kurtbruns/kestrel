# Lock the dashboard with Access

Cloudflare Access puts a login in front of the editor and the API. Kestrel checks every request against that login as well, so a path left out of Access stays locked. The public pages readers see stay public.

In this guide, you set up Cloudflare Zero Trust, create one Access application that covers the editor and the API, and allow yourself in. Then you give the app two values from that application, optionally let Claude Code sign in as you, and check that the login works.

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

    Each path covers everything under it. Leave every other path out. The home page, the archive, subscribing, unsubscribing, images, and your email provider's webhooks must stay public.

1. **(Optional)** Choose how long a sign-in lasts. The application's session duration defaults to 24 hours, so everyone signs in again each day. You can set anything from immediately to one month, as Cloudflare's [session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/) describes. A longer session suits a publisher on their own computer, and a shorter one is safer on a shared one.

## 3. Allow yourself in

Every Access application denies everyone until a policy allows them.

1. Under **Access policies**, create a new policy:

    - **Policy name:** `Publishers`
    - **Action:** Allow
    - **Include:** the **Emails** selector, with your email address

1. Keep the login method a new Zero Trust organization starts with, Cloudflare's own: you enter your email, and confirm the sign-in from the message Cloudflare sends to it. By default it admits only members of your Cloudflare account, so the email in your `Publishers` policy should be one. To let someone sign in another way, such as a one-time code by email, add it under **Zero Trust → Integrations → Identity providers** first.

1. Select **Create**.

## 4. Give the app its two values

The app verifies each login against your team domain, and checks that it was issued for this application.

1. Find your team domain under **Zero Trust → Settings**. It looks like `YOUR_TEAM.cloudflareaccess.com`. It belongs to your Zero Trust organization, not to this application, so every application in your account shares it. It's also where a signed-out visit to `https://newsletter.example.com/dashboard/` now takes you.

1. Find the application's audience tag. Under **Access controls → Applications**, select **Configure** on your application. On the **Additional settings** tab, copy the **Application Audience (AUD) Tag**.

1. Store the team domain as a secret. The command prompts you for the value. Enter the hostname alone, without `https://`. If you paste it with `https://` or a trailing slash, the app drops them. Anything else that isn't a hostname is refused, naming `ACCESS_TEAM_DOMAIN`:

    ```bash
    npx wrangler secret put ACCESS_TEAM_DOMAIN --env production
    ```

1. Store the audience tag the same way:

    ```bash
    npx wrangler secret put ACCESS_AUD --env production
    ```

    A secret takes effect as soon as you store it, with no redeploy. The app needs both values. While only one is stored, it refuses its configuration and names the missing one: the editor says so, `/health` answers `500` with `"variable":"ACCESS_AUD"`, and the public pages say the newsletter is temporarily unavailable. Storing the second clears it.

1. **(Optional, recommended)** Limit the editor to named people. The Access policy decides who can sign in. This list keeps that true if the policy is widened later, for another app or by mistake. Enter a comma-separated list of email addresses at the prompt:

    ```bash
    npx wrangler secret put ACCESS_ALLOWED_EMAILS --env production
    ```

    Without it, the app lets in anyone your Access policy allows.

## 5. Turn on Managed OAuth

**(Optional, recommended)** Managed OAuth lets a program sign in as you, the way the editor does in your browser. `kestrel login` uses it to connect Claude Code, so Claude works as you, and its changes show as yours, via Claude Code. Without it, Claude Code can't sign in, and only a service token reaches the API. Cloudflare marks Managed OAuth as beta, and its [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) page describes it.

1. In **Zero Trust**, go to **Access controls → Applications**, and select **Edit** on your application.

1. On the **Additional settings** tab, select the **OAuth** filter, and find **Managed OAuth (Beta)**.

1. Turn on **Managed OAuth**.

1. Turn on **Allow localhost clients** and **Allow loopback clients**. `kestrel login` receives your approval on your own computer, at a `127.0.0.1` address. Leave **Allowed redirect URIs** empty.

1. Keep the **Access token lifetime** at 15 minutes. A program renews its access token while you use it, so a short lifetime costs nothing.

1. Choose the **Grant session duration**, how long a program's sign-in lasts before you approve it again. It defaults to **Same as session duration**, the session you chose in [section 2](#2-create-the-access-application). Set it to 1 week. Cloudflare recommends one to two weeks for a command-line tool, and a week means Claude Code asks you to approve again once a week, not every day.

1. Save the application.

With Managed OAuth on, a program that asks for a page without signing in gets a `401` that tells it how to sign in, instead of Cloudflare's login page. A browser still gets the login page.

## Check it

1. In a private browser window, open `https://newsletter.example.com/dashboard/`. Cloudflare asks you to sign in.

1. Sign in. The editor loads, and its sidebar shows the email address you signed in with.

1. In the same window, open `https://newsletter.example.com/api/whoami`. It shows you as a signed-in person, verified through Access:

    ```
    {"principal":{"kind":"human","email":"you@example.com"},"auth":{"mode":"access"}}
    ```

1. If you turned on Managed OAuth, a request with no sign-in names where a program signs in:

    ```bash
    curl -si https://newsletter.example.com/api/whoami
    ```

    It answers `401`, and its `www-authenticate` line starts with `Bearer` and names `resource_metadata`. Without Managed OAuth, Cloudflare answers with a redirect to its login page instead.

1. The public pages still need no login:

    ```bash
    curl https://newsletter.example.com/health
    ```

    ```
    {"status":"ok","service":"kestrel"}
    ```

If the editor says the configuration needs a fix, store the secret it names. If Cloudflare lets you in but the editor answers `401`, check the two secrets for a typo, or `ACCESS_ALLOWED_EMAILS` may leave out your address.

Next, [connect Amazon SES](04-ses.md).
