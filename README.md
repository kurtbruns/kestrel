# Kestrel

Kestrel is an open-source newsletter app you run yourself, on Cloudflare and Amazon SES. You own the list, the proof each reader opted in, the record of every send, and a permanent archive of every post.

You write in Markdown, preview the exact email, and schedule it with a window to cancel. Bring your list from another service, and take it out whenever you like. Work in the editor, or ask Claude to do it through the same API, from Claude Code, Claude Desktop, or claude.ai.

See [getkestrel.dev](https://getkestrel.dev) to learn more about Kestrel.

## Try it locally

You can run Kestrel on your own computer to look around, with [Node.js](https://nodejs.org/) 22 or later. It needs no Cloudflare account, and email goes to a stand-in, so nothing reaches a real inbox.

In an empty folder, write a new instance and install it:

```bash
npx kestrel init
npm install
```

Copy the local settings, and start the app:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

The first time, it asks you to confirm the local database's migrations. Then open http://localhost:8787/dashboard/, with nothing to sign in with. If port 8787 is taken, the `Ready on` line shows the one it picked.

In a second terminal, load a demo publication with posts, subscribers, and past sends:

```bash
npm run seed
```

To start over, reset the app to the state a new instance starts in: no posts, subscribers, or settings, with the first-run dashboard and its setup checklist:

```bash
npm run reset
```

When you're ready to deploy your own instance, see the [setup guide](https://getkestrel.dev/docs/), which contains instructions for deploying and running Kestrel.

## Contributing

To work on Kestrel's own source, see [CONTRIBUTING.md](CONTRIBUTING.md). Releases are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

Kestrel is open source under the [MIT License](LICENSE). Copyright (c) 2026 Kurt Bruns.
