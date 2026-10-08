# Add a staging environment

A staging environment is a second deployed copy of Kestrel, with its own database, image bucket, hostname, and login. Use it to try a change or a new release before it reaches production. A new instance doesn't need one: its list starts empty, so [Verify it works](../get-started/05-verify.md) tests production itself.

In this guide, you add a staging environment to `wrangler.jsonc`, with its own database and bucket, and deploy it. Then you lock the whole staging hostname behind Access, so no one else can reach it. Last, you connect your email provider with a key of its own.

## Before you begin

You need:

- Production set up, from [Get started](../get-started/01-overview.md).
- A hostname for staging. These steps use `newsletter-staging.example.com`.

Staging should only ever mail you. Its list holds only the addresses you add, and section 3 keeps strangers from reaching its subscribe page. Never copy production's subscribers into it.

## 1. Create the database and the image bucket

1. Create the database:

    ```bash
    npx wrangler d1 create kestrel-staging
    ```

    Copy the `database_id` it prints. If Wrangler offers to add the database to your configuration, decline.

1. Create the bucket for images:

    ```bash
    npx wrangler r2 bucket create kestrel-media-staging
    ```

## 2. Add the environment and deploy it

Wrangler doesn't share settings between environments. The staging block has to declare everything the production block does, so you start from a copy of it.

1. In `wrangler.jsonc`, copy the whole `production` block under `env`, and paste it beside it as `staging`.

1. In the copy, change the values marked here:

    ```jsonc
    "staging": {
      "name": "kestrel-staging", // ← its own Worker
      "routes": [{ "pattern": "newsletter-staging.example.com", "custom_domain": true }], // ← its own hostname
      // …
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "kestrel-staging",
          "database_id": "REPLACE_WITH_STAGING_D1_ID", // ← the id from section 1
          "migrations_dir": "migrations"
        }
      ],
      "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "kestrel-media-staging" }],
      "vars": {
        "PROVIDER": "fake",                                 // ← until section 4
        "APP_ORIGIN": "https://newsletter-staging.example.com",
        // … the rest as in production
      }
    }
    ```

    Leave out any `ARCHIVE_ORIGIN` or `MEDIA_PUBLIC_BASE` you set for production, so staging's links stay on its own hostname. Leave out a route on your website, too.

1. Check the file:

    ```bash
    npm run typecheck
    ```

1. Commit the change, and push it:

    ```bash
    git commit -am "Add a staging environment"
    git push
    ```

1. Apply the schema to staging's database:

    ```bash
    npm run migrate:remote -- --env staging
    ```

1. Deploy:

    ```bash
    npm run deploy -- --env staging
    ```

## 3. Lock all of staging with Access

Production keeps its public pages public. Staging locks all of them, so a stranger who finds its hostname can't subscribe. Only your email provider's webhook stays open, so bounces and complaints still arrive.

1. In **Zero Trust**, go to **Access controls → Applications**, and create a **Self-hosted and private** application as in [Lock the dashboard with Access](../get-started/03-access.md#2-create-the-access-application). Give it one public hostname, with no path:

    - **Subdomain:** `newsletter-staging`
    - **Domain:** `example.com`

1. Add the same `Publishers` policy you made for production, and create the application.

1. Create a second application for the webhook, with this public hostname:

    - **Subdomain:** `newsletter-staging`
    - **Domain:** `example.com`
    - **Path:** `webhooks`

    Give it a policy with the **Bypass** action that includes **Everyone**. The more specific path wins, so the webhook skips the login.

1. Store your team domain for staging. It's the same one production uses:

    ```bash
    npx wrangler secret put ACCESS_TEAM_DOMAIN --env staging
    ```

1. Store the audience tag of the first staging application, the one with no path:

    ```bash
    npx wrangler secret put ACCESS_AUD --env staging
    ```

1. **(Optional, recommended)** Limit staging's editor to named people, as for production:

    ```bash
    npx wrangler secret put ACCESS_ALLOWED_EMAILS --env staging
    ```

## 4. Connect your email provider

Staging uses the same provider account as production, with a key of its own. You can then revoke staging's key without touching production. Staging sends from the same address as production.

**With Resend,** follow [Connect Resend](../get-started/04-resend.md#3-create-an-api-key) from section 3 on, with these changes:

- Name the API key `kestrel-staging`.
- Point the webhook at `https://newsletter-staging.example.com/webhooks/resend`.
- Add `--env staging` to each `wrangler secret put`, and to the deploy.
- Change `PROVIDER` in the `staging` block, not in `production`.

**With Amazon SES,** follow [Use Amazon SES instead of Resend](02-ses.md#5-send-bounces-and-complaints-to-sns) from section 5 on, with these changes:

- Create a configuration set and an SNS topic named `kestrel-staging`, so staging's events never reach production. Don't make this set your hostname's default. The app names it on every email it sends.
- Create an IAM user named `kestrel-staging`.
- Add `--env staging` to each `wrangler secret put`, and to the deploy.
- Change the vars in the `staging` block, not in `production`.
- Subscribe `https://newsletter-staging.example.com/webhooks/ses` to the staging topic.

Your provider may report some of staging's events to production's webhook, and the other way round. A hard bounce or complaint then suppresses that address in both. Since staging mails only you, that's at most one of your own addresses.

## Check it

1. Staging answers on its hostname. The health check is behind the login now, so this asks for the webhook instead:

    ```bash
    curl -s -o /dev/null -w "%{http_code}\n" -X POST https://newsletter-staging.example.com/webhooks/resend
    ```

    ```
    400
    ```

    With SES, use `/webhooks/ses`. Any other answer, such as a redirect to your Cloudflare login, means the Bypass application doesn't cover the webhook.

1. The public pages are locked. In a private browser window, `https://newsletter-staging.example.com/subscribe` asks you to sign in.

1. Sign in, and open `https://newsletter-staging.example.com/dashboard/`. **Settings → Email sender** shows your provider.

1. Run [Verify it works](../get-started/05-verify.md) against staging, with `newsletter-staging.example.com` in place of your production hostname.

## Use it

- **To try a change,** deploy your branch to staging:

    ```bash
    npm run deploy -- --env staging
    ```

- **To try a new release,** follow [Upgrade to a new release](07-upgrade.md) with `--env staging` first. When staging checks out, repeat it with `--env production`.

A deploy ships whatever you have checked out, so deploy production only from your main branch.
