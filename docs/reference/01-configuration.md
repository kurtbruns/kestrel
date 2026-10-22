# Configuration

Every deploy-time setting: what it does, its default, and what the app refuses. Each environment's settings live in its block under `env` in `wrangler.jsonc`, and its secrets in Cloudflare.

- **Vars** are public values in the block's `vars`, safe to commit. A change takes effect when you deploy.
- **Secrets** are stored with `npx wrangler secret put NAME --env production`, and never committed. A secret takes effect as soon as you store it, with no redeploy.
- **Bindings and triggers** connect the Worker to its database, its image bucket, and its schedule.

In local development, `npm run dev` reads the top level of `wrangler.jsonc` and `.dev.vars`, which you copy from `.dev.vars.example`. Restart it after you change either.

None of these can be read or changed from inside the app, by the editor or by Claude. Settings in the editor shows the public ones, read-only.

Each setting below opens with what it is, then its default and what the app refuses, then anything more it needs explained.

## Vars

Vars go in the environment block's `vars`.

### Email provider

`PROVIDER`, the email provider: `ses`, or `fake` for local development.

- Default: none, so no provider is connected.
- Refused: anything but exactly `ses`, `fake`, or `none`. A misspelling, or `SES`, is never taken for another. `resend`, which earlier releases supported, is refused with a pointer to [Connect Amazon SES](../get-started/04-ses.md#switch-an-instance-that-already-sends).
- Refused: `fake` on a real hostname, unless `ALLOW_FAKE_PROVIDER` is `true`.

Until it's set, or while it's empty, the app runs with no provider connected. Posts can be written and previewed, but everything that would send email is refused: scheduling, sending now, test emails, and the confirmation emails that signups need. The subscribe page says signups aren't open yet, and Settings shows **No email provider connected**. Setting it to `none` means the same. A new instance's `production` block declares it empty, `"PROVIDER": ""`, so wrangler doesn't warn that the top level's value is missing there. [Connect Amazon SES](../get-started/04-ses.md) changes it to `ses`.

`fake` delivers nothing. It records a send as if every recipient accepted it. Local development runs on it, and names it on purpose in the top level of `wrangler.jsonc`. Never copy it into `production`, whatever wrangler suggests: every subscriber would be recorded as sent the post, and never get it. The app refuses `fake` unless `APP_ORIGIN` is on `localhost` or `127.0.0.1`, since on a real hostname it would open signups whose confirmations go nowhere.

`ALLOW_FAKE_PROVIDER` set to `true` lets `fake` run on a real hostname, for a hosted demo that mails no one on purpose. No other deployment needs it. With `fake`, it must be `true` when set; every other provider ignores it.

### App address

`APP_ORIGIN`, the origin the app is served from: scheme and host, no path.

- Default: none. Every deployment sets it.
- Refused: anything but a plain `http` or `https` origin with no path, or one still on `example.com` or a name under it, unless `PROVIDER` is `fake`. A trailing slash is dropped.

### SES region

`AWS_REGION`, the SES region.

- Default: `us-east-1` in the template.
- Refused: missing, when `PROVIDER` is `ses`.

### From address and sending domain

`FROM_ADDRESS`, the `From:` of every email, and `SENDING_DOMAIN`, the sending domain shown in Settings.

- Default: none for either.
- Refused: a missing `FROM_ADDRESS` with a real provider, or one that isn't an email address, optionally with a display name in front, like `Name <address>`.
- Refused: either one still on `example.com` or a name under it, unless `PROVIDER` is `fake`.

`FROM_ADDRESS` is the only address mail is sent from, and the identity your provider authenticates. `SENDING_DOMAIN` is for display: Settings shows it beside the From address. The app never checks that the two match, so set `SENDING_DOMAIN` to the part of `FROM_ADDRESS` after the `@`.

Neither one is the publication's name, tagline, or logo. You set those in the editor, under **Settings → Publication identity**. Until you do, the From address's display name stands in for the name, and with neither, the emails and reader pages show no name at all.

### Archive path

`ARCHIVE_BASE_PATH`, the path the archive lives under.

- Default: `/archive`.
- A missing leading slash is added, and a trailing slash is dropped.

A listed post's archive address is `ARCHIVE_BASE_PATH` followed by the post's slug. Emails link through each post's unlisted link, `/email/<token>` on `APP_ORIGIN`, which forwards to the archive address, so changing the prefix later breaks no email that carries one, only archive addresses people have shared. Emails sent by 1.11 or earlier carry the archive address itself, and changing the prefix breaks those. To keep links from an older install working, set it to the prefix they use, such as `/newsletter`.

### Send rate

`SES_MAX_SEND_RATE`, your SES account's maximum send rate, in messages a second.

- Default: `14`, a common starting rate, not your account's.
- Refused: anything but a whole number above zero.

The app sends SES one request a second, the most SES takes, and each request carries one second of this rate, up to 50 recipients. Set it to the maximum send rate on your SES **Account dashboard**: `1` in the sandbox, and whatever AWS grants after that. To send faster, ask AWS to raise that rate to 50 before you move to Workers Paid: on Workers Free, a rate of 50 sends nearly four times as many recipients a minute as 14, and a higher rate adds nothing there.

A rate set too high only means SES throttles some requests. Those recipients wait for the next minute, and no one is mailed twice.

### Request budget

`SUBREQUEST_BUDGET`, how many subrequests one minute's send work may use. It also tells the app which Workers plan it's on.

- Default: `50`, the Workers Free limit, and safe on any plan.
- Refused: anything but a whole number above zero. A value below 30 is raised to 30, the least a minute needs to send anything and still send a notification.

Cloudflare caps how many subrequests one run of a Worker may make. Database queries and outbound requests both count. It also caps database queries alone: 50 a run on Workers Free, and 1,000 on Workers Paid. Each minute's send work is one run, so a large send goes out over several minutes, each stopping short of both caps. This setting is the subrequest cap. The app keeps database queries under theirs on its own.

- **At the default,** a minute sends four SES requests: 56 recipients at a send rate of 14, and 200 at a rate of 50 or more.
- **On Workers Paid,** which allows 10,000, set `"SUBREQUEST_BUDGET": "10000"`. A minute then sends about 50 SES requests, one a second: about 700 recipients at a rate of 14, and about 2,500 at 50 or more.
- **If you raised the Worker's own limit** with `limits.subrequests`, you may set this to match.

Never set it above your plan's limit. A minute that hits the cap is cut off mid-batch, and the send stalls until a later minute picks it up.

At the default, the app runs on Workers Free's limits:

- One import takes up to 1,000 rows, since Free's 10 ms of CPU a request can't plan and commit more. Above it, up to 10,000 ([Limits in detail](../publishing/01-your-list.md#limits-in-detail)).
- An export reads 1,000 rows a page. Above it, 10,000.
- Workers Free suits a list of up to about 1,000 subscribers. Past about 5,000, one send can use up the day's database writes and stop the newsletter until midnight UTC. So the Dashboard and the Subscribers screen recommend Workers Paid once the confirmed list passes 1,000, and so does an import plan that would take it past. The app also warns before a send to more than 5,000 recipients ([As your list grows](../guides/09-as-your-list-grows.md)). None of these stops you. Above the default, none appears, so set it on an account already on Workers Paid.

### Minimum lead

`MIN_LEAD_SECONDS`, the least time every send stays cancelable before it goes out.

- Default: `300`, five minutes.
- Refused: anything but a whole number from 60 to 86400, one day.

It applies whether a send is scheduled, sent now, or moved. It's the window to catch a mistake, including one in a send Claude prepared. The floor is 60, since sends go out from a once-a-minute schedule. It's the least wait before every send, not a limit on how far ahead a post can be scheduled. It lives in deploy config on purpose, so neither the editor nor Claude can shorten it.

### Archive and image addresses

`ARCHIVE_ORIGIN`, the origin archive links use, to put the archive on your website, and `MEDIA_PUBLIC_BASE`, the base URL images are served from.

- Default: `APP_ORIGIN` for archive links, and `APP_ORIGIN` followed by `/media` for images.
- Refused: an `ARCHIVE_ORIGIN` that isn't a plain `http` or `https` origin with no path, or a `MEDIA_PUBLIC_BASE` that isn't a plain `http` or `https` URL, which may have a path. A trailing slash is dropped from each.
- Refused: either one still on `example.com` or a name under it, unless `PROVIDER` is `fake`.

Leave them unset to keep everything on the app's own hostname.

`ARCHIVE_ORIGIN` points archive links at another origin, such as your website, `https://example.com`. The app doesn't answer there on its own. A Worker route on that domain, such as `example.com/archive*` in the environment's `routes`, sends the archive path to the app. Links already mailed keep working, since the app still answers on its own hostname. Crawlers read your website's own `robots.txt` for the archive pages there. The app's `/llms.txt` stays on the app's hostname, and its archive link points at your website.

`MEDIA_PUBLIC_BASE` serves images from another base URL, such as a custom domain on the image bucket. The app's own `/media` path sends `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` with every file, so a file in the bucket never runs as a page. A bucket's custom domain sends neither, so add both with a Response Header Transform Rule on that hostname.

### Notifications sender

`NOTIFY_FROM`, the sender of notifications through Cloudflare's email.

- Default: `kestrel@` on the app's hostname, named Kestrel, such as `Kestrel <kestrel@newsletter.example.com>`.

It's used only with the `NOTIFY` binding, and must be an address on a domain set up for Cloudflare's email. Without the binding, notifications come from `FROM_ADDRESS`, through your email provider.

## Secrets

Store each with `npx wrangler secret put NAME --env production`, which prompts for the value.

### Access team domain and audience tag

`ACCESS_TEAM_DOMAIN`, your Zero Trust team domain, such as `your-team.cloudflareaccess.com`, and `ACCESS_AUD`, the Access application's audience tag.

- Needed: by every deployment.
- Refused: one without the other. With only one, the app could verify no sign-in and would let no one into the editor, so it names the missing one.
- Refused: an `ACCESS_TEAM_DOMAIN` that isn't a hostname. An `https://` or `http://` in front and a trailing slash are dropped, but anything else, such as a path or a port, is refused, since it would fail every sign-in.

[Lock the dashboard with Access](../get-started/03-access.md#4-give-the-app-its-two-values) shows where to find both.

### Allowed emails

`ACCESS_ALLOWED_EMAILS`, a comma-separated list of the people allowed to sign in.

- Needed: optional. Without it, the app lets in anyone the Access policy allows.

It keeps the editor limited to named people if the Access policy is widened later. It applies to people only. A service token, the credential a script uses, carries no email, so the Access policy alone decides whether it gets in.

### AWS access key

`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, the IAM user's access key, which sends through SES.

- Refused: missing, when `PROVIDER` is `ses`.

### SNS topic

`SNS_TOPIC_ARN`, the SNS topic the SES webhook accepts.

- Refused: missing, when `PROVIDER` is `ses`.

The webhook refuses a report from every other topic, and logs `webhook.refused` naming both.

### Configuration set

`SES_CONFIGURATION_SET`, the configuration set named on every email, so SES reports bounces and complaints.

- Needed: recommended with SES.

A name SES can't find in the region holds every list send until it's fixed.

### Local sign-in secret

`DEV_AUTH_SECRET`, local development's stand-in for Access. Never set it on a deployed environment.

A deployed instance ignores it anyway. The app honors it only when the environment looks like local development: `PROVIDER` is `fake`, Access isn't set up, and `APP_ORIGIN` is on `localhost` or `127.0.0.1`. A real provider, Access, or a real hostname each turns it off, and Access becomes the only way in.

## Bindings and triggers

Wrangler doesn't carry bindings or vars over from the top level of `wrangler.jsonc` to an environment. Each environment's block declares its own.

### Worker name

`name`, the Worker's name, such as `kestrel-production`. Every environment sets its own.

### Hostnames

`routes`, the app's hostname, attached on deploy, and any route on your website, and `workers_dev` and `preview_urls`, the Worker's `workers.dev` and preview addresses.

- Default: the template sets `workers_dev` and `preview_urls` to `false`.

The template turns off the `workers.dev` addresses, so the app answers only on your hostname. That's where your Access application and any rate-limiting rule apply. Each deploy replaces the Worker's routes with the ones in the file, so add a route here, never in the dashboard.

### Send schedule

`triggers.crons`, the once-a-minute schedule, `* * * * *`. Every environment needs it.

The schedule runs every minute. It sends whatever is due, and the notifications about it. Without it, nothing scheduled ever goes out.

### Logs

`observability`, Workers Logs, where the app's log lines land.

- Default: on.

Every invocation is logged, with no sampling. Sampling could drop the one minute that reports a stuck or missed send.

### Database

`DB`, the `d1_databases` binding for the database: posts, subscribers, sends, and settings. Every environment needs it.

### Image bucket

`MEDIA`, the `r2_buckets` binding for the bucket of images and your logo. Every environment needs it.

### Cloudflare's email

`NOTIFY`, the `send_email` binding for Cloudflare's email, for notifications.

- Default: none, so notifications go through your email provider.

When declared, notifications go through Cloudflare's email instead of your provider, so they still arrive when your provider refuses your account. Local development ignores it, and sends notifications to a stand-in that delivers nothing.

## What the app refuses

The app checks its configuration on every request. It refuses to run on one that would do the wrong thing quietly, and each setting above says what it refuses. In local development, `SIMULATE_SENDS` must also be off (`off`, `0`, `false`, `no`, or empty), `not-connected` to run as a deployment with no email provider yet, or the provider a local send models: `ses` or `generic` (also `1`, `on`, `true`, or `yes`), optionally followed by `:none` for no injected failures or `:realistic`, the default. Case doesn't matter. A deployed instance ignores it.

Until it's fixed, no sends go out, and each place says what its reader can act on:

- **The editor** shows a page naming the setting, what's wrong with it, and how to fix it, with a link to its section here. Its own Docs tab can't load until then, so the link opens the project's site.
- **The API**, `/health`, and the webhooks answer `500` with a body naming the variable, such as `{"error":"invalid_config","message":…,"variable":"APP_ORIGIN"}`.
- **The public pages readers see** answer `503` with a page saying the newsletter is temporarily unavailable. It names no setting.
- **The Worker's log** records it as `config.invalid`.
