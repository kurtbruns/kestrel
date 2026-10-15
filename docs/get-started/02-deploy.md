# Deploy the app

Kestrel runs as one Cloudflare Worker, with a D1 database for posts and subscribers and an R2 bucket for images.

In this guide, you choose your hostnames, create your instance's repository, create the database and the bucket, and point Kestrel's production settings at them and at your hostname. Then you deploy, and check that the app answers on your hostname.

## Before you begin

- A [Cloudflare account](https://dash.cloudflare.com/sign-up), with your domain's DNS on Cloudflare. Your app's hostname and its login both live there.
- [Node.js](https://nodejs.org/) 22 or later, and [Git](https://git-scm.com/).
- A GitHub account, or another Git host, for your instance's repository.
- An [AWS account](https://portal.aws.amazon.com/billing/signup), for Amazon SES, which sends your email.

## Choose your hostnames

Kestrel uses two hostnames: one for the app, and one your email is sent from.

| Hostname | What it's for |
| --- | --- |
| `newsletter.example.com` | the editor, the API, and the public pages readers see |
| `send.example.com` | the address your email comes from, and its SPF, DKIM, and DMARC records |

These guides put the app on a subdomain, which leaves any website you already have on `example.com` untouched. If `example.com` has no website of its own, the app can live there instead. Use `example.com` wherever these guides say `newsletter.example.com`.

It's recommended to send from a subdomain rather than from `example.com` itself. Your apex domain carries the reputation of your regular email, and a newsletter shouldn't put that at risk. Avoid `mail.` as the sending name too, since mail servers read it as an inbound host. [Sending-domain DNS](../reference/02-sending-domain-dns.md#choose-your-sending-name) explains both.

Throughout these guides, replace the example names with your own, and any value written as `REPLACE_WITH_…`.

## 1. Create your instance's repository

Your instance's repository holds its configuration, its database migrations, and the release of Kestrel it runs. Kestrel itself installs from npm as `@kurtbruns/kestrel`, so the repository stays small, and an upgrade changes the version it names.

1. On GitHub, [create a new repository](https://github.com/new) named `newsletter`. It can be private. Leave it empty, with no README, license, or `.gitignore`.

1. Clone it, and write a new instance into it. Replace `YOUR_USERNAME` with your GitHub username:

    ```bash
    git clone https://github.com/YOUR_USERNAME/newsletter.git
    cd newsletter
    npx @kurtbruns/kestrel init
    ```

    This writes the instance's files: `wrangler.jsonc` for its settings, `package.json` with the release it runs, the release's database migrations, and a starting point for Claude Code in `.claude/`. The instance's `README.md` lists its commands.

1. Install the release and its tools:

    ```bash
    npm install
    ```

1. Commit the new instance, and push it:

    ```bash
    git add -A
    git commit -m "Start a Kestrel instance"
    git push -u origin HEAD
    ```

1. **(Optional)** Try Kestrel locally before you deploy it. Copy the local settings, and start the app:

    ```bash
    cp .dev.vars.example .dev.vars
    npm run dev
    ```

    Open http://localhost:8787/dashboard/, and run `npm run seed` in a second terminal to load a demo publication. Email goes to a stand-in, so nothing reaches a real inbox. Stop the server with <kbd>Ctrl</kbd>+<kbd>C</kbd> when you're done.

## 2. Sign in to Cloudflare

Every command from here on acts on your Cloudflare account through the Wrangler CLI.

1. Sign in. A browser window opens for you to approve the login:

    ```bash
    npx wrangler login
    ```

1. Confirm which account you're signed in to:

    ```bash
    npx wrangler whoami
    ```

    It prints your email and the account name. If you belong to more than one account, make sure it's the one that holds your domain.

## 3. Create the database and the image bucket

Each command creates the resource and writes its id or name into the `production` block of `wrangler.jsonc`, under the binding the app already uses, so there's nothing to copy.

1. Create the database:

    ```bash
    npx wrangler d1 create kestrel-production --env production --binding DB --update-config
    ```

    It prints the new database's settings, then a snippet it says to add to your configuration. Wrangler has already added it: it fills in the `database_id` of the production `DB` binding with the database's real id, in place of `REPLACE_WITH_PRODUCTION_D1_ID`, so there's nothing to paste.

1. Create the bucket for images:

    ```bash
    npx wrangler r2 bucket create kestrel-media-production --env production --binding MEDIA --update-config
    ```

    It prints a snippet to add to your configuration too. There's nothing to paste here either: the production `MEDIA` binding already names this bucket, so it stays as it is.

Wrangler rewrites the whole of `wrangler.jsonc` in its own layout when it saves: tabs, and one value per line. Your comments and settings stay; only the spacing changes.

Name `--env production` on every Wrangler command that creates or binds a resource. Without it, Wrangler writes to the top level, which is local development.

## 4. Configure production

`wrangler.jsonc` holds two sets of settings. The top level is for local development, so leave it alone. The `production` block under `env` is yours to fill in.

1. Open `wrangler.jsonc` and change the values marked here in the `production` block. It's shown compactly here; in your file, after section 3, each value is on its own line:

    ```jsonc
    "production": {
      "routes": [{ "pattern": "newsletter.example.com", "custom_domain": true }], // ← your app's hostname
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "kestrel-production",
          "database_id": "…", // already filled in by section 3; leave it
          "migrations_dir": "migrations"
        }
      ],
      "vars": {
        "PROVIDER": "",                                            // ← stays empty until Connect Amazon SES
        "APP_ORIGIN": "https://newsletter.example.com",            // ← your app's hostname
        "ARCHIVE_BASE_PATH": "/archive",
        "SENDING_DOMAIN": "send.example.com",                      // ← your sending hostname
        "FROM_ADDRESS": "Newsletter <newsletter@send.example.com>" // ← who your mail is from
      }
    }
    ```

    What each one does:

    - **`routes`** puts the app on your hostname when you deploy. Cloudflare creates the DNS record and the certificate. Your domain must be in the same Cloudflare account, and the hostname can't already have a CNAME record; delete one if it does. The block also turns off the `workers.dev` addresses, so the app answers only on your hostname.
    - **`PROVIDER` stays empty.** [Connect Amazon SES](04-ses.md) sets it. Until then the app runs without an email provider: posts can be written and previewed, but scheduling, test emails, and signups are refused. Never set it to `fake`, the top level's value, even when a wrangler warning suggests copying it: `fake` delivers nothing, and the app refuses it on your hostname.
    - **`ARCHIVE_BASE_PATH`** is permanent once the first post goes out. Every post sent carries its `/archive/…` link, and changing the prefix later breaks the links already mailed. Keep `/archive` unless you have a reason not to.
    - **`FROM_ADDRESS`** is the address every email comes from. Keep it on your sending hostname, and set `SENDING_DOMAIN` to the part after the `@`.

    Change every `example.com` value, the route included, even before you connect a provider. The app checks its settings but can't see the route: it refuses to run while `APP_ORIGIN`, `SENDING_DOMAIN`, or `FROM_ADDRESS`, or `ARCHIVE_ORIGIN` or `MEDIA_PUBLIC_BASE` if you set them, is still on `example.com`, since its links and the address your email comes from would name a domain that isn't yours.

    Every other setting has a working default. [Configuration](../reference/01-configuration.md) lists them all, and what the app refuses.

1. Check the file. This regenerates the binding types, and fails if the configuration doesn't parse:

    ```bash
    npm run typecheck
    ```

    Wrangler prints the binding types it generated and ends with a reminder to run it again whenever you change `wrangler.jsonc`. The type check that follows prints nothing when it passes.

1. Commit your settings and push them to your repository. An upgrade changes only the release your instance runs, so your settings stay as they are:

    ```bash
    git commit -am "Configure production"
    git push
    ```

## 5. Apply the schema

Create Kestrel's tables in the production database:

```bash
npx wrangler d1 migrations apply DB --remote --env production
```

It lists the migrations it's about to apply and asks you to confirm. It applies only the ones the database hasn't seen, so running it again is harmless.

## 6. Deploy

```bash
npx wrangler deploy --env production
```

This deploys the release your instance runs, with your settings. The output ends with the hostname the app now answers on. Deploying also registers the once-a-minute schedule that sends posts, which you can see under the Worker's **Triggers** tab in the Cloudflare dashboard.

## Check it

1. The app answers on your hostname. A new hostname can take a few minutes to get its certificate.

    ```bash
    curl https://newsletter.example.com/health
    ```

    ```
    {"status":"ok","service":"kestrel"}
    ```

1. The editor is locked. Until you set up Access in the next step, the app can't tell who is asking, so it lets no one in:

    ```bash
    curl -s -o /dev/null -w "%{http_code}\n" https://newsletter.example.com/api/whoami
    ```

    ```
    401
    ```

    In a browser, `https://newsletter.example.com/dashboard/` says the editor is locked until you set up Access. That's expected.

1. In a browser, `https://newsletter.example.com/` shows the newsletter's public landing page. Its subscribe page, `/subscribe`, says signups aren't open yet, until Connect Amazon SES.

If the public pages instead say the newsletter is temporarily unavailable, and `/health` answers `500` with a body like `{"error":"invalid_config","variable":"APP_ORIGIN",…}`, the setting it names is missing, malformed, or still on `example.com`. Fix it in `wrangler.jsonc`, commit, and deploy again.

If the public pages say the same, but `/health` answers `500` with `{"error":"schema_behind","missing":[…],…}`, the database hasn't run the migrations it lists, most often because step 5 was skipped or its prompt answered no. Run step 5's command, which the body's `message` repeats; the app answers as soon as it finishes, with no new deploy.

Next, [lock the dashboard with Access](03-access.md).
