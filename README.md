# Kestrel

Kestrel is a newsletter app you run yourself on Cloudflare. You write a post in Markdown, preview it exactly as the email, and send it to a double-opt-in list. The list, the consent, the record of every send, and a permanent archive of every post stay with you. Bring an existing list in, and take the whole list out, in one documented format. Write in the editor by hand, or with Claude through the same API.

See [getkestrel.dev](https://getkestrel.dev) to learn more about Kestrel.

## Try it locally

You can run Kestrel on your own computer to look around, with [Node.js](https://nodejs.org/) 22 or later. It needs no Cloudflare account, and email goes to a stand-in, so nothing reaches a real inbox.

In an empty folder, write a new instance and install it:

```bash
npx @kurtbruns/kestrel init
npm install
```

Copy the local settings, and start the app:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

The first time, it asks you to confirm the local database's migrations. Then open http://localhost:8787/dashboard/, with nothing to sign in with. If port 8787 is taken, the `Ready on` line shows the one it picked.

In a second terminal, load a demo publication with posts, subscribers, and past sends, or empty it again:

```bash
npm run seed
npm run reset
```

When you're ready to deploy, this folder can be your instance's repository. Push it to an empty GitHub repository, then follow [Deploy the app](docs/get-started/02-deploy.md#2-sign-in-to-cloudflare) from signing in to Cloudflare.

## Run your own

Kestrel installs from npm as [`@kurtbruns/kestrel`](https://www.npmjs.com/package/@kurtbruns/kestrel). Your instance lives in a small repository of your own, which holds its settings and names the release it runs. [Get started](docs/README.md#get-started) takes you from an empty repository to a live newsletter, and [Upgrade to a new release](docs/guides/07-upgrade.md) moves an instance to a newer one.

The docs are two sets, one per job. [Self-hosting](docs/README.md) is for whoever deploys and runs Kestrel. [Publishing](docs/publishing/README.md) is for whoever writes and sends the newsletter. Both are in the editor's **Docs** tab, and an instance serves every page as Markdown for Claude to read.

## Contributing

To work on Kestrel's own source, see [CONTRIBUTING.md](CONTRIBUTING.md). Releases are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

Kestrel is open source under the [MIT License](LICENSE). Copyright (c) 2026 Kurt Bruns.
