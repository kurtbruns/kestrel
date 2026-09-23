# Wire the archive to a website

Every post has a permanent archive URL — its "view in browser" link and every shared link (`docs/SPEC.md` §5, I3). Where that URL lives is a choice. The default requires nothing; anchoring it to your main domain is an optional enhancement. Why permanence favors your most durable name is `docs/SPEC.md` §11.

## The self-contained default — nothing to do

Out of the box, `ARCHIVE_ORIGIN` defaults to `APP_ORIGIN` and `MEDIA_PUBLIC_BASE` to `${APP_ORIGIN}/media` (resolved in `src/env.ts`). So archive URLs are `https://newsletter.example.com/archive/{slug}` and images serve from the Worker's own origin. A newsletter works end to end whether or not you have a separate website, and wherever that website is hosted. If that is fine, skip this section.

## Optional — surface the archive on your website's apex

If your website's apex is a **Cloudflare** zone, you can present the archive under your main domain — `example.com/archive/*` — so links carry your primary domain's trust and rank with the rest of your site.

This is a routing concern on the apex zone, not a second app:

1. On the **apex zone**, add a **Worker route** `example.com/archive/*` pointing at this same Worker. The most-specific route wins, so the static site keeps every other path.
2. Set `ARCHIVE_ORIGIN` to the apex so emitted links use it:

   ```jsonc
   // wrangler.jsonc → env.production.vars
   "ARCHIVE_ORIGIN": "https://example.com",
   "ARCHIVE_BASE_PATH": "/archive"
   ```

3. **Pick a base path that doesn't collide.** `ARCHIVE_BASE_PATH` drives *both* the emitted URL and the route the Worker serves (`createRouter(basePath)` in `src/app.ts`), so the two can never drift. Choose a prefix your site does not already use for a real page — `/archive` (the default), `/newsletter`, `/issues` — and set the same value in the Worker route in step 1.

> **Pages-vs-Worker-route precedence caveat.** If the apex is served by Cloudflare **Pages**, a Worker route and the Pages project can both match a path. A Worker route takes precedence over Pages for the paths it matches, but confirm it: after adding the route, load `https://example.com/archive/<a-sent-slug>` and check it serves the post (the Worker), not a Pages 404. Make sure the base path does not shadow a real page or a Pages Function you depend on.

The app origin itself stays on `newsletter.example.com` — only the *archive URL* moves to the apex. The admin editor, the API, and the public subscribe/confirm/unsubscribe pages remain on the app's own hostname.

## If your site is not on Cloudflare

You cannot attach a Worker route to a zone Cloudflare does not control, so:

- **Reverse proxy** (keeps the apex benefit): configure your host to forward `example.com/archive/*` to `https://newsletter.example.com/archive/*`, and set `ARCHIVE_ORIGIN` to `https://example.com`. The reader's address bar stays on the apex.
- **Redirect** (simplest, but forfeits the benefit): a `301` from `example.com/archive/*` to the app. Trivial to set up, but it sends the reader's address bar back to the app host, so links no longer read as your apex.

When neither fits cleanly, stay self-contained — the archive on `newsletter.example.com` is a first-class home, not a fallback.

## Optional — a `media.` custom domain for images

By default images serve from the Worker's `/media` route. To serve them from a dedicated host instead, connect a **custom domain** to the R2 `MEDIA` bucket (R2 → your bucket → Settings → Custom Domains) and point `MEDIA_PUBLIC_BASE` at it:

```jsonc
// wrangler.jsonc → env.production.vars
"MEDIA_PUBLIC_BASE": "https://media.example.com"
```

New renders then resolve image URLs to that host. This is purely cosmetic/CDN convenience; the self-contained default is fully functional without it.
