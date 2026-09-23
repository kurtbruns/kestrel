# Provision the instance

Stand up the Cloudflare resources the Worker binds to, fill their ids into `wrangler.jsonc`, run the migrations, and deploy. Do the whole sequence for **staging** first, prove it, then repeat for **production**.

Rationale for the platform choice (Worker + D1 + R2 + Cron) is in `docs/SPEC.md` — deployment appendix.

## Prerequisites

- A Cloudflare account.
- Node 20+ and this repo cloned, with `npm install` run.
- `npx wrangler login` (authenticates the CLI against your account).

## 1. Create the database, bucket, and their bindings

The Worker binds a D1 database as `DB` and an R2 bucket as `MEDIA`. Create one of each **per deployed environment** (staging and production are fully separate — separate data, separate blast radius):

```bash
# D1 — note the printed database_id for the next step
npx wrangler d1 create kestrel-staging
npx wrangler d1 create kestrel-production

# R2
npx wrangler r2 bucket create kestrel-media-staging
npx wrangler r2 bucket create kestrel-media-production
```

`wrangler d1 create` prints a `database_id`. Copy it.

## 2. Fill in `wrangler.jsonc`

The top-level config is the **development** environment (the `fake` transport, so dev can never reach a real inbox). The `staging` and `production` entries under `env` **redeclare** their own bindings and vars — wrangler does not inherit them. Replace the placeholder D1 ids:

```jsonc
"env": {
  "staging": {
    "d1_databases": [
      {
        "binding": "DB",
        "database_name": "kestrel-staging",
        "database_id": "REPLACE_WITH_STAGING_D1_ID",   // ← paste from step 1
        "migrations_dir": "migrations"
      }
    ],
    // ...
  },
  "production": {
    "d1_databases": [
      {
        "binding": "DB",
        "database_name": "kestrel-production",
        "database_id": "REPLACE_WITH_PRODUCTION_D1_ID", // ← paste from step 1
        "migrations_dir": "migrations"
      }
    ]
    // ...
  }
}
```

The R2 `bucket_name`s already match the names created in step 1; change them only if you named your buckets differently.

While you are here, set each environment's public `vars` (these are **not** secrets — they are safe to commit):

| Var | What it is | Example |
| --- | --- | --- |
| `PROVIDER` | active transport: `fake`, `ses`, or `resend` | `ses` |
| `APP_ORIGIN` | the origin the app is served from | `https://newsletter.example.com` |
| `ARCHIVE_BASE_PATH` | path prefix for the archive index + post pages (drives the URL *and* the route) | `/archive` |
| `SENDING_DOMAIN` | the sending identity's domain | `send.example.com` |
| `FROM_ADDRESS` | the `From:` header | `Newsletter <newsletter@send.example.com>` |
| `AWS_REGION` | SES region (ignored by Resend) | `us-east-1` |

`SENDING_DOMAIN` and `FROM_ADDRESS` are the **sender** — the email's authenticated identity, fixed here at deploy time. That is a separate thing from the **publication identity** (the name, tagline, and logo that theme the reader surface and ride inside the email), which is a runtime preference the publisher sets in the app, not a deploy-time var (`docs/SPEC.md` §9). The From display name only stands in for the publication name until that preference is set.

`ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE` are **optional** — leave them unset to stay self-contained (archives and images serve on `APP_ORIGIN`). They are the opt-in enhancements covered in "Wire the archive to a website."

`SUBREQUEST_BUDGET` is **optional** too. Cloudflare caps how many D1 queries and outbound requests one Worker invocation may make, and each minute's send sweep is one invocation, so a large send is delivered over several ticks, each stopping before the cap. Unset, the budget is 50, the Workers Free plan's limit, which is correct on any plan. On Workers Paid, which allows 1,000 D1 queries per invocation, set `"SUBREQUEST_BUDGET": "1000"` in that environment's `vars` so each tick delivers about twenty times as much. Never set it above your plan's limit: a tick that hits the cap is cut off mid-batch, and the send stalls until its lease expires. A value below 30 is raised to 30, the least a tick needs to deliver anything and still send a notification (see **Notifications**).

> **Pick `ARCHIVE_BASE_PATH` before your first send.** Archive URLs are permanent (I3): every post you send carries its `<base>/<slug>` link forever. Changing the prefix later orphans the links already mailed under the old one. The default is `/archive`; if you are migrating an install that already sent `/newsletter/…` links, set `ARCHIVE_BASE_PATH=/newsletter` to keep them alive.

After editing `wrangler.jsonc`, regenerate the binding types and typecheck:

```bash
npm run typecheck
```

## 3. Apply the schema

`migrate:remote` applies `migrations/` to the **remote** D1 for the default (development) environment. To target a named environment, pass it through to wrangler:

```bash
npx wrangler d1 migrations apply DB --remote --env staging
npx wrangler d1 migrations apply DB --remote --env production
```

`migrations/` is append-only — every deploy re-applies only the migrations the target database has not seen yet, so it is safe to run repeatedly.

## 4. Deploy

```bash
npm run deploy -- --env staging
# then, once staging is proven end to end:
npm run deploy -- --env production
```

The Cron Trigger that drives the send sweep (`"crons": ["* * * * *"]`, once a minute) is declared per environment in `wrangler.jsonc` and is registered automatically on deploy — there is nothing extra to create. Confirm it after the first deploy under the Worker's **Triggers** tab in the Cloudflare dashboard.

## 5. Rate-limit the subscribe form

The subscribe form is public, so bound how often one client can submit it. The app already sends each address at most one confirmation in any 15 minutes and answers every address the same way (`docs/SPEC.md` §7); the per-client limit is the edge's job, so there is nothing in the app to configure for it.

In the Cloudflare dashboard, open the zone for `newsletter.example.com` → **Security rules** → **Create rule** → **Rate limiting rules**:

- **If incoming requests match:** a custom expression on the path,

  ```
  (http.request.uri.path eq "/subscribe")
  ```

  On the Free and Pro plans a rate-limiting rule can match only on the path, so this also counts loads of the form page, which is harmless at this rate. On Business and above you can narrow it to submissions with `and http.request.method eq "POST"`.
- **With the same characteristics:** IP.
- **When rate exceeds:** 5 requests per 10 seconds. That is the Free plan's only period; on a paid plan a longer one fits the form better, such as 10 requests per minute.
- **Then take action:** Block, for the shortest duration the plan offers (10 seconds on Free).

The Free plan allows one rate-limiting rule, and this is the one to spend it on.

The rule applies only on the zone's own hostname. A Worker also answers on its `*.workers.dev` address unless that is turned off, and a request there skips the rule. Once the custom domain serves the app, turn the `workers.dev` route off in the Worker's **Settings** → **Domains & Routes** (or set `"workers_dev": false` in that environment in `wrangler.jsonc`).

To check it, submit the form rapidly from one machine: after the limit, Cloudflare answers with its own block page instead of the app's.

At this point the Worker is live but **not yet gated** and **cannot send email**. Do not point real subscribers at it until you have completed "Access" and "Connect an email sender." Continue with Access next.
