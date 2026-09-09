# Seed assets

Static files used by the local demo seed (`npm run seed`).

- **`kestrel.<ext>`** — the cover photo for the "The hovering hunter" sample issue.
  `scripts/seed.mjs` looks for `kestrel.webp`, `.jpg`, `.jpeg`, `.png`, or `.gif`
  (in that order), uploads the first it finds through the running dev server, which
  stores it in local R2 with the right content type and records the matching
  `images` row. WebP, PNG, GIF and JPEG all work — browsers render them all.

If no `kestrel.*` file is present, the seed still runs — the issue references the
image, so dropping the file in and re-running `npm run seed` fills it in — but until
then that one image will 404 in the rendered issue.
