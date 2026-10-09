# Kestrel

Kestrel is a newsletter app you run yourself on Cloudflare. You write a post in Markdown, preview it exactly as the email, and send it to a double-opt-in list. The list, the consent, the record of every send, and a permanent archive of every post stay with you. Write in the editor by hand, or with Claude through the same API.

See [getkestrel.dev](https://getkestrel.dev) to learn more about Kestrel.

## Run your own

Kestrel installs from npm as [`@kurtbruns/kestrel`](https://www.npmjs.com/package/@kurtbruns/kestrel). Your instance lives in a small repository of your own, which holds its settings and names the release it runs:

```bash
npx @kurtbruns/kestrel init
```

[Get started](docs/get-started/01-overview.md) takes you from an empty repository to a live newsletter, and [Upgrade to a new release](docs/guides/07-upgrade.md) moves an instance to a newer one. The same guide is in the editor's **Docs** tab.

## Work on Kestrel

This repository is Kestrel's source. To run it on your computer, with [Node.js](https://nodejs.org/) 22 or later:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open the editor at http://localhost:8787/dashboard/. There's nothing to sign in with locally, and email goes to a stand-in that never reaches a real inbox. `.dev.vars.example` explains each local setting, including how the stand-in mimics Resend or SES on a send.

### Demo data

The app starts empty. To explore it with content, load **Field Notes**, a demo publication kept as Markdown in [`demo/`](demo/):

```bash
npm run seed                          # load the demo
npm run simulate-send -- --in 90s     # schedule a send and print a link to watch it go out
npm run reset                         # back to an empty instance
```

### Calling the API

The editor is one client of Kestrel's HTTP API, and Claude is the other. Locally, mint a token to call it yourself:

```bash
TOKEN=$(curl -s http://localhost:8787/api/dev/token?kind=service | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/api/posts
```

The editor's **API** tab lists every route.

## Going further

- **What Kestrel guarantees:** [`docs/SPEC.md`](docs/SPEC.md). How the admin UI is built: [`docs/DESIGN.md`](docs/DESIGN.md).
- **Working on the code:** [`.claude/CLAUDE.md`](.claude/CLAUDE.md) has the commands, conventions, and module boundaries.
- **Releases:** [`CHANGELOG.md`](CHANGELOG.md).

## License

Kestrel is open source under the [MIT License](LICENSE). Copyright (c) 2026 Kurt Bruns.
