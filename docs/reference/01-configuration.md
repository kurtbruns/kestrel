# Configuration

Every deploy-time setting: what it does, its default, and what the app refuses. Each environment's settings live in its block under `env` in `wrangler.jsonc`, and its secrets in Cloudflare.

- **Vars** are public values in the block's `vars`, safe to commit. A change takes effect when you deploy.
- **Secrets** are stored with `npx wrangler secret put NAME --env production`, and never committed. A secret takes effect as soon as you store it, with no redeploy.
- **Bindings and triggers** connect the Worker to its database, its image bucket, and its schedule.

In local development, `npm run dev` reads the top level of `wrangler.jsonc` and `.dev.vars`, which you copy from `.dev.vars.example`. Restart it after you change either.

None of these can be read or changed from inside the app, by the editor or by Claude. Settings in the editor shows the public ones, read-only.

## Vars

| Var | What it is | Default |
| --- | --- | --- |
| `PROVIDER` | the email provider: `ses`, or `fake` for local development | none: no provider connected |
| `APP_ORIGIN` | the origin the app is served from: scheme and host, no path | required |
| `ARCHIVE_BASE_PATH` | the path the archive lives under | `/archive` |
| `FROM_ADDRESS` | the `From:` of every email | required with a real provider |
| `SENDING_DOMAIN` | the sending domain, shown in Settings | none |
| `AWS_REGION` | the SES region | `us-east-1` in the template, required with SES |
| `SES_MAX_SEND_RATE` | your SES account's maximum send rate, in messages a second | `14` |
| `SUBREQUEST_BUDGET` | how many subrequests one minute's send work may use | `50` |
| `MIN_LEAD_SECONDS` | the least time every send stays cancelable before it goes out | `300` |
| `ARCHIVE_ORIGIN` | the origin archive links use, to put the archive on your website | `APP_ORIGIN` |
| `MEDIA_PUBLIC_BASE` | the base URL images are served from | `APP_ORIGIN` + `/media` |
| `NOTIFY_FROM` | the sender of notifications through Cloudflare's email | `Kestrel <kestrel@` + the app's hostname + `>` |
| `ALLOW_FAKE_PROVIDER` | `true` lets `fake` run on a real hostname, for a demo that mails no one on purpose | unset |

### `PROVIDER`

Until it's set, or while it's empty, the app runs with no provider connected. Posts can be written and previewed, but everything that would send email is refused: scheduling, sending now, test emails, and the confirmation emails that signups need. The subscribe page says signups aren't open yet, and Settings shows **No email provider connected**. Setting it to `none` means the same. A new instance's `production` block declares it empty, `"PROVIDER": ""`, so wrangler doesn't warn that the top level's value is missing there. [Connect Amazon SES](../get-started/04-ses.md) changes it to `ses`.

`fake` delivers nothing. It records a send as if every recipient accepted it. Local development runs on it, and names it on purpose in the top level of `wrangler.jsonc`. Never copy it into `production`, whatever wrangler suggests: every subscriber would be recorded as sent the post, and never get it. The app refuses `fake` unless `APP_ORIGIN` is on `localhost` or `127.0.0.1`. A hosted demo that runs `fake` on a real hostname on purpose sets `ALLOW_FAKE_PROVIDER` to `true`, which no other deployment needs, and which no other provider reads.

### `FROM_ADDRESS` and `SENDING_DOMAIN`

`FROM_ADDRESS` is the only address mail is sent from, and the identity your provider authenticates. `SENDING_DOMAIN` is for display: Settings shows it beside the From address. The app never checks that the two match, so set `SENDING_DOMAIN` to the part of `FROM_ADDRESS` after the `@`.

Neither one is the publication's name, tagline, or logo. You set those in the editor, under **Settings → Publication identity**. Until you do, the From address's display name stands in for the name, and with neither, the emails and reader pages show no name at all.

### `ARCHIVE_BASE_PATH`

A listed post's archive address is `ARCHIVE_BASE_PATH` followed by the post's slug. Emails link through each post's unlisted link, `/email/<token>` on `APP_ORIGIN`, which forwards to the archive address, so changing the prefix later breaks no email that carries one, only archive addresses people have shared. Emails sent by 1.11 or earlier carry the archive address itself, and changing the prefix breaks those. To keep links from an older install working, set it to the prefix they use, such as `/newsletter`.

A missing leading slash is added, and a trailing slash is dropped.

### `SES_MAX_SEND_RATE`

The app sends SES one request a second, the most SES takes, and each request carries one second of this rate, up to 50 recipients. Set it to the maximum send rate on your SES **Account dashboard**. To send faster, ask AWS to raise that rate to 50 before you move to Workers Paid: on Workers Free, a rate of 50 sends nearly four times as many recipients a minute as 14, and a higher rate adds nothing there. That's `1` in the sandbox, and whatever AWS grants after that. The default, 14, is a common starting rate, not your account's.

A rate set too high only means SES throttles some requests. Those recipients wait for the next minute, and no one is mailed twice.

### `SUBREQUEST_BUDGET`

Cloudflare caps how many subrequests one run of a Worker may make. Database queries and outbound requests both count. It also caps database queries alone: 50 a run on Workers Free, and 1,000 on Workers Paid. Each minute's send work is one run, so a large send goes out over several minutes, each stopping short of both caps.

This setting is the subrequest cap. The app keeps database queries under theirs on its own.

- **The default, 50,** is the Workers Free limit, and safe on any plan. A minute sends four SES requests: 56 recipients at a send rate of 14, and 200 at a rate of 50 or more.
- **On Workers Paid,** which allows 10,000, set `"SUBREQUEST_BUDGET": "10000"`. A minute then sends about 50 SES requests, one a second: about 700 recipients at a rate of 14, and about 2,500 at 50 or more.
- **If you raised the Worker's own limit** with `limits.subrequests`, you may set this to match.

It's also how the app tells Workers Free from Workers Paid. At the default, the app runs on Free's limits:

- One import takes up to 1,000 rows, since Free's 10 ms of CPU a request can't plan and commit more. Above it, up to 10,000 ([Limits in detail](../publishing/01-your-list.md#limits-in-detail)).
- An export reads 1,000 rows a page. Above it, 10,000.
- Workers Free suits a list of up to about 1,000 subscribers. Past about 5,000, one send can use up the day's database writes and stop the newsletter until midnight UTC. So the Dashboard and the Subscribers screen recommend Workers Paid once the confirmed list passes 1,000, and so does an import plan that would take it past. The app also warns before a send to more than 5,000 recipients ([As your list grows](../guides/09-as-your-list-grows.md)). None of these stops you. Above the default, none appears, so set it on an account already on Workers Paid.

Never set it above your plan's limit. A minute that hits the cap is cut off mid-batch, and the send stalls until a later minute picks it up. A value below 30 is raised to 30, the least a minute needs to send anything and still send a notification.

### `MIN_LEAD_SECONDS`

Every send stays visible and cancelable for at least this long before it goes out, whether it's scheduled, sent now, or moved. It's the window to catch a mistake, including one in a send Claude prepared.

The floor is 60, since sends go out from a once-a-minute schedule. The ceiling is 86400, one day. It's the least wait before every send, not a limit on how far ahead a post can be scheduled. It lives in deploy config on purpose, so neither the editor nor Claude can shorten it.

### `ARCHIVE_ORIGIN` and `MEDIA_PUBLIC_BASE`

Leave them unset to keep everything on the app's own hostname.

`ARCHIVE_ORIGIN` points archive links at another origin, such as your website, `https://example.com`. The app doesn't answer there on its own. A Worker route on that domain, such as `example.com/archive*` in the environment's `routes`, sends the archive path to the app. Links already mailed keep working, since the app still answers on its own hostname.

`MEDIA_PUBLIC_BASE` serves images from another base URL, such as a custom domain on the image bucket. The app's own `/media` path sends `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` with every file, so a file in the bucket never runs as a page. A bucket's custom domain sends neither, so add both with a Response Header Transform Rule on that hostname.

### `NOTIFY_FROM`

Used only with the `NOTIFY` binding. It must be an address on a domain set up for Cloudflare's email. Without the binding, notifications come from `FROM_ADDRESS`, through your email provider.

## Secrets

| Secret | What it is | Needed for |
| --- | --- | --- |
| `ACCESS_TEAM_DOMAIN` | your Zero Trust team domain, such as `your-team.cloudflareaccess.com`; an `https://` or trailing slash is dropped | every deployment |
| `ACCESS_AUD` | the Access application's audience tag | every deployment |
| `ACCESS_ALLOWED_EMAILS` | a comma-separated list of the people allowed to sign in | optional |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | the IAM user's access key | SES |
| `SNS_TOPIC_ARN` | the SNS topic the SES webhook accepts; it refuses every other topic | SES |
| `SES_CONFIGURATION_SET` | the configuration set named on every email, so SES reports bounces and complaints; a name SES can't find in the region holds every list send until it's fixed | SES, recommended |

`ACCESS_ALLOWED_EMAILS` applies to people only. A service token, such as the one Claude uses, carries no email, so the Access policy alone decides whether it gets in.

Never set `DEV_AUTH_SECRET` on a deployed environment. It's local development's stand-in for Access, and a deployed instance ignores it anyway. The app honors it only when the environment looks like local development: `PROVIDER` is `fake`, Access isn't set up, and `APP_ORIGIN` is on `localhost` or `127.0.0.1`. A real provider, Access, or a real hostname each turns it off, and Access becomes the only way in.

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

- `PROVIDER`, when set, must be exactly `ses`, `fake`, or `none`. A misspelling, or `SES`, is refused, never taken for another. `resend`, which earlier releases supported, is refused with a pointer to [Connect Amazon SES](../get-started/04-ses.md#switch-an-instance-that-already-sends).
- `fake` runs only when `APP_ORIGIN` is on `localhost` or `127.0.0.1`, unless `ALLOW_FAKE_PROVIDER` is `true`. On a real hostname it would open signups whose confirmations go nowhere, and record every send as delivered. With `fake`, `ALLOW_FAKE_PROVIDER`, when set, must be `true`; every other provider ignores it.
- `APP_ORIGIN` must be a plain `http` or `https` origin, with no path. So must `ARCHIVE_ORIGIN`, when set. `MEDIA_PUBLIC_BASE`, when set, must be a plain `http` or `https` URL, and may have a path. A trailing slash is dropped from each.
- A real provider needs `FROM_ADDRESS`, and every secret the table marks for it. SES also needs `AWS_REGION`. `FROM_ADDRESS` must then be an email address, optionally with a display name in front, like `Name <address>`.
- None of `APP_ORIGIN`, `ARCHIVE_ORIGIN`, `MEDIA_PUBLIC_BASE`, `SENDING_DOMAIN`, or `FROM_ADDRESS` may still be on `example.com` or a name under it, the template's placeholder. That holds with no provider connected too, since every link the app builds would name it. Only `fake` allows it.
- `SUBREQUEST_BUDGET`, `MIN_LEAD_SECONDS`, and `SES_MAX_SEND_RATE` must be whole numbers above zero. `MIN_LEAD_SECONDS` must also be within its bounds. Any other value is refused, never adjusted. The one exception is a `SUBREQUEST_BUDGET` below 30, which is raised to 30.
- In local development, `SIMULATE_SENDS` must be off (`off`, `0`, `false`, `no`, or empty), `not-connected` to run as a deployment with no email provider yet, or the provider a local send models: `ses` or `generic` (also `1`, `on`, `true`, or `yes`), optionally followed by `:none` for no injected failures or `:realistic`, the default. Case doesn't matter. A deployed instance ignores it.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set together or not at all. With only one, the app could verify no sign-in and would let no one into the editor, so it refuses and names the missing one. `ACCESS_TEAM_DOMAIN` must be your team's hostname, such as `your-team.cloudflareaccess.com`. An `https://` or `http://` in front and a trailing slash are dropped, but anything else, such as a path or a port, is refused, since it would fail every sign-in.

Until it's fixed, no sends go out, and each place says what its reader can act on:

- **The editor** shows a page naming the setting, what's wrong with it, and how to fix it, with a link to its section here. Its own Docs tab can't load until then, so the link opens the project's site.
- **The API**, `/health`, and the webhooks answer `500` with a body naming the variable, such as `{"error":"invalid_config","message":…,"variable":"APP_ORIGIN"}`.
- **The public pages readers see** answer `503` with a page saying the newsletter is temporarily unavailable. It names no setting.
- **The Worker's log** records it as `config.invalid`.
