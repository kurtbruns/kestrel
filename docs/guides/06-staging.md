# Add a staging environment

A staging environment is a second deployed copy of Kestrel, with its own database, bucket, hostname, and login, for rehearsing a change before production: a feature you are building, or a new release. A new instance doesn't need one. Its list starts empty, so **Verify it works** proves production itself before anyone else is on it (`docs/SPEC.md` §11).

## The one rule

Staging must never be able to mail a stranger. Give it a provider account still in its **sandbox** (SES), or a **test domain**, and send only to addresses you own. Real subscribers belong to production only.

## Set it up

1. In `wrangler.jsonc`, copy the `production` block under `env` as `staging`. Give it its own `name` (such as `kestrel-staging`), its own hostname in `routes` and `APP_ORIGIN` (such as `newsletter-staging.example.com`), and its own database and bucket names. Wrangler does not inherit anything between environments, so the copy must declare every binding and var itself.
2. Follow **Deploy the app**, **Lock the dashboard with Access**, and your provider's step with `--env staging` in place of `--env production`, and the staging names in place of the production ones. Staging needs its own Access application, on its own hostname.
3. Run **Verify it works** against staging.

## Using it

To try an upgrade, follow **Upgrade to a new release** on staging first, with `--env staging`, check it, then repeat it for production. To try a feature, deploy your branch to staging with `npm run deploy -- --env staging`.
