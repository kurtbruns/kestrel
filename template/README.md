# Newsletter

This repository is a [Kestrel](https://getkestrel.dev) instance: a newsletter running on your Cloudflare account. It holds the instance's configuration (`wrangler.jsonc`), its database migrations (`migrations/`), and the Kestrel release it runs, pinned in `package.json`. Kestrel itself comes from the `@kurtbruns/kestrel` package.

The setup guide for the installed release is in `node_modules/@kurtbruns/kestrel/docs/` after `npm install`, and in the editor's **Docs** tab.

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

Open the editor at http://localhost:8787/dashboard/. Email goes to a stand-in that never reaches a real inbox. `npm run seed` loads a demo publication, and `npm run reset` empties it again.

## Commands

| Command | What it does |
| :- | :- |
| `npm run dev` | Runs the app locally, with the send sweep once a minute |
| `npm run seed`, `npm run reset` | Loads the demo publication into the local app, or empties it |
| `npm run sync-migrations` | Copies the installed release's migrations into `migrations/` |
| `npm run check-context` | Compares the Claude files in `.claude/` with the installed release's |
| `npx wrangler deploy --env production` | Deploys the instance |
| `npx wrangler d1 migrations apply DB --remote --env production` | Applies new migrations to the production database |

Your own migrations go in `migrations/` with a `local_` name, such as `local_0001_add_index.sql`, so they never collide with Kestrel's.
