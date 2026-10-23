# kestrel

The command-line client for [Kestrel](https://getkestrel.dev), an open-source, self-hosted newsletter app on Cloudflare Workers. It signs you in to a Kestrel instance and calls its API as you, from any folder, so Claude Code or your own scripts can work with your newsletter. It needs Node.js 22 or later.

```bash
npx kestrel login https://newsletter.example.com
npx kestrel api GET /api/posts
npx kestrel api --list
```

`login` signs you in through your instance's Cloudflare Access, in your browser, and keeps the sign-in in your user config. `api` calls a route as you, and `api --list` and `api help <method> <path>` describe the routes, read from the instance's own OpenAPI document so they match the release it runs. `logout` forgets the sign-in.

To start a new instance, run `npx kestrel init` in an empty folder. It writes the instance's repository from the `@kurtbruns/kestrel` package, which the instance installs and pins. The commands that act on that repository (`dev`, `seed`, `reset`, `sync-migrations`, and `check-context`) run from that install, through its npm scripts.

The setup guide and the publisher's docs are at [getkestrel.dev](https://getkestrel.dev). Kestrel's source is at [github.com/kurtbruns/kestrel](https://github.com/kurtbruns/kestrel).

Thanks to Mihai (matomesc) and Shane (vandesm14) for passing on the kestrel name. `kestrel@0.0.1` is their earlier, unrelated project.
