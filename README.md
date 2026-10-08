# Kestrel

Kestrel is a newsletter app you run yourself on Cloudflare. You write a post in Markdown, preview it exactly as the email, and send it to a double-opt-in list. The list, the consent, the record of every send, and a permanent archive of every post stay with you. Write in the editor by hand, or with Claude through the same API.

See [getkestrel.dev](https://getkestrel.dev) to learn more about Kestrel. This README gets a copy running on your computer. To deploy your own instance, follow [Get started](docs/get-started/01-overview.md).

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or later.

## Local setup

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

- **Deploy your own instance:** [Get started](docs/get-started/01-overview.md), the steps from a fresh clone to a live newsletter. The same guide is in the editor's **Docs** tab.
- **What Kestrel guarantees:** [`docs/SPEC.md`](docs/SPEC.md). How the admin UI is built: [`docs/DESIGN.md`](docs/DESIGN.md).
- **Working on the code:** [`.claude/rules/code.md`](.claude/rules/code.md) has the commands, conventions, and module boundaries. To contribute, turn on the [maintainer context](.claude/maintainer/README.md) first.
- **Releases:** [`CHANGELOG.md`](CHANGELOG.md), and [Upgrade to a new release](docs/guides/07-upgrade.md) to move an instance to one.

## License

Kestrel is open source under the [MIT License](LICENSE). Copyright (c) 2026 Kurt Bruns.
