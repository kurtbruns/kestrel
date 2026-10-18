# Contributing to Kestrel

This repository is Kestrel's source. To run your own newsletter, you don't need it: the [README](README.md) shows how to try Kestrel and deploy an instance from npm.

## Run the source

With [Node.js](https://nodejs.org/) 22 or later:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open the editor at http://localhost:8787/dashboard/. There's nothing to sign in with locally, and email goes to a stand-in that never reaches a real inbox. `.dev.vars.example` explains each local setting, including how the stand-in mimics SES on a send.

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

- **What Kestrel guarantees:** [`docs/SPEC.md`](docs/SPEC.md). The rules every API route follows: [`docs/API.md`](docs/API.md). How the admin UI is built: [`docs/DESIGN.md`](docs/DESIGN.md).
- **Working on the code:** [`.claude/CLAUDE.md`](.claude/CLAUDE.md) has the commands, conventions, and module boundaries.
- **Releases:** [`CHANGELOG.md`](CHANGELOG.md).
