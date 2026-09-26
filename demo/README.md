# The demo publication

Everything `npm run seed` loads into a local dev server, apart from the subscribers and send history, lives here. Edit these files and run `npm run seed` again to see the change.

- **`publication.md`**: the identity, as front matter only.
- **`posts/`**: one folder per post, a page bundle: the post is `index.md`, and any image it shows sits beside it (`1-the-hovering-hunter/kestrel.webp`). The post refers to the image by its filename, as in `![…](kestrel.webp)`, so the link resolves when you preview the Markdown, and the seed attaches the file to that post. The number in a folder's name sets its place: sent posts go out oldest first in that order, and a post's id (and so its editor URL) follows its position.
- **`field-notes-logo.png`**: the publication logo, named by `publication.md`.

The worker bundles the Markdown files (the `rules` entry in `wrangler.jsonc`) and parses them in `src/dev/demo.ts`, which lists each post's folder; add a post by adding its folder and one line there. `npm run dev` watches this folder, so an edit here is in the next seed. `scripts/seed.mjs` uploads the images through the running dev server, which stores them in local R2. The subscribers, the four completed sends, and the scheduled send's fire time come from the timeline in `src/dev/seed.ts`.

## Front matter

Every file opens with `key: value` lines between `---` markers. An unknown or repeated key, a missing required key, or a post with no body stops the seed with the file's name.

`publication.md`:

| Key | Required | What it sets |
|---|---|---|
| `name` | yes | The publication name. |
| `tagline` | yes | The tagline under the name. |
| `test_recipients` | yes | The default test inboxes, comma-separated. Keep them on `.example` so a test can never reach a real inbox. |
| `address` | no | The mailing address in the email footer. |
| `logo` | no | The logo file in this folder. |

A post:

| Key | Required | What it sets |
|---|---|---|
| `subject` | yes | The subject line, which is also the post's title in the list. |
| `slug` | yes | The post's path in the archive. |
| `status` | yes | `sent`, `scheduled`, or `draft`. The seed timeline has four completed sends, so at most four posts can be `sent`. |
| `edited` | no | Drafts only: when the draft was last edited, as `2 days ago`. |

## The images

- **`field-notes-logo.png`**: 512 px square, full bleed. A PNG, since the logo rides in every email and most email apps don't show SVG. Leave the corners square; the app rounds them. If it's missing, the seed still runs and the tile falls back to the initial.
- **`posts/1-the-hovering-hunter/kestrel.webp`**: a male Canarian kestrel in flight, by u/treecreaper on Reddit (credited in the post's caption). WebP, PNG, GIF, and JPEG all work. If it's missing, the seed still runs, but that one image 404s in the post until the file is back.
