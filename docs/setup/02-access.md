# Access — the admin gate

In deployed environments the admin surface is gated by **Cloudflare Access** at the edge, and re-verified in-app as defense in depth (`src/auth/access.ts`). The reader surface stays public. Why the boundary is drawn this way — one host, two audiences, an explicit public allowlist and everything else admin — is `docs/SPEC.md` §11.

There is no auth code to write. Your job is to configure one Access application correctly and set three vars.

## What must be gated, and what must not

The authoring API is **not** a single path prefix — it is spread across several. The Access application must cover the editor **and** every authoring path, so the editor's same-origin `fetch` calls carry the Access JWT. It must **not** cover the reader routes, or readers would hit a login wall.

Gate exactly these path prefixes (each match includes all subpaths):

| Prefix | What it is |
| --- | --- |
| `/dashboard` | the editor SPA (static assets) |
| `/posts` | posts, revisions, images, preview, test, schedule, send |
| `/sends` | the send status surface |
| `/subscribers` | the subscriber roster |
| `/suppressions` | the suppression list |
| `/api` | `whoami`, the in-app docs (`/api/docs`) |

Leave everything else public — the reader surface and webhooks: `/` (landing page), `/subscribe`, `/confirm`, `/unsubscribe`, `ARCHIVE_BASE_PATH` (e.g. `/archive/*`, the archive index and post pages), `/media/*`, `/webhooks/*`, `/health`.

> `/dashboard` is load-bearing: the editor SPA lives there, so if it isn't in this application the editor ships ungated. Every authenticated route lives under one of the six prefixes above, so a new authoring endpoint added under `/api` (as the in-app docs are) is gated by the same application automatically. The one public `/api` route, `/api/dev/token`, exists only in a dev-shaped env and 404s once deployed, so gating `/api` wholesale is safe in production. Verify this against `src/app.ts` if the routes ever change.

## 1. Create one Access application

In the Cloudflare **Zero Trust** dashboard → **Access → Applications → Add an application → Self-hosted**:

- **Application domain:** `newsletter.example.com`.
- **Paths:** add all six prefixes above (`dashboard`, `posts`, `sends`, `subscribers`, `suppressions`, `api`) to this single application. Do not create one application per path — one application, many paths, so they share the AUD and policy set.

Note the application's **Application Audience (AUD) tag** from its settings — you need it below.

## 2. Add the two policies

On that application:

- **Allow (you, the human).** An Allow policy with your identity provider (Google / GitHub / one-time PIN to your email). This is the interactive login.
- **Service Auth (Claude / automation).** A Service Auth policy, then create a **service token** under **Access → Service Auth**. It yields a `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Claude sends those two headers; the request never needs a browser handshake, and service tokens do not consume Zero Trust seats.

The in-app verifier tells the two apart: a token with an `email` claim is the human (checked against the optional allowlist below); a service token has no email and is authorized purely by the Service Auth policy.

## 3. Set the Worker vars

Set these on each deployed environment so the in-app re-verification can validate the JWT:

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN --env staging   # e.g. your-team.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD --env staging           # the AUD tag from step 1
# optional: restrict human logins to specific emails (CSV)
npx wrangler secret put ACCESS_ALLOWED_EMAILS --env staging # e.g. you@example.com,team@example.com
```

- `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` **must both be set** for in-app JWT validation to run; if either is missing, the app cannot verify Access assertions and the gate rests on the edge alone.
- `ACCESS_ALLOWED_EMAILS` is optional. Empty/unset admits any valid Access login; set it to lock admin down to named humans. It gates humans only — service tokens carry no email.

## 4. There is no bearer backdoor to close

Local dev authenticates with a JWT signed by `DEV_AUTH_SECRET` (`src/auth/dev_token.ts`), which lives only in the gitignored `.dev.vars` — never in `wrangler.jsonc`. A deployed environment therefore has no value for it, and `getConfig` honors it *only* in a dev-shaped env (fake transport **and** no Access configured) anyway. So there is nothing to unset: once you set `PROVIDER` to a real transport and configure Access, the dev credential path is structurally off and **Access is the only door**. Do not add `DEV_AUTH_SECRET` to any deployed environment's secrets.

## 5. Reach gated endpoints from a terminal

Because deployed authoring routes require an Access JWT, a plain `curl` gets a login-redirect, not JSON. Use `cloudflared` to attach your identity:

```bash
# one-off request as the interactive human (opens a browser to log in once)
cloudflared access curl https://newsletter.example.com/api/whoami

# or mint a token to reuse
cloudflared access token --app https://newsletter.example.com
```

For automation, send the service token headers instead:

```bash
curl https://newsletter.example.com/api/whoami \
  -H "CF-Access-Client-Id: <client-id>" \
  -H "CF-Access-Client-Secret: <client-secret>"
```

`GET /api/whoami` returning `{"principal":{"kind":"human"},"auth":{"mode":"access"}}` (or `"kind":"service"`) confirms the gate and the in-app verifier agree. A 401 with no Access headers confirms the surface is closed.

## 6. Rate-limit the subscribe form

The subscribe form is public, so bound how often one client can submit it. The app already sends each address at most one confirmation in any 15 minutes and never answers in a way that reveals who is on the list (`docs/SPEC.md` §7); the per-client limit is the edge's job, so there is nothing in the app to configure for it.

In the Cloudflare dashboard, open the zone for `newsletter.example.com` → **Security → WAF → Rate limiting rules → Create rule**:

- **If incoming requests match:** a custom expression,

  ```
  (http.request.uri.path eq "/subscribe" and http.request.method eq "POST")
  ```

- **With the same characteristics:** IP.
- **When rate exceeds:** 5 requests per 10 seconds. That is the Free plan's only period; on a paid plan a longer one fits the form better, such as 10 requests per minute.
- **Then take action:** Block, for the shortest duration the plan offers (10 seconds on Free).

The Free plan allows one rate-limiting rule, and this is the one to spend it on. The rule applies only on the zone's own hostname (`newsletter.example.com`), so it does not cover a `*.workers.dev` address the Worker may also answer on.

To check it, submit the form rapidly from one machine: after the limit, Cloudflare answers with its own block page instead of the app's.
