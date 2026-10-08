# Configuration

Every deploy-time setting: what it does, its default, and what the app refuses. Each environment's settings live in its block under `env` in `wrangler.jsonc`, and its secrets in Cloudflare.

- **Vars** are public values in the block's `vars`, safe to commit.
- **Secrets** are stored with `npx wrangler secret put NAME --env production`, and never committed. A secret takes effect as soon as you store it, with no redeploy.
- **Bindings and triggers** connect the Worker to its database, its image bucket, and its schedule.

None of these can be read or changed from inside the app, by the editor or by Claude. Settings in the editor shows the public ones, read-only.

## Vars

| Var | What it is | Default |
| --- | --- | --- |
| `PROVIDER` | the email provider: `fake`, `resend`, or `ses` | required |
| `APP_ORIGIN` | the origin the app is served from: scheme and host, no path | required |
| `ARCHIVE_BASE_PATH` | the path the archive lives under | `/archive` |
| `FROM_ADDRESS` | the `From:` of every email | required with a real provider |
| `SENDING_DOMAIN` | the sending domain, shown in Settings | none |
| `AWS_REGION` | the SES region; Resend ignores it | `us-east-1` in the template, required with SES |
| `SES_MAX_SEND_RATE` | your SES account's maximum send rate, in messages a second | `14` |
| `SUBREQUEST_BUDGET` | how many subrequests one minute's send work may use | `50` |
| `MIN_LEAD_SECONDS` | the least time every send stays cancelable before it goes out | `300` |
| `ARCHIVE_ORIGIN` | the origin archive links use, to put the archive on your website | `APP_ORIGIN` |
| `MEDIA_PUBLIC_BASE` | the base URL images are served from | `APP_ORIGIN` + `/media` |
| `NOTIFY_FROM` | the sender of notifications through Cloudflare's email | `Kestrel <kestrel@` + the app's hostname + `>` |

### `PROVIDER`

`fake` delivers nothing. It records a send as if every recipient accepted it. Local development runs on it, and so does a new deployment until its provider is connected. Never schedule a real post on it.

### `FROM_ADDRESS` and `SENDING_DOMAIN`

`FROM_ADDRESS` is the only address mail is sent from, and the identity your provider authenticates. `SENDING_DOMAIN` is for display: Settings shows it beside the From address. The app never checks that the two match, so set `SENDING_DOMAIN` to the part of `FROM_ADDRESS` after the `@`.

Neither one is your publication's name, tagline, or logo. You set those in the editor, under **Settings → Publication identity**. Until you do, the From address's display name stands in for the name.

### `ARCHIVE_BASE_PATH`

Every post you send carries its archive link, `ARCHIVE_BASE_PATH` followed by the post's slug, and those links are permanent. Changing the prefix later breaks every link already mailed, so pick it before your first send. To keep links from an older install working, set it to the prefix they use, such as `/newsletter`.

A missing leading slash is added, and a trailing slash is dropped.

### `SES_MAX_SEND_RATE`

The app starts SES requests no faster than this rate. Set it to the maximum send rate on your SES **Account dashboard**. That's `1` in the sandbox, and whatever AWS grants after that. The default, 14, is a common starting rate, not your account's.

A rate set too high only means SES throttles some requests. Those recipients wait for the next minute, and no one is mailed twice.

### `SUBREQUEST_BUDGET`

Cloudflare caps how many subrequests one run of a Worker may make. Database queries and outbound requests both count. It also caps database queries alone: 50 a run on Workers Free, and 1,000 on Workers Paid. Each minute's send work is one run, so a large send goes out over several minutes, each stopping short of both caps.

This setting is the subrequest cap. The app keeps database queries under theirs on its own.

- **The default, 50,** is the Workers Free limit, and safe on any plan. Through Resend, a minute sends about 400 recipients. Through SES, which takes one recipient a request, it sends about 18.
- **On Workers Paid,** which allows 10,000, set `"SUBREQUEST_BUDGET": "10000"`. Resend then sends about 19,000 recipients a minute. SES sends as fast as your account's rate allows, up to about 1,900.
- **If you raised the Worker's own limit** with `limits.subrequests`, you may set this to match.

Never set it above your plan's limit. A minute that hits the cap is cut off mid-batch, and the send stalls until a later minute picks it up. A value below 30 is raised to 30, the least a minute needs to send anything and still send a notification.

### `MIN_LEAD_SECONDS`

Every send stays visible and cancelable for at least this long before it goes out, whether it's scheduled, sent now, or moved. It's the window to catch a mistake, including one in a send Claude prepared.

The floor is 60, since sends go out from a once-a-minute schedule. The ceiling is 86400, one day. It's the least wait before every send, not a limit on how far ahead you can schedule. It lives in deploy config on purpose, so neither the editor nor Claude can shorten it.

### `ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE`

Leave them unset to keep everything on the app's own hostname.

`ARCHIVE_ORIGIN` points archive links at another origin, such as your website, `https://example.com`. The app doesn't answer there on its own. A Worker route on that domain, such as `example.com/archive*` in the environment's `routes`, sends the archive path to the app. Links already mailed keep working, since the app still answers on its own hostname.

`MEDIA_PUBLIC_BASE` serves images from another base URL, such as a custom domain on the image bucket. The app's own `/media` path sends `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` with every file, so a file in the bucket never runs as a page. A bucket's custom domain sends neither, so add both with a Response Header Transform Rule on that hostname.

### `NOTIFY_FROM`

Used only with the `NOTIFY` binding. It must be an address on a domain set up for Cloudflare's email. Without the binding, notifications come from `FROM_ADDRESS`, through your email provider.

## Secrets

| Secret | What it is | Needed for |
| --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | your Zero Trust team domain, such as `your-team.cloudflareaccess.com` | every deployment |
| `ACCESS_AUD` | the Access application's audience tag | every deployment |
| `ACCESS_ALLOWED_EMAILS` | a comma-separated list of the people allowed to sign in | optional |
| `RESEND_API_KEY` | the Resend API key | Resend |
| `RESEND_WEBHOOK_SECRET` | the Resend webhook's signing secret | Resend |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | the IAM user's access key | SES |
| `SNS_TOPIC_ARN` | the SNS topic the SES webhook accepts; it refuses every other topic | SES |
| `SES_CONFIGURATION_SET` | the configuration set named on every email, so SES reports bounces and complaints | SES, recommended |

`ACCESS_ALLOWED_EMAILS` applies to people only. A service token, such as the one Claude uses, carries no email, so the Access policy alone decides whether it gets in.

Never set `DEV_AUTH_SECRET` on a deployed environment. It's local development's stand-in for Access, and a deployed instance ignores it anyway. [How the admin gate works](03-admin-gate.md) explains why.

## Bindings and triggers

Wrangler doesn't carry bindings or vars over from the top level of `wrangler.jsonc` to an environment. Each environment's block declares its own.

| Setting | What it is | Default |
| --- | --- | --- |
| `name` | the Worker's name, such as `kestrel-production` | required |
| `routes` | the app's hostname, attached on deploy, and any route on your website | required |
| `workers_dev`, `preview_urls` | the Worker's `workers.dev` and preview addresses | `false` in the template |
| `triggers.crons` | the once-a-minute schedule, `* * * * *` | required |
| `observability` | Workers Logs, where the app's log lines land | on |
| `d1_databases`, binding `DB` | the database: posts, subscribers, sends, and settings | required |
| `r2_buckets`, binding `MEDIA` | the bucket for images and your logo | required |
| `send_email`, binding `NOTIFY` | Cloudflare's email, for notifications | none |

### `routes`, `workers_dev`, and `preview_urls`

The template turns off the `workers.dev` addresses, so the app answers only on your hostname. That's where your Access application and any rate-limiting rule apply. Each deploy replaces the Worker's routes with the ones in the file, so add a route here, never in the dashboard.

### `triggers.crons`

The schedule runs every minute. It sends whatever is due, and the notifications about it. Without it, nothing scheduled ever goes out.

### `observability`

Every invocation is logged, with no sampling. Sampling could drop the one minute that reports a stuck or missed send.

### `NOTIFY`

When declared, notifications go through Cloudflare's email instead of your provider, so they still arrive when your provider refuses your account. Local development ignores it, and sends notifications to a stand-in that delivers nothing.

## What the app refuses

The app checks its configuration on every request. It refuses to run on one that would do the wrong thing quietly:

- `PROVIDER` must be exactly `fake`, `resend`, or `ses`. A misspelling, or `SES`, is refused, never taken for `fake`.
- `APP_ORIGIN` must be a plain `http` or `https` origin, with no path. So must `ARCHIVE_ORIGIN`, when set. `MEDIA_PUBLIC_BASE`, when set, must be a plain `http` or `https` URL, and may have a path. A trailing slash is dropped from each.
- A real provider needs `FROM_ADDRESS`, and every secret the table marks for it. SES also needs `AWS_REGION`.
- With a real provider, none of `APP_ORIGIN`, `ARCHIVE_ORIGIN`, `MEDIA_PUBLIC_BASE`, `SENDING_DOMAIN`, or `FROM_ADDRESS` may still be on `example.com`, the template's placeholder.
- `SUBREQUEST_BUDGET`, `MIN_LEAD_SECONDS`, and `SES_MAX_SEND_RATE` must be whole numbers above zero. `MIN_LEAD_SECONDS` must also be within its bounds. Any other value is refused, never adjusted. The one exception is a `SUBREQUEST_BUDGET` below 30, which is raised to 30.

Until it's fixed, every request answers `500` with a body naming the variable, such as `{"error":"invalid_config","variable":"APP_ORIGIN",…}`. The Worker's log records it, and no sends go out. The editor's page still loads, since it's a static file, but everything it asks the API for fails the same way.
