# Configuration

Every deploy-time setting, what it does, and what the app refuses. Public settings are `vars` in the environment's block of `wrangler.jsonc`, safe to commit; secrets are set with `npx wrangler secret put <NAME> --env production` and never committed. None of these can be read or changed from inside the app (`docs/SPEC.md` §9). Settings in the editor shows the public ones read-only.

## Vars

| Var | What it is | Default |
| --- | --- | --- |
| `PROVIDER` | the mail transport: `fake`, `resend`, or `ses` | required |
| `APP_ORIGIN` | the origin the app is served from: scheme and host, no path | required |
| `ARCHIVE_BASE_PATH` | the path the archive index and post pages live under | `/archive` |
| `FROM_ADDRESS` | the `From:` of every email | required with a real provider |
| `SENDING_DOMAIN` | the sending domain, shown in Settings | none |
| `AWS_REGION` | the SES region; Resend ignores it | `us-east-1` in the template |
| `SES_MAX_SEND_RATE` | your SES account's sending rate, in messages a second | `14` |
| `SUBREQUEST_BUDGET` | how many subrequests one minute's send work may use | `50` |
| `MIN_LEAD_SECONDS` | the least time every send stays cancelable before it fires | `300` |
| `ARCHIVE_ORIGIN` | the origin archive links use, to put the archive on your website | `APP_ORIGIN` |
| `MEDIA_PUBLIC_BASE` | the base URL images are served from | `APP_ORIGIN/media` |
| `NOTIFY_FROM` | the sender of notifications on Cloudflare's email | `Kestrel <kestrel@` + the app's hostname `>` |

**`PROVIDER`.** `fake` delivers nothing: it records a send as if every recipient accepted it. It is what development runs, and what a new deployment runs until its provider is connected. Never schedule a real post on it.

**`FROM_ADDRESS` and `SENDING_DOMAIN`.** `FROM_ADDRESS` is the sender: the email's authenticated identity, and the only address mail is sent from. `SENDING_DOMAIN` is informational: Settings shows it beside the From address, and the app never checks that the two match, so set it to the domain part of `FROM_ADDRESS`. Neither is the **publication identity** (the name, tagline, and logo that brand the reader pages and the email), which the publisher sets in the app (`docs/SPEC.md` §9). The From display name stands in for the publication name until that is set.

**`ARCHIVE_BASE_PATH`.** Archive URLs are permanent (I3): every post you send carries its `<base>/<slug>` link forever, so changing the prefix later breaks the links already mailed. Pick it before your first send. If you are migrating an install that already sent `/newsletter/…` links, set it to `/newsletter` to keep them working.

**`SUBREQUEST_BUDGET`.** Cloudflare caps how many subrequests (database queries and outbound requests together) one Worker invocation may make, and caps database queries alone at 1,000. Each minute's send work is one invocation, so a large send goes out over several minutes, each stopping before either cap. This setting is the subrequest cap; the app keeps database queries under 1,000 on its own. The default, 50, is the Workers Free plan's limit and is safe on any plan. On Workers Paid, which allows 10,000, set `"SUBREQUEST_BUDGET": "10000"` so each minute sends far more: Resend goes from about 400 recipients a minute to about 19,000, and SES from about 18 to as fast as your account allows. If you raised the Worker's own limit with `limits.subrequests`, you may set it to that. Never set it above your plan's limit: a minute that hits the cap is cut off mid-batch, and the send stalls until it is picked up again. A value below 30 is raised to 30, the least a minute needs to send anything and still send a notification.

**`MIN_LEAD_SECONDS`.** The minimum lead (`docs/SPEC.md` §6): every send, whether scheduled, sent now, or moved, stays visible and cancelable for at least this long before it fires. It is the window to catch a mistake, including one in a send Claude prepared. The floor is 60, because sends go out from a once-a-minute sweep; the ceiling is 86400 (one day), since it is the least wait before every send, not a limit on how far out one can be scheduled. It is deploy configuration on purpose, so neither the editor nor Claude can shorten it.

**`ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE`.** Leave them unset to keep everything on the app's own hostname. **Put the archive on your website** says when and how to set them.

## Secrets

| Secret | What it is | Needed for |
| --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | your Zero Trust team domain, such as `your-team.cloudflareaccess.com` | every deployment |
| `ACCESS_AUD` | the Access application's audience tag | every deployment |
| `ACCESS_ALLOWED_EMAILS` | a comma-separated list of the people allowed to log in | optional |
| `RESEND_API_KEY` | the Resend API key | Resend |
| `RESEND_WEBHOOK_SECRET` | the Resend webhook's signing secret | Resend |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | the IAM user's key pair | SES |
| `SNS_TOPIC_ARN` | the SNS topic the SES webhook accepts; every other topic is refused | SES |
| `SES_CONFIGURATION_SET` | the configuration set that publishes bounces and complaints | SES (optional to the app, but without it no events arrive) |

Never set `DEV_AUTH_SECRET` on a deployed environment. It is local development's stand-in for Access, and **How the admin gate works** explains why a deployed instance ignores it anyway.

## What the app refuses

The app checks its configuration on every request and refuses to run on one that would do the wrong thing quietly:

- `PROVIDER` must be exactly `fake`, `resend`, or `ses`. A misspelling, or `SES`, is refused, never taken for the fake.
- `APP_ORIGIN` must be a plain `http(s)` origin. `ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE`, when set, must be valid `http(s)` URLs. A trailing slash is dropped, so it is harmless.
- A real provider needs `FROM_ADDRESS` and every secret the table above marks for it.
- With a real provider, none of `APP_ORIGIN`, `ARCHIVE_ORIGIN`, `MEDIA_PUBLIC_BASE`, `SENDING_DOMAIN`, or `FROM_ADDRESS` may still be on `example.com`, the template's placeholder.
- A number (`SUBREQUEST_BUDGET`, `MIN_LEAD_SECONDS`, `SES_MAX_SEND_RATE`) must be a whole number above zero, and `MIN_LEAD_SECONDS` within its bounds. It is refused, never clamped.

Until each is fixed, every request answers `500` with a body naming the variable, such as `{"error":"invalid_config","variable":"APP_ORIGIN",…}`, the Worker log records it once, and no sends go out. The editor's page still loads, since it is a static file, but everything it asks the API for fails the same way.
