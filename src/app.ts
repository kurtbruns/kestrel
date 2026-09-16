/**
 * Composition root: the route manifest, and the Router built from it.
 *
 * Every route is declared as data — a `RouteDef` — in one ordered array. Its
 * `access` field is where the public-vs-admin line is drawn: `admin` is gated by
 * `requireAuth`, `public`/`webhook` are open (a webhook is signature-verified in
 * its adapter). `createRouter` registers each def AND the same manifest drives the
 * generated `/api/reference` (see src/reference/), so the documented tier and the
 * enforced gate come from one field and cannot drift. No public entry point may
 * redirect or link into an admin path (SPEC §10).
 *
 * Order is significant: the router returns the first matching pattern, so the
 * archive `${archiveBasePath}/:slug`, `/media/:key(.*)`, and `/` routes keep their
 * relative positions. Keep new routes grouped with their tier.
 */

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
 * archive URL — see the archive route below and SPEC §10.
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
      // Dev-only bootstrap that hands out the local admin token, so it must be public
      // (there is no credential yet). 404s once deployed — see routes/dev.ts.
      method: "GET",
      path: "/api/dev/token",
      access: "public",
      summary: "Mint a local dev admin token. 404s once deployed (Access-only).",
      handler: devRoutes.token,
    },

    // --- operator setup guide (authed; read-only, bundled from docs/) ---
    // Under /api so the same Access application that gates the authoring API
    // gates these too, and the SPA's authed fetch reaches them (SPEC §5, §10).
    {
      method: "GET",
      path: "/api/docs",
      access: "admin",
      summary: "The operator setup guide as sanitized HTML fragments, in reading order (JSON).",
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
      handler: () => json({ groups: buildReference(r.routes.map((route) => route.def)) }),
    },

    // --- app settings (authed; runtime preferences, never secrets) ---
    {
      method: "GET",
      path: "/api/settings",
      access: "admin",
      summary: "Runtime preferences + a read-only reflection of deploy config (no secrets).",
      handler: settingsRoutes.get,
    },
    {
      method: "PUT",
      path: "/api/settings",
      access: "admin",
      summary: "Update runtime preferences (test recipients; the publication identity).",
      handler: settingsRoutes.update,
    },
    {
      method: "POST",
      path: "/api/settings/logo",
      access: "admin",
      summary: "Upload the publication logo (multipart `file`); served publicly via /media.",
      handler: settingsRoutes.uploadLogo,
    },
    {
      method: "DELETE",
      path: "/api/settings/logo",
      access: "admin",
      summary: "Remove the publication logo.",
      handler: settingsRoutes.deleteLogo,
    },
    {
      // Sends a SAMPLE issue through the SAVED template (the one render path, I5) so
      // the operator can see the template in a real inbox. It renders what will ship
      // — the stored template, never unsaved editor content — so the test is honest.
      method: "POST",
      path: "/api/settings/template/test",
      access: "admin",
      summary:
        "Send a sample issue through the saved email template, to `to` or the default recipients (I5).",
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
        request: { subject: "Issue #1: Hello", markdown: "# Hello\n\nWelcome." },
        response: {
          post: { id: "p_abc123", status: "draft", slug: "issue-1-hello" },
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
      summary: "One post with its current markdown and any active schedule.",
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
          subject: "Issue #1: Hello",
          slug: "issue-1-hello",
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
      summary: "Render current markdown to the email HTML (returns HTML + warnings).",
      handler: renderRoutes.preview,
    },
    {
      method: "GET",
      path: "/posts/:id/preview",
      access: "admin",
      summary: "The rendered email as a standalone HTML page (editor preview / open-in-browser).",
      handler: renderRoutes.previewPage,
    },
    {
      method: "POST",
      path: "/posts/:id/test",
      access: "admin",
      summary:
        "Send a test to one address through the same per-recipient path as a real send (I5).",
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
        "Freezes the current draft onto a send row and soft-locks the post; cancelable until it fires.",
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
        "List sends with delivery progress. Filter, sort, and paginate via query params; returns a `page` envelope.",
      query: [
        {
          name: "status",
          description: "Filter by status: `scheduled`, `sending`, `sent`, `canceled`, or `failed`.",
        },
        { name: "search", description: "Subject contains-search." },
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
        "One send: the frozen record, the delivery-outcome breakdown, and its archive URL (published once sent).",
      handler: sendRoutes.get,
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
      path: "/sends/:id/resolve",
      access: "admin",
      summary:
        "Resolve a send wedged on ambiguous (dispatched) deliveries; body {resolution: 'failed'|'accepted'}.",
      description:
        "On a non-idempotent provider a mid-batch transport error leaves recipients `dispatched` — the loop won't blind-retry them (I4), so the send can't reach its completion gate. This adjudicates those rows: 'failed' (assume not sent; the address is picked up by the next issue) or 'accepted' (assume sent, operator-confirmed), then completes the send. Never re-mails an already-accepted recipient.",
      example: {
        request: { resolution: "failed" },
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
    // Access-gated admin SPA at /dashboard (SPEC §10). Kept public here — the one
    // explicit non-admin surface.
    {
      method: "GET",
      path: "/",
      access: "public",
      summary:
        "The newsletter's public landing page: identity, the latest issue, and a subscribe call to action.",
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
    // Registered at ARCHIVE_BASE_PATH (default /archive) so the index, the issue
    // pages, and the emitted archive URLs always share one source. Self-contained by
    // default; an apex zone can additionally route <base>/* to this Worker (SPEC §10).
    // The index is registered before `:slug` so `/archive` resolves to the list, not
    // a slug lookup; the optional trailing slash (`{/}?`) means `/archive` and
    // `/archive/` both land on the index while `/archive/:slug` still serves issues.
    {
      method: "GET",
      path: `${archiveBasePath}{/}?`,
      access: "public",
      summary: "The public archive index: every sent issue, newest first.",
      handler: archiveRoutes.archiveIndex,
    },
    {
      method: "GET",
      path: `${archiveBasePath}/:slug`,
      access: "public",
      summary: "A frozen issue's archive page / view-in-browser (I3).",
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
