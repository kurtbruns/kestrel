# Deploy the app

Make your own copy of the repository, create the database and the image bucket, point the `production` environment in `wrangler.jsonc` at them and at your hostname, apply the schema, and deploy. The platform and why it was chosen are in `docs/SPEC.md`, deployment appendix.

## 1. Get the code

Your copy of the repository holds your instance's configuration, so it needs a home of its own. Kestrel's repository stays connected as `upstream`, where new releases come from.

1. On GitHub, [create a new repository](https://github.com/new) named `kestrel`. Make it private if you like, and leave it empty: no README, license, or `.gitignore`.

1. Clone Kestrel, point it at your new repository, and push:

    ```bash
    git clone https://github.com/kurtbruns/kestrel.git
    cd kestrel
    git remote rename origin upstream
    git remote add origin https://github.com/YOUR_USERNAME/kestrel.git
    git push -u origin main
    ```

    Replace `YOUR_USERNAME` with your GitHub username. To check the remotes, run `git remote -v`:

    ```
    origin    https://github.com/YOUR_USERNAME/kestrel.git (fetch)
    origin    https://github.com/YOUR_USERNAME/kestrel.git (push)
    upstream  https://github.com/kurtbruns/kestrel.git (fetch)
    upstream  https://github.com/kurtbruns/kestrel.git (push)
    ```

1. Install the dependencies:

    ```bash
    npm install
    ```

1. **(Optional)** Try Kestrel on your computer before you deploy it. Local development uses a stand-in for email, so nothing you do reaches a real inbox:

    ```bash
    cp .dev.vars.example .dev.vars
    npm run dev
    ```

    Open http://localhost:8787/dashboard/ to see the editor. To fill it with demo content, run `npm run seed` in a second terminal. Press <kbd>Ctrl</kbd>+<kbd>C</kbd> to stop the server. The [README](https://github.com/kurtbruns/kestrel#local-setup) covers local development in full.

1. Sign the Wrangler CLI in to your Cloudflare account. A browser window opens to approve the login:

    ```bash
    npx wrangler login
    ```

    To confirm it worked, run `npx wrangler whoami`. It prints the email and the account you're signed in as.

1. **(Optional)** In `package.json`, set `repository.url` to your repository. The editor links the running build to its commit through that field. Without the change, those links open Kestrel's repository instead of yours.

## 2. Create the database and the bucket

```bash
npx wrangler d1 create kestrel-production
npx wrangler r2 bucket create kestrel-media-production
```

`wrangler d1 create` prints a `database_id`. Copy it for the next step.

## 3. Fill in `wrangler.jsonc`

The top level of `wrangler.jsonc` is local development; leave it alone. Edit the `production` block under `env`, which declares its own bindings and vars because wrangler does not inherit them. Change the values marked below:

```jsonc
"production": {
  "routes": [{ "pattern": "newsletter.example.com", "custom_domain": true }], // ← your app's hostname
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "kestrel-production",
      "database_id": "REPLACE_WITH_PRODUCTION_D1_ID", // ← from step 2
      "migrations_dir": "migrations"
    }
  ],
  "vars": {
    "PROVIDER": "fake",                                        // ← `fake` for now
    "APP_ORIGIN": "https://newsletter.example.com",            // ← your app's hostname
    "ARCHIVE_BASE_PATH": "/archive",
    "SENDING_DOMAIN": "send.example.com",                      // ← your sending name
    "FROM_ADDRESS": "Newsletter <newsletter@send.example.com>" // ← who your mail is from
  }
}
```

- **`routes`** attaches your hostname to the Worker on deploy: Cloudflare creates its DNS record and certificate. The hostname's zone must be on Cloudflare in the same account, and the hostname must not already have a CNAME record; delete one if it does. The template also sets `"workers_dev": false` and `"preview_urls": false`, so the app answers only on your hostname.
- **`PROVIDER`** stays `fake` for now. A real provider refuses to run until its secrets are set, which happens in **Connect Resend**. The `fake` transport delivers nothing, so do not schedule a post before then.
- **`ARCHIVE_BASE_PATH`** is permanent once you send. Every post you send carries its `/archive/<slug>` link forever, and changing the prefix later breaks the links already mailed. Keep `/archive` unless you have a reason.
- **`FROM_ADDRESS`** is the address every email is sent from. Keep it on your sending name, and set `SENDING_DOMAIN` to the domain part of it.

Every other setting has a working default. **Configuration** in the reference lists them all, and what the app refuses.

Then regenerate the binding types, which also checks the file, and commit and push your changes. Upgrades merge new releases into this branch:

```bash
npm run typecheck
git commit -am "Configure production"
git push
```

## 4. Apply the schema

```bash
npm run migrate:remote -- --env production
```

This applies every migration the database has not seen yet, so running it again is harmless. It refuses to run without `--env`, since the top-level config is development.

## 5. Deploy

```bash
npm run deploy -- --env production
```

This builds the editor, stamps the build with its version, and deploys. It also registers the once-a-minute Cron Trigger that sends scheduled posts, which you can see under the Worker's **Triggers** tab in the Cloudflare dashboard.

## Check it

- [ ] `https://newsletter.example.com/health` answers `{"status":"ok","service":"kestrel"}`. A new hostname can take a few minutes to get its certificate.
- [ ] `https://newsletter.example.com/` shows the public landing page.
- [ ] `https://newsletter.example.com/dashboard/` loads, but the editor can do nothing: every admin request answers `401`.

That last one is correct for now. Until Access is set up, the app has no way to tell who is asking, so it lets no one in. If instead every request answers `500` with a body like `{"error":"invalid_config","variable":"APP_ORIGIN",…}`, the variable it names is missing or malformed: fix it in `wrangler.jsonc` and deploy again.
