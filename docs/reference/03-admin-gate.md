# How the admin gate works

Deployed, the admin surface is gated by **Cloudflare Access** at the edge and checked again inside the app, so a misconfigured Access policy can't silently expose it (`src/auth/access.ts`). The reader surface stays public. Why the line is drawn this way (one hostname, two audiences, an explicit public allowlist with everything else admin) is `docs/SPEC.md` §11. **Lock the dashboard with Access** has the steps; this page has the detail behind them.

## Two kinds of login

The app resolves every request to a principal. A login with an `email` claim is a **human**, you in the editor, checked against `ACCESS_ALLOWED_EMAILS` when that is set. A **service token** carries no email and is authorized by a Service Auth policy alone: it is how Claude and other automation reach the API (see **Connect Claude to the API**). Service tokens need no browser and take no Zero Trust seat.

`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` must both be set. With either missing, the app cannot verify any Access login, so it admits no one: every admin route answers `401`, even to a request the edge let through.

## What must be gated, and what must not

The admin surface is two path prefixes: the editor under `/dashboard`, and the authoring API, every route of it, under `/api`. The Access application must cover both, so the editor's same-origin `fetch` calls carry the Access JWT. It must **not** cover the reader routes, or readers would hit a login wall.

Gate exactly these path prefixes (each match includes all subpaths):

| Prefix | What it is |
| --- | --- |
| `/dashboard` | the editor SPA (static assets) |
| `/api` | the authoring API: posts, revisions, images, preview, test, schedule, send, the send record, subscribers, suppressions, settings, `whoami`, the in-app docs, and the API reference |

Leave everything else public, the reader surface and the webhooks: `/` (landing page), `/subscribe`, `/confirm`, `/unsubscribe`, `ARCHIVE_BASE_PATH` (e.g. `/archive/*`, the archive index and post pages), `/media/*`, `/webhooks/*`, `/health`.

> `/dashboard` is load-bearing: the editor SPA lives there, so if it isn't in this application the editor ships ungated. Every authenticated route lives under `/api`, and a test holds that rule, so a new authoring route is gated by the same application automatically, with nothing to add on upgrade. The only public routes under `/api` are the dev routes (`/api/dev/token` hands out the local token), which exist only in a dev-shaped env and 404 once deployed, so gating `/api` wholesale is safe in production.
>
> Before 1.3.0, the authoring API also lived under `/posts`, `/sends`, `/subscribers`, and `/suppressions`, and the application listed those four paths too. Those paths now answer `404`, so an application that still lists them is harmless, and the paths can be removed.

## There is no backdoor to close

Local dev authenticates with a JWT signed by `DEV_AUTH_SECRET` (`src/auth/dev_token.ts`), which lives only in the gitignored `.dev.vars`, never in `wrangler.jsonc`. A deployed environment therefore has no value for it, and `getConfig` honors it *only* in a dev-shaped env (fake transport, **and** no Access configured, **and** `APP_ORIGIN` on `localhost` or `127.0.0.1`) anyway. The same predicate decides whether the dev-only `/api/dev/*` routes (token, seed, reset, outbox) exist at all; anywhere else they are 404. So there is nothing to unset: once you set `PROVIDER` to a real transport, configure Access, or serve the app from its real hostname, the dev credential path and the dev routes are structurally off and **Access is the only door**. Do not add `DEV_AUTH_SECRET` to any deployed environment's secrets, and never deploy the top-level (development) config itself: its `APP_ORIGIN` still names `localhost`, so it would count as local dev.

## Reach the API from a terminal

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
