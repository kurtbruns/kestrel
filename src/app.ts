/**
 * Composition root: the route manifest, and the Router built from it.
 *
 * Every route is declared as data — a `RouteDef` — in one ordered array. Its
 * `access` field is where the public-vs-admin line is drawn: `admin` is gated by
 * `requireAuth`, `public`/`webhook` are open (a webhook is signature-verified in
 * its adapter). `createRouter` registers each def AND the same manifest drives the
 * generated `/api/reference` (see src/reference/), so the documented tier and the
 * enforced gate come from one field and cannot drift. No public entry point may
 * redirect or link into an admin path (SPEC §11).
 *
 * Order is significant: the router returns the first matching pattern, so the
 * archive `${archiveBasePath}/:slug`, `/media/:key(.*)`, and `/` routes keep their
 * relative positions. Keep new routes grouped with their tier.
 */

import type { ReferenceResponse } from "../shared/reference";
import { buildInfo } from "./build";
import { json } from "./lib/errors";
import { buildReference } from "./reference";
import { type RouteDef, Router } from "./router";
import * as archiveRoutes from "./routes/archive";
import * as devRoutes from "./routes/dev";
import * as docsRoutes from "./routes/docs";
import * as imageRoutes from "./routes/images";
import * as postRoutes from "./routes/posts";
import * as publicRoutes from "./routes/public";
import * as renderRoutes from "./routes/render_actions";
import * as scheduleRoutes from "./routes/schedule";
import * as sendRoutes from "./routes/sends";
import * as settingsRoutes from "./routes/settings";
import * as subscriberRoutes from "./routes/subscribers";
import * as suppressionRoutes from "./routes/suppressions";
import * as webhookRoutes from "./routes/webhooks";

/**
 * Build the router. `archiveBasePath` (from `ARCHIVE_BASE_PATH`, resolved in
 * `getConfig`) drives the archive route so it can't drift from the emitted
 * archive URL — see the archive route below and SPEC §11.
 */
export function createRouter(archiveBasePath: string): Router {
  const r = new Router();

  const manifest: RouteDef[] = [
    // --- system ---
    {
      method: "GET",
      path: "/health",
      access: "public",
      summary: "Liveness probe.",
      handler: () => json({ status: "ok", service: "kestrel" }),
    },
    {
      // Reports the authenticated principal and the auth mode, so the editor can show
      // identity (and offer Access sign-out) instead of prompting for a token.
      method: "GET",
      path: "/api/whoami",
      access: "admin",
      summary: "The authenticated principal and the auth mode (access or dev).",
      handler: (c) =>
        json({
          principal: c.principal,
          auth: { mode: c.config.accessTeamDomain ? "access" : "dev" },
        }),
    },
    {
      // The running build (SPEC §9), so an API client (Claude, curl) can self-identify a
      // bug report without opening the editor. Admin like the rest of /api/*; the same
      // stamp also rides the settings `deployment` reflection for the editor to show.
      // Not deploy config or a secret — resolved at build (src/build.ts), never from env.
      method: "GET",
      path: "/api/version",
      access: "admin",
      summary:
        "The running build: version, short SHA, release tag (if this build is one), build time, and repo links.",
      example: {
        response: {
          version: "0.1.0",
          sha: "a1b2c3d",
          tag: "v0.1.0",
          buildTime: "2026-01-15T09:00:00.000Z",
          repoUrl: "https://github.com/kurtbruns/kestrel",
          commitUrl: "https://github.com/kurtbruns/kestrel/commit/a1b2c3d",
          tagUrl: "https://github.com/kurtbruns/kestrel/releases/tag/v0.1.0",
        },
      },
      handler: () => json(buildInfo()),
    },
    {
      // Dev-only bootstrap that hands out the local admin token, so it must be public
      // (there is no credential yet). 404s once deployed — see routes/dev.ts.
      method: "GET",
      path: "/api/dev/token",
      access: "public",
      summary: "Mint a local dev admin token. 404s once deployed (Access-only).",
      handler: devRoutes.token,
    },

    // --- setup guide (authed; read-only, bundled from docs/) ---
    // Under /api so the same Access application that gates the authoring API
    // gates these too, and the SPA's authed fetch reaches them (SPEC §5, §11).
    {
      method: "GET",
      path: "/api/docs",
      access: "admin",
      summary: "The setup guide as sanitized HTML fragments, in reading order (JSON).",
      handler: docsRoutes.list,
    },

    // --- API reference (authed; generated from THIS manifest) ---
    {
      method: "GET",
      path: "/api/reference",
      access: "admin",
      summary: "Every route, generated from the registration so it can't drift.",
      // Returned as data (the SPA renders it natively as a sidebar plus sections, no iframe);
      // it's also a machine-readable listing of the surface for Claude and tooling.
      handler: () => {
        const body: ReferenceResponse = {
          groups: buildReference(r.routes.map((route) => route.def)),
        };
        return json(body);
      },
    },

    // --- app settings (authed; runtime preferences, never secrets) ---
    {
      method: "GET",
      path: "/api/settings",
      access: "admin",
      summary:
        "Runtime preferences, a read-only reflection of deploy config (no secrets), and `inUse`: the scheduled sends a template or identity change would re-make.",
      description:
        "`inUse.sends` is every scheduled send, soonest first; `inUse.retry_after` is the moment after which a save is no longer refused for the minimum lead (null when none is inside it); `inUse.identityFields` is the identity fields the current template renders, the only ones whose change reaches the email.",
      example: {
        response: {
          settings: { emailTemplate: "…", publication: { name: "Marsh Lane" } },
          deployment: { provider: "ses" },
          inUse: {
            sends: [
              {
                id: "s_xyz789",
                post_id: "p_abc123",
                subject: "Hello, world",
                fire_at: 1768467600000,
                remade_at: null,
              },
            ],
            retry_after: null,
            identityFields: ["name", "tagline", "logoUrl"],
          },
        },
      },
      handler: settingsRoutes.get,
    },
    {
      method: "PUT",
      path: "/api/settings",
      access: "admin",
      summary:
        "Update runtime preferences: test recipients, the publication identity, the email template, the confirmation email wording.",
      description:
        "Saving a changed template, or an identity field the template renders, re-makes every scheduled send's email at once (SPEC §6, §9), and is refused until the client acknowledges those sends by id in `remake` (409 `remake_required`, listing them) or while any of them is inside the minimum lead (409 `remake_too_close`, with `retry_after`); a save that leaves the email's inputs unchanged asks nothing. `GET /api/settings` lists them under `inUse` beforehand; the response's `remade` says what was re-made, and each of those sends then needs a fresh test.",
      example: {
        request: { emailTemplate: "<style>…</style>…", remake: ["s_xyz789"] },
        response: {
          settings: { emailTemplate: "…" },
          warnings: [],
          remade: [
            {
              id: "s_xyz789",
              post_id: "p_abc123",
              subject: "Hello, world",
              fire_at: 1768467600000,
              remade_at: 1768460000000,
            },
          ],
        },
      },
      handler: settingsRoutes.update,
    },
    {
      method: "POST",
      path: "/api/settings/logo",
      access: "admin",
      summary: "Upload the publication logo (multipart `file`); served publicly via /media.",
      description:
        "The logo is part of the identity, so when the template renders it and sends are scheduled this re-makes their emails under the same rule as `PUT /api/settings`, acknowledged as `?remake=` (comma-separated send ids) since the request carries no JSON body; the bytes are written only once the refusals are ruled out.",
      handler: settingsRoutes.uploadLogo,
    },
    {
      method: "DELETE",
      path: "/api/settings/logo",
      access: "admin",
      summary: "Remove the publication logo.",
      description:
        "Under the same re-make rule as `PUT /api/settings` when the template renders the logo and sends are scheduled: acknowledged as `?remake=` (comma-separated send ids), refused inside the minimum lead.",
      handler: settingsRoutes.deleteLogo,
    },
    {
      // Sends a SAMPLE post through the SAVED template (the one render path, I5) so
      // the operator can see the template in a real inbox. It renders what will ship
      // — the stored template, never unsaved editor content — so the test is honest.
      method: "POST",
      path: "/api/settings/template/test",
      access: "admin",
      summary:
        "Send a sample post through the saved email template, to `to` or the default recipients (I5).",
      description:
        "Renders the stored template, never unsaved editor content; saving first is the client's job, and that save may need the re-make acknowledgement (see `PUT /api/settings`).",
      example: {
        request: { to: "you@example.com" },
        response: { sent: 1, total: 1, provider: "fake", subject: "Template test — …" },
      },
      handler: renderRoutes.templateTest,
    },

    // --- posts + revisions (authed) ---
    {
      method: "POST",
      path: "/posts",
      access: "admin",
      summary: "Create a draft post.",
      example: {
        request: { subject: "Hello, world", markdown: "# Hello\n\nWelcome." },
        response: {
          post: { id: "p_abc123", status: "draft", slug: "hello-world" },
          revision_id: "r_1",
        },
      },
      handler: postRoutes.createPost,
    },
    {
      method: "GET",
      path: "/posts",
      access: "admin",
      summary:
        "List posts. Filter, sort, and paginate via query params; returns a `page` envelope.",
      query: [
        {
          name: "status",
          description:
            "Filter by status: `draft`, `scheduled`, or `sent`; a comma list (`draft,scheduled`) matches any.",
        },
        { name: "search", description: "Subject contains-search." },
        {
          name: "sort",
          description:
            "`updated` (default: scheduled-first, then newest edit), `title`, `status`, or `scheduled`.",
        },
        { name: "dir", description: "`asc` or `desc` (default `desc`)." },
        { name: "limit", description: "Page size (default 50, max 200)." },
        { name: "offset", description: "Rows to skip, for pagination." },
      ],
      handler: postRoutes.listPosts,
    },
    {
      method: "GET",
      path: "/posts/:id",
      access: "admin",
      summary:
        "One post with its current markdown and any active schedule; `scheduled.remade_at` says when a template or identity change last re-made its email.",
      handler: postRoutes.getPost,
    },
    {
      method: "PUT",
      path: "/posts/:id",
      access: "admin",
      summary:
        "Update a draft. Send `base_revision` (or If-Match) for optimistic concurrency (409 on conflict).",
      description:
        "Only a draft is editable; a scheduled post is soft-locked until its schedule is canceled.",
      example: {
        request: {
          subject: "Hello, world",
          slug: "hello-world",
          markdown: "# Hello\n\nEdited.",
          base_revision: "r_1",
        },
        response: { post: { id: "p_abc123", current_revision: "r_2", status: "draft" } },
      },
      handler: postRoutes.updatePost,
    },
    {
      method: "DELETE",
      path: "/posts/:id",
      access: "admin",
      summary: "Delete a draft and its revisions (drafts only).",
      handler: postRoutes.deletePost,
    },
    {
      method: "GET",
      path: "/posts/:id/revisions",
      access: "admin",
      summary: "The post's revision history.",
      handler: postRoutes.listRevisions,
    },
    {
      method: "GET",
      path: "/posts/:id/revisions/:n",
      access: "admin",
      summary: "One revision by its number.",
      handler: postRoutes.getRevision,
    },

    // --- images (authed upload/list/delete) ---
    {
      method: "POST",
      path: "/posts/:id/images",
      access: "admin",
      summary: "Upload an image to a post (multipart form field `file`).",
      handler: imageRoutes.uploadImage,
    },
    {
      method: "GET",
      path: "/posts/:id/images",
      access: "admin",
      summary: "List a post's images.",
      handler: imageRoutes.listImages,
    },
    {
      method: "DELETE",
      path: "/posts/:id/images/:filename",
      access: "admin",
      summary: "Delete one image from a post.",
      handler: imageRoutes.deleteImage,
    },

    // --- render: preview + test (authed); all go through the one render path ---
    {
      method: "POST",
      path: "/posts/:id/preview",
      access: "admin",
      summary:
        "Render the post to its email (returns the hosted URL, subject, warnings, and `frozen`).",
      description:
        "Once the post is scheduled this is its frozen copy, exactly as it will fire, and once sent the record's; a draft renders live (SPEC §5).",
      handler: renderRoutes.preview,
    },
    {
      method: "GET",
      path: "/posts/:id/preview",
      access: "admin",
      summary: "The rendered email as a standalone HTML page (editor preview / open-in-browser).",
      description:
        "Once the post is scheduled this is its frozen copy, exactly as it will fire, and once sent the record's; a draft renders live (SPEC §5).",
      handler: renderRoutes.previewPage,
    },
    {
      method: "POST",
      path: "/posts/:id/test",
      access: "admin",
      summary:
        "Send a test to one address through the same per-recipient path as a real send (I5).",
      description:
        "Once the post is scheduled this sends its frozen copy, exactly as it will fire, and once sent the record's; a draft's test is a live render (SPEC §5). The response's `frozen` says which.",
      example: {
        request: { to: "you@example.com" },
        response: {
          sent: true,
          provider: "ses",
          to: "you@example.com",
          subject: "Hello, world",
          warnings: [],
          frozen: true,
        },
      },
      handler: renderRoutes.test,
    },
    {
      method: "GET",
      path: "/api/dev/outbox",
      access: "admin",
      summary: "Inspect the fake transport's outbox (dev only).",
      handler: renderRoutes.devOutbox,
    },
    {
      // Load the local demo dataset (fake transport only; 404s on a real provider).
      method: "POST",
      path: "/api/dev/seed",
      access: "admin",
      summary: "Load the local demo dataset (fake transport only).",
      handler: devRoutes.seed,
    },
    {
      // Wipe the local database back to a fresh install (fake transport only).
      method: "POST",
      path: "/api/dev/reset",
      access: "admin",
      summary: "Reset the local database to a fresh install (fake transport only).",
      handler: devRoutes.reset,
    },

    // --- schedule / send / cancel (authed); freeze + soft-lock (M5) ---
    {
      method: "POST",
      path: "/posts/:id/schedule",
      access: "admin",
      summary: "Freeze the render and schedule the send for a future time (≥5 min out).",
      description:
        "Freezes the current draft, with the template and identity as they stand, onto a send row and soft-locks the post; cancelable until it fires. A later template or identity change re-makes that frozen email after the publisher confirms it (SPEC §6); there is no per-send template to name, and a `template_revision` field is a 400.",
      example: {
        request: { fire_at: "2026-01-15T09:00:00Z" },
        response: { send: { id: "s_xyz789", status: "scheduled", fire_at: 1768467600000 } },
      },
      handler: scheduleRoutes.schedule,
    },
    {
      method: "POST",
      path: "/posts/:id/send",
      access: "admin",
      summary:
        "Send now: freeze and schedule after a short cancelable buffer. Idempotent per post.",
      description:
        "The same freeze as scheduling, with the template and identity as they stand. For its five minutes the send is inside the minimum lead, so a template or identity save that would re-make it is refused until it has fired.",
      example: {
        response: { send: { id: "s_xyz789", status: "scheduled", fire_at: 1768467600000 } },
      },
      handler: scheduleRoutes.sendNow,
    },
    {
      method: "GET",
      path: "/sends",
      access: "admin",
      summary:
        "List sends with delivery progress. Filter, sort, and paginate via query params; returns a `page` envelope. A row's `remade_at` says when a template or identity change re-made it while scheduled.",
      query: [
        {
          name: "status",
          description: "Filter by status: `scheduled`, `sending`, `sent`, or `canceled`.",
        },
        { name: "search", description: "Subject contains-search." },
        {
          name: "failures",
          description:
            "`only` narrows to sends with a delivery failure (any bounced, complained, or unsent recipient).",
        },
        {
          name: "sort",
          description: "`fire` (default), `status`, `recipients`, or `subject`.",
        },
        { name: "dir", description: "`asc` or `desc` (default `desc`)." },
        { name: "limit", description: "Page size (default 50, max 200)." },
        { name: "offset", description: "Rows to skip, for pagination." },
      ],
      handler: sendRoutes.list,
    },
    {
      method: "GET",
      path: "/sends/:id",
      access: "admin",
      summary:
        "One send: the frozen record (re-made by a template or identity change only while scheduled, `remade_at`), the delivery-outcome breakdown, and its archive URL (published once sent).",
      handler: sendRoutes.get,
    },
    {
      method: "GET",
      path: "/sends/:id/progress",
      access: "admin",
      summary:
        "Live in-flight progress: a single-row read off the counters — dispatch/delivery bars, derived phase, and attention flags. The poll target for the watch view.",
      example: {
        response: {
          state: "sending",
          phase: "progressing",
          total: 1200,
          counts: {
            pending: 700,
            in_flight: 40,
            accepted: 455,
            delivered: 300,
            bounced: 3,
            complained: 1,
            skipped: 1,
            unsent: 0,
          },
          dispatch: { done: 460, percent: 38, rate_per_min: 920, eta_ms: 48000 },
          delivery: { confirmed: 304, percent_of_accepted: 40 },
          provider: { name: "fake" },
          attention: { wedged: false, wedged_count: 0, stuck: false, missed: false },
        },
      },
      handler: sendRoutes.progress,
    },
    {
      method: "GET",
      path: "/sends/:id/deliveries",
      access: "admin",
      summary:
        "The send's per-recipient delivery rows (JSON), filtered by outcome view and paginated; returns a `page` envelope. Reads the delivery rows directly (the source of truth), not the progress counters — heavier than `/progress`, so it is not a poll target.",
      query: [
        {
          name: "view",
          description:
            "`failures` (default: bounced/complained/unsent), `delivered`, `all`, or a single bucket (`bounced`, `complained`, `unsent`, `skipped`, `accepted`, `in_flight`).",
        },
        { name: "search", description: "Email contains-search." },
        { name: "sort", description: "`email` (default), `status`, `event`, or `updated`." },
        { name: "dir", description: "`asc` (default) or `desc`." },
        { name: "limit", description: "Page size (default 50, max 200)." },
        { name: "offset", description: "Rows to skip, for pagination." },
      ],
      example: {
        response: {
          deliveries: [
            {
              email: "bounce@example.com",
              status: "accepted",
              event: "bounced",
              event_detail: "Permanent/General",
              event_at: 1768467700000,
              error: null,
              attempts: 1,
              bounce_kind: "hard",
            },
          ],
          view: "failures",
          page: { total: 1, limit: 50, offset: 0, sort: "email", dir: "asc" },
        },
      },
      handler: sendRoutes.deliveries,
    },
    {
      method: "GET",
      path: "/sends/:id/deliveries.csv",
      access: "admin",
      summary: "The send's per-recipient delivery record as CSV (email, status, event, error).",
      handler: sendRoutes.deliveriesCsv,
    },
    {
      method: "POST",
      path: "/sends/:id/cancel",
      access: "admin",
      summary: "Cancel a scheduled send during its review window; unlocks the post.",
      handler: sendRoutes.cancel,
    },
    {
      method: "POST",
      path: "/sends/:id/reschedule",
      access: "admin",
      summary: "Move a scheduled send's fire time without re-freezing the render (I3, I6).",
      description:
        "Updates only `fire_at` on a still-`scheduled` send: the frozen render is untouched (the audience is resolved when the send fires) and the review window is preserved; a re-made send keeps its `remade_at`. Distinct from cancel → edit → schedule again, which is for content changes. Same minimum lead as scheduling.",
      example: {
        request: { fire_at: "2026-01-16T09:00:00Z" },
        response: { send: { id: "s_xyz789", status: "scheduled", fire_at: 1768554000000 } },
      },
      handler: sendRoutes.reschedule,
    },
    {
      method: "POST",
      path: "/sends/:id/resolve",
      access: "admin",
      summary:
        "Resolve a send wedged on ambiguous (dispatched) deliveries; body {resolution: 'unsent'|'accepted'}.",
      description:
        "On a non-idempotent provider a mid-batch transport error leaves recipients `dispatched` — the loop won't blind-retry them (I4), so the send can't reach its completion gate. This adjudicates those rows: 'unsent' (assume not sent; the address is picked up by the next post) or 'accepted' (assume sent, operator-confirmed), then completes the send. Never re-mails an already-accepted recipient.",
      example: {
        request: { resolution: "unsent" },
        response: { send: { id: "s_xyz789", status: "sent" }, resolved: 12, completed: true },
      },
      handler: sendRoutes.resolve,
    },

    // --- subscribers (authed admin) ---
    {
      method: "POST",
      path: "/subscribers",
      access: "admin",
      summary: "Add a subscriber via the normal double opt-in (never an auto-confirm).",
      handler: subscriberRoutes.create,
    },
    {
      method: "GET",
      path: "/subscribers",
      access: "admin",
      summary:
        "List subscribers with by-status counts. Filter, sort, and paginate via query params; returns a `page` envelope.",
      description:
        "Consent status and suppression are separate axes: `status` filters the roster; `suppressed` is an overlay facet. Pass `email` instead to look up one subscriber.",
      query: [
        {
          name: "status",
          description: "Filter by consent status: `pending`, `confirmed`, or `unsubscribed`.",
        },
        {
          name: "suppressed",
          description: "Suppression facet: `only` (suppressed addresses) or `hide` (exclude them).",
        },
        { name: "search", description: "Email contains-search." },
        { name: "sort", description: "`joined` (default), `confirmed`, `email`, or `status`." },
        { name: "dir", description: "`asc` or `desc` (default `desc`)." },
        { name: "limit", description: "Page size (default 50, max 200)." },
        { name: "offset", description: "Rows to skip, for pagination." },
        {
          name: "email",
          description: "Exact-match lookup of a single subscriber (bypasses the list).",
        },
      ],
      handler: subscriberRoutes.list,
    },
    {
      method: "GET",
      path: "/subscribers/:id",
      access: "admin",
      summary: "One subscriber.",
      handler: subscriberRoutes.get,
    },
    {
      method: "POST",
      path: "/subscribers/:id/unsubscribe",
      access: "admin",
      summary: "Unsubscribe a subscriber (admin-initiated).",
      handler: subscriberRoutes.unsubscribe,
    },

    // --- suppressions (authed admin) ---
    {
      method: "GET",
      path: "/suppressions",
      access: "admin",
      summary: "List suppressed addresses (bounced or complained, never mailed).",
      handler: suppressionRoutes.list,
    },
    {
      method: "POST",
      path: "/suppressions",
      access: "admin",
      summary: "Suppress an address manually.",
      handler: suppressionRoutes.add,
    },
    {
      method: "DELETE",
      path: "/suppressions/:email",
      access: "admin",
      summary: "Clear a suppression for an address.",
      handler: suppressionRoutes.clear,
    },

    // --- provider webhooks (public; signature-verified inside the adapter) ---
    {
      method: "POST",
      path: "/webhooks/ses",
      access: "webhook",
      summary: "SES/SNS bounce + complaint notifications (SNS-signature-verified in the adapter).",
      handler: webhookRoutes.ses,
    },

    // --- public reader routes (token-scoped; no login) ---
    // The front door: a self-contained landing page, never a bounce to the
    // Access-gated admin SPA at /dashboard (SPEC §11). Kept public here — the one
    // explicit non-admin surface.
    {
      method: "GET",
      path: "/",
      access: "public",
      summary:
        "The newsletter's public landing page: identity, the latest post, and a subscribe call to action.",
      handler: archiveRoutes.landing,
    },
    {
      method: "GET",
      path: "/subscribe",
      access: "public",
      summary: "The public subscribe form (HTML).",
      handler: publicRoutes.subscribeForm,
    },
    {
      method: "POST",
      path: "/subscribe",
      access: "public",
      summary: "Request a subscription; starts the double opt-in (confirmation email).",
      example: {
        request: { email: "you@example.com" },
        response: { status: "pending", action: "created" },
      },
      handler: publicRoutes.subscribe,
    },
    {
      method: "GET",
      path: "/confirm",
      access: "public",
      summary: "Confirm a subscription from the emailed link (`?token=`).",
      handler: publicRoutes.confirm,
    },
    {
      method: "GET",
      path: "/unsubscribe",
      access: "public",
      summary: "Unsubscribe landing page (`?token=`).",
      handler: publicRoutes.unsubscribeLanding,
    },
    {
      method: "POST",
      path: "/unsubscribe",
      access: "public",
      summary: "Process a one-click / form unsubscribe (`?token=`).",
      handler: publicRoutes.unsubscribe,
    },

    // --- delivery webhooks (public; provider-signature-verified, not requireAuth) ---
    {
      method: "POST",
      path: "/webhooks/resend",
      access: "webhook",
      summary: "Resend delivery + bounce + complaint events (signature-verified in the adapter).",
      handler: webhookRoutes.resend,
    },

    // --- archive / view-in-browser (public; serves the frozen record, I3) ---
    // Registered at ARCHIVE_BASE_PATH (default /archive) so the index, the post
    // pages, and the emitted archive URLs always share one source. Self-contained by
    // default; an apex zone can additionally route <base>/* to this Worker (SPEC §11).
    // The index is registered before `:slug` so `/archive` resolves to the list, not
    // a slug lookup; the optional trailing slash (`{/}?`) means `/archive` and
    // `/archive/` both land on the index while `/archive/:slug` still serves posts.
    {
      method: "GET",
      path: `${archiveBasePath}{/}?`,
      access: "public",
      summary: "The public archive index: every sent post, newest first.",
      handler: archiveRoutes.archiveIndex,
    },
    {
      method: "GET",
      path: `${archiveBasePath}/:slug`,
      access: "public",
      summary: "A frozen post's archive page / view-in-browser (I3).",
      handler: archiveRoutes.archivePage,
    },

    // --- media bytes (public; readers + archive load these unauthenticated) ---
    {
      method: "GET",
      path: "/media/:key(.*)",
      access: "public",
      summary: "Serve image bytes from storage (public; readers + archive load these).",
      handler: imageRoutes.serveMedia,
    },
  ];

  for (const def of manifest) {
    r.register(def);
  }

  return r;
}
