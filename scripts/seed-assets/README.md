# Seed assets

Static files used by the local demo seed (`npm run seed`). `scripts/seed.mjs`
uploads each through the running dev server, which stores it in local R2.

- **`kestrel.<ext>`** — the cover photo for the "The hovering hunter" sample post.
  `scripts/seed.mjs` looks for `kestrel.webp`, `.jpg`, `.jpeg`, `.png`, or `.gif`
  (in that order), uploads the first it finds, and the worker records the matching
  `images` row. WebP, PNG, GIF and JPEG all work — browsers render them all. If no
  `kestrel.*` is present the seed still runs; the post references the image, so
  dropping the file in and re-running `npm run seed` fills it in — but until then
  that one image 404s in the rendered post.
- **`windbreak-logo.png`** — the publication logo for the demo, 512 px square (a
  PNG, since the logo rides in every email and most email apps don't show SVG). Uploaded as the
  branding asset; the worker writes it to R2 and records the logo metadata, so the
  reader masthead and dashboard sidebar show it in place of the initial-letter tile.
  A full-bleed square: the corner rounding is the presentation layer's job (the
  logo tiles clip with `border-radius` + `overflow:hidden`), not baked into the
  asset. If it's absent the seed still runs; the tile just falls back to the initial.
