# Provision the instance

Stand up the Cloudflare resources the Worker binds to, fill their ids into `wrangler.jsonc`, run the migrations, and deploy. Do the whole sequence for **staging** first, prove it, then repeat for **production**.

Rationale for the platform choice (Worker + D1 + R2 + Cron) is in `docs/SPEC.md` — deployment appendix.

## Prerequisites

- A Cloudflare account.
- Node 22+ and this repo cloned, with `npm install` run.
- `npx wrangler login` (authenticates the CLI against your account).
- If you work from a fork, set `repository.url` in `package.json` to your fork and commit it. The editor and `GET /api/version` link the running build to its commit and release through that field, and a fork inherits the upstream URL, so the links would otherwise open the upstream project. Delete the field to drop the links instead.

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
| `PROVIDER` | active transport: `fake`, `ses`, or `resend` | `fake` for now; `resend` or `ses` once you connect a sender |
| `APP_ORIGIN` | the origin the app is served from (scheme and host, no path) | `https://newsletter.example.com` |
| `ARCHIVE_BASE_PATH` | path prefix for the archive index + post pages (drives the URL *and* the route) | `/archive` |
| `SENDING_DOMAIN` | the sending identity's domain, shown in Settings | `send.example.com` |
| `FROM_ADDRESS` | the `From:` header | `Newsletter <newsletter@send.example.com>` |
| `AWS_REGION` | SES region (ignored by Resend) | `us-east-1` |

`FROM_ADDRESS` is the **sender**: the email's authenticated identity, fixed here at deploy time. It is the only value mail is sent from. `SENDING_DOMAIN` is informational: Settings shows it beside the From address, and with a real provider the app checks only that it is not left on `example.com`, never that it matches `FROM_ADDRESS`. Set it to the domain part of `FROM_ADDRESS` so the two never disagree. That is a separate thing from the **publication identity** (the name, tagline, and logo that theme the reader surface and ride inside the email), which is a runtime preference the publisher sets in the app, not a deploy-time var (`docs/SPEC.md` §9). The From display name only stands in for the publication name until that preference is set.

Set `PROVIDER` to `fake` in each environment for now, even though the template says `ses`. A real provider refuses to run until its secrets are set, and those come later, in **Connect an email sender**, which switches `PROVIDER` over; until then, `fake` lets you deploy and verify Access in between. The `fake` transport delivers nothing: it records a send as if every recipient accepted it, so do not schedule a real post before switching.

The app checks this configuration on every request and refuses to run on one that would do the wrong thing quietly. `PROVIDER` must be exactly `fake`, `ses`, or `resend` (a misspelling or `SES` is refused, never taken for the fake). `APP_ORIGIN` must be set and be a plain `http(s)` origin, and `ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE`, when set, must be valid `http(s)` URLs. A real provider needs every credential its section of **Connect an email sender** lists as required, plus `FROM_ADDRESS`, and none of `APP_ORIGIN`, `ARCHIVE_ORIGIN`, `MEDIA_PUBLIC_BASE`, `SENDING_DOMAIN`, or `FROM_ADDRESS` may still be on `example.com`, the template's placeholder. Until each is fixed, every request the Worker handles answers `500` with a body naming the variable, for example `{"error":"invalid_config","variable":"APP_ORIGIN",…}`, the Worker log records it (once per running instance, not per request), and the send sweep does nothing. The editor's page itself still loads, since it is a static asset, but everything it asks the API for fails the same way. A trailing slash on an origin is dropped, so it is harmless.

`ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE` are **optional** — leave them unset to stay self-contained (archives and images serve on `APP_ORIGIN`). They are the opt-in enhancements covered in "Wire the archive to a website."

`SUBREQUEST_BUDGET` is **optional** too. Cloudflare caps how many subrequests (D1 queries and outbound requests together) one Worker invocation may make, and caps D1 queries alone at 1,000 besides. Each minute's send sweep is one invocation, so a large send is delivered over several ticks, each stopping before either cap. `SUBREQUEST_BUDGET` is the subrequest cap; the app holds D1 queries to 1,000 on its own. Unset, it is 50, the Workers Free plan's limit, which is correct on any plan. On Workers Paid, which allows 10,000 subrequests per invocation, set `"SUBREQUEST_BUDGET": "10000"` in that environment's `vars` so each tick delivers far more (see **Connect an email sender** for how much). If you raised the Worker's own limit with `limits.subrequests`, you may set it to that. Never set it above your plan's limit: a tick that hits the cap is cut off mid-batch, and the send stalls until its lease expires. A value below 30 is raised to 30, the least a tick needs to deliver anything and still send a notification (see **Notifications**); a value that is not a whole number above zero is refused like the settings above.

`MIN_LEAD_SECONDS` is **optional** as well. It is the **minimum lead** (`docs/SPEC.md` §6): every send, whether scheduled, sent now, or moved, stays visible and cancelable for at least this long before it fires, which is the window to catch a mistake, including one in a send Claude prepared. Unset, it is 300 (five minutes). The floor is 60 in every environment, because the send sweep runs once a minute and cannot promise a shorter window, and the ceiling is 86400 (one day), since the lead is the least wait before every send, not a limit on how far out one can be scheduled; a value outside those bounds, or one that is not a whole number, is refused like the settings above rather than clamped. It is deploy configuration on purpose: Settings shows it read-only, and nothing in the admin API can change it, so neither the editor nor Claude can shorten the window. Set it in that environment's `vars`, for example `"MIN_LEAD_SECONDS": "600"` for a ten-minute window.

> **Pick `ARCHIVE_BASE_PATH` before your first send.** Archive URLs are permanent (I3): every post you send carries its `<base>/<slug>` link forever. Changing the prefix later orphans the links already mailed under the old one. The default is `/archive`; if you are migrating an install that already sent `/newsletter/…` links, set `ARCHIVE_BASE_PATH=/newsletter` to keep them alive.

After editing `wrangler.jsonc`, regenerate the binding types and typecheck:

```bash
npm run typecheck
```

## 3. Apply the schema

`migrate:remote` applies `migrations/` to an environment's **remote** D1. It refuses to run without `--env`, since the top-level config is development:

```bash
npm run migrate:remote -- --env staging
npm run migrate:remote -- --env production
```

It applies only the migrations that database has not seen yet, so running it again is harmless. Deploying never applies migrations: whenever the schema changes, run this yourself before the deploy that needs it. **Upgrade to a new release** covers that, including the case where a 0.x release changes the baseline migration in place and the database has to be rebuilt instead.

## 4. Deploy

`npm run deploy` stamps the build, then deploys. Like `migrate:remote`, it refuses to run without `--env`:

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

At this point the Worker is live, but its admin surface is **closed** and it **cannot send email**. Until Access is configured, the app has no way to verify who is asking, so every admin route (the editor's API calls, the authoring API, `/api/whoami`) answers `401`: the editor's page loads but can do nothing. The reader surface is already public. With `PROVIDER` on `fake`, a send is recorded but reaches no one. (Deployed with `PROVIDER` on `ses` or `resend` before that provider's secrets are set, it instead answers every request with a `500` naming the first missing secret.) Do not point real subscribers at it until you have completed "Access" and "Connect an email sender." Continue with Access next.
