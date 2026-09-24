# Connect Claude to the API

This page covers connecting Claude Code to a deployed Kestrel instance. Once connected, Claude can draft, edit, and proofread your posts, and schedule them to send. It works the same way you would in the editor, through the same API: the editor and Claude are the **two clients** of that one door, and neither reaches past it — so there is nothing new to secure or keep in sync. A scheduled post waits in a cancelable window before it goes out, so you can review it or call it off before it reaches anyone.

## Claude is a `service` principal

The app resolves every request to a `Principal`: a **human** (carries an email — your interactive login) or a **service** (Claude / automation — no email). Claude authenticates with an Access **service token**, which carries no email, so it arrives as `service`. Its edits are attributed as "Claude" — distinct from your human login — in the revision trail and the editor's concurrency notices. Nothing else changes: same routes, same gate.

Local development uses a dev-signed token instead of Access; see the README's *Auth* section for that path. Everything below is the deployed instance.

## 1. Create a service token

You already configured one Cloudflare Access application to gate the admin surface during **Access — the admin gate**. Add a **Service Auth** policy to that same application, then create a **service token** under **Access → Service Auth**. It yields a `CF-Access-Client-Id` and a `CF-Access-Client-Secret`. Service tokens need no browser handshake and don't consume Zero Trust seats.

Do not create a second Access application — the service token must share the AUD your Worker already verifies.

### Prefer infrastructure-as-code?

Create the token from the Cloudflare API instead of the dashboard — reproducible across staging and production, and scriptable into a provisioning step:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/access/service_tokens" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"claude-code"}'
```

`$CF_API_TOKEN` is a one-off Cloudflare API token with the **Access: Service Tokens Write** permission (not a runtime credential — it only creates the service token). The response returns `client_id` and `client_secret`; the secret is shown **once**. Terraform users can express the same thing as a `cloudflare_zero_trust_access_service_token` resource. Either way you still add the Service Auth policy above, so the token is accepted.

## 2. Store the credentials

Claude Code reads the base URL and the token from its shell environment. Keep them in a gitignored file, never in the repo. Copy the committed template and fill it in:

```bash
cp .kestrel.env.example .kestrel.env
```

```bash
# .kestrel.env  (gitignored)
KESTREL_URL="https://newsletter.example.com"
CF_ACCESS_CLIENT_ID="<client-id>"
CF_ACCESS_CLIENT_SECRET="<client-secret>"
```

The file lives on your machine but points at your **deployed** instance — it isn't local-dev config (that's `.dev.vars`, which the Worker itself reads). The values here are presented by the client to Cloudflare Access; the Worker never reads them. Load it into your shell before driving the API:

```bash
set -a; source .kestrel.env; set +a
```

**Using Claude Code?** You can instead put the same three keys in your gitignored `.claude/settings.local.json` under an `env` block, and Claude Code injects them into every session automatically — no file to source:

```json
{
  "env": {
    "KESTREL_URL": "https://newsletter.example.com",
    "CF_ACCESS_CLIENT_ID": "<client-id>",
    "CF_ACCESS_CLIENT_SECRET": "<client-secret>"
  }
}
```

Never use the shared `.claude/settings.json` for the secret — it's committed. `.claude/settings.local.json` is kept out of git.

## 3. Verify the credential resolves to `service`

With the values loaded, check the identity the app resolves:

```bash
curl -s "$KESTREL_URL/api/whoami" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

Expect `{"principal":{"kind":"service"},"auth":{"mode":"access"}}`. The `"kind":"service"` (not `"human"`) confirms Claude will be attributed as Claude, not as you. A `401` from a plain request with no headers confirms the surface is closed.

## 4. Point Claude Code at the API

Kestrel ships no separate MCP server — Claude Code is a client of the HTTP API itself. Give it a one-line wrapper that carries the headers on every call:

```bash
kctl() { curl -s -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" "$KESTREL_URL$1" "${@:2}"; }
```

A call that sends a body names its type, and each route takes only the types the reference lists for it; a JSON body sent without `Content-Type: application/json` is refused. For example, to add a subscriber:

```bash
kctl /subscribers -X POST -H "Content-Type: application/json" -d '{"email":"reader@example.com"}'
```

Then tell Claude the base URL and that `GET /api/reference` lists every route — method, path, access tier, the body types it accepts, and worked examples, generated from the route registration so it can't drift. Claude discovers and drives the whole app from there.

## 5. Keep the credential healthy

- Set an **expiration** and the one-week-before **alert** on the token.
- **Rotate** with a grace period: the Client ID stays, a new secret is issued, and both work for the overlap you choose — do it routinely and on any suspected exposure.
- Never commit the secret. If one leaks, revoke it in the dashboard.

> Connecting **Claude Desktop** with a one-click MCP connector — instead of a hand-pasted service token — is a deferred enhancement tracked separately. This page covers Claude Code today.
