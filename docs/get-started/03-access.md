# Lock the dashboard with Access

Cloudflare Access puts a login in front of the editor and the authoring API, and the app checks every request against it as well. There is no auth code to write: you create one Access application and give the app two of its values. The public pages stay public. **How the admin gate works** in the reference explains the design.

## 1. Create one Access application

In the Cloudflare **Zero Trust** dashboard, go to **Access → Applications → Add an application → Self-hosted**:

- **Application domain:** `newsletter.example.com`.
- **Paths:** add these six to the one application: `dashboard`, `posts`, `sends`, `subscribers`, `suppressions`, `api`. One application with six paths, not six applications, so they share one login and one audience tag.

Leave every other path out. The landing page, the archive, subscribe, confirm, unsubscribe, images, and the provider webhooks must stay public, or readers and your provider would hit a login wall.

## 2. Add an Allow policy for yourself

On that application, add an **Allow** policy with your identity provider: Google, GitHub, or a one-time PIN sent to your email. This is the login you will use.

Then open the application's settings and copy its **Application Audience (AUD) tag**.

## 3. Give the app the two values

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN --env production    # e.g. your-team.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD --env production            # the AUD tag from step 2
```

Both must be set: with either missing, the app cannot verify any login, so it lets no one in. Secrets take effect at once; there is no redeploy.

To limit the login to named people beyond what the Allow policy already does, also set `ACCESS_ALLOWED_EMAILS` to a comma-separated list of addresses. Unset, any login the policy admits is let in.

## Check it

- [ ] Opening `https://newsletter.example.com/dashboard/` asks you to log in through Access.
- [ ] After logging in, the editor loads your dashboard and shows who you are signed in as.
- [ ] `https://newsletter.example.com/` still opens with no login.

A `401` after logging in usually means one of the two secrets is missing or misspelled, or that `ACCESS_ALLOWED_EMAILS` is set and does not list your address.
