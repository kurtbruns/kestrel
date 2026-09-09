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
| `ARCHIVE_BASE_PATH` | path prefix for issue pages (drives the URL *and* the route) | `/newsletter` |
| `SENDING_DOMAIN` | the sending identity domain | `news.example.com` |
| `FROM_ADDRESS` | the `From:` header; its display name also names the publication | `Newsletter <newsletter@news.example.com>` |
| `AWS_REGION` | SES region (ignored by Resend) | `us-east-1` |

`ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE` are **optional** — leave them unset to stay self-contained (archives and images serve on `APP_ORIGIN`). They are the opt-in enhancements covered in "Wire the archive to a website."

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

At this point the Worker is live but **not yet gated** and **cannot send email**. Do not point real subscribers at it until you have completed "Access" and "Connect an email sender." Continue with Access next.
