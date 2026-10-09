# Deploy the app

Kestrel runs as one Cloudflare Worker, with a D1 database for posts and subscribers and an R2 bucket for images.

In this guide, you create your instance's repository, create the database and the bucket, and point Kestrel's production settings at them and at your hostname. Then you deploy, and check that the app answers on your hostname. You need what the [Overview](01-overview.md#before-you-begin) lists.

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

1. **(Optional)** Try Kestrel on your computer before you deploy it. Local development sends email to a stand-in, so nothing reaches a real inbox:

    ```bash
    cp .dev.vars.example .dev.vars
    npm run dev
    ```

    Open http://localhost:8787/dashboard/ to see the editor. To fill it with demo content, run `npm run seed` in a second terminal, and `npm run reset` to empty it again. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop the server.

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

1. Create the database:

    ```bash
    npx wrangler d1 create kestrel-production
    ```

    It prints the new database's settings, including a `database_id`. Copy the id for the next section. If Wrangler offers to add the database to your configuration for you, decline: you add it to the production settings yourself, below.

1. Create the bucket for images:

    ```bash
    npx wrangler r2 bucket create kestrel-media-production
    ```

## 4. Configure production

`wrangler.jsonc` holds two sets of settings. The top level is for local development, so leave it alone. The `production` block under `env` is yours to fill in.

1. Open `wrangler.jsonc` and change the values marked here in the `production` block:

    ```jsonc
    "production": {
      "routes": [{ "pattern": "newsletter.example.com", "custom_domain": true }], // ← your app's hostname
      "d1_databases": [
        {
          "binding": "DB",
          "database_name": "kestrel-production",
          "database_id": "REPLACE_WITH_PRODUCTION_D1_ID", // ← the id from section 3
          "migrations_dir": "migrations"
        }
      ],
      "vars": {
        "PROVIDER": "fake",                                        // ← leave as is for now
        "APP_ORIGIN": "https://newsletter.example.com",            // ← your app's hostname
        "ARCHIVE_BASE_PATH": "/archive",
        "SENDING_DOMAIN": "send.example.com",                      // ← your sending hostname
        "FROM_ADDRESS": "Newsletter <newsletter@send.example.com>" // ← who your mail is from
      }
    }
    ```

    What each one does:

    - **`routes`** puts the app on your hostname when you deploy. Cloudflare creates the DNS record and the certificate. Your domain must be in the same Cloudflare account, and the hostname can't already have a CNAME record; delete one if it does. The block also turns off the `workers.dev` addresses, so the app answers only on your hostname.
    - **`PROVIDER`** stays `fake` until you connect Resend in [step 4](04-resend.md). The `fake` transport delivers nothing, so don't schedule a post before then.
    - **`ARCHIVE_BASE_PATH`** is permanent once you send. Every post you send carries its `/archive/…` link, and changing the prefix later breaks the links you've already mailed. Keep `/archive` unless you have a reason not to.
    - **`FROM_ADDRESS`** is the address every email comes from. Keep it on your sending hostname, and set `SENDING_DOMAIN` to the part after the `@`.

    Every other setting has a working default. [Configuration](../reference/01-configuration.md) lists them all, and what the app refuses.

1. Check the file. This regenerates the binding types, and fails if the configuration doesn't parse:

    ```bash
    npm run typecheck
    ```

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

1. In a browser, `https://newsletter.example.com/` shows your newsletter's public landing page.

If every request instead answers `500` with a body like `{"error":"invalid_config","variable":"APP_ORIGIN",…}`, the setting it names is missing or malformed. Fix it in `wrangler.jsonc`, commit, and deploy again.

Next, [lock the dashboard with Access](03-access.md).
