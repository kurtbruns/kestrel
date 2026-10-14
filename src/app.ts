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
 *
 * The `/api/dev/*` routes are registered only when `devMode` holds, so a deployed env
 * has no such routes at all (a 404 by absence, not by check) and its reference omits them.
 */

import { IMPORT_LIMITS } from "../shared/imports";
import type { ReferenceResponse } from "../shared/reference";
import {
  BOUNCE_SPIKE_MIN,
  BOUNCE_SPIKE_RATE,
  BOUNCE_SPIKE_RECENT_MS,
  DAILY_WRITES_SEND_RECIPIENTS,
  formatLead,
  MIN_LEAD_FLOOR_MS,
  STUCK_THRESHOLD_MS,
} from "../shared/sends";
import { buildInfo } from "./build";
import type { Config } from "./env";
import { json } from "./lib/errors";
import { RASTER_IMAGE_TYPES } from "./lib/image_types";
import { HALT_BACKOFF_MS, MISSED_THRESHOLD_MS } from "./lib/time";
import { unwrap } from "./lib/unwrap";
import { buildReference } from "./reference";
import { type RouteDef, Router } from "./router";
import * as archiveRoutes from "./routes/archive";
import * as devRoutes from "./routes/dev";
import * as docsRoutes from "./routes/docs";
import * as imageRoutes from "./routes/images";
import * as importRoutes from "./routes/imports";
import * as postRoutes from "./routes/posts";
import * as publicRoutes from "./routes/public";
import * as readerPageRoutes from "./routes/reader_pages";
import * as renderRoutes from "./routes/render_actions";
import * as scheduleRoutes from "./routes/schedule";
import * as sendRoutes from "./routes/sends";
import * as settingsRoutes from "./routes/settings";
import * as subscriberRoutes from "./routes/subscribers";
import * as suppressionRoutes from "./routes/suppressions";
import * as webhookRoutes from "./routes/webhooks";
import { SETTLE_FOLLOW_MS } from "./send/feed";

// The body types a route declares (`RouteDef.accepts`); a raw upload adds its own.
const JSON_BODY = ["application/json"];
const FORM_UPLOAD = ["multipart/form-data"];

/** A halt's retry schedule in words for the reference, read off `HALT_BACKOFF_MS` so the
 *  two can't drift: "after 1, 2, and 5 minutes and then every 15 minutes". */
function retrySchedule(steps: readonly number[]): string {
  const minutes = steps.map((ms) => ms / 60_000);
  const last = minutes.pop();
  const head =
    minutes.length > 1
      ? `${minutes.slice(0, -1).join(", ")}, and ${minutes.at(-1)}`
      : `${minutes[0]}`;
  return `after ${head} minutes and then every ${last} minutes`;
}

/**
 * Whether a path belongs to the reader surface, for the answers given in its own form rather
 * than the API's JSON: the refusal given before any route is matched, while deploy config is
 * refused or the database is behind the release (SPEC §9), and the page for an error nothing
 * handled on a reader route (SPEC §12). The paths a reader never opens keep their JSON: the API (the admin surface, which
 * names the setting to fix, and the dev tooling), the liveness probe, and the provider
 * webhooks. Every other path, a reader route below or no route at all, is a page a person
 * may have opened, so it gets a page that names nothing.
 */
export function isReaderPath(pathname: string): boolean {
  return !(
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname.startsWith("/webhooks/")
  );
}

/**
 * Build the router. `archiveBasePath` (from `ARCHIVE_BASE_PATH`, resolved in
 * `getConfig`) drives the archive route so it can't drift from the emitted
 * archive URL (see the archive route below and SPEC §11); `devMode` decides whether
 * the dev routes exist; `minLeadMs` is the minimum lead the reference states on the
 * routes that enforce it, so Claude reads it there rather than from its first 400.
 */
export function createRouter({
  archiveBasePath,
  devMode,
  minLeadMs,
}: Pick<Config, "archiveBasePath" | "devMode" | "minLeadMs">): Router {
  /** The given routes in a dev-shaped env, none anywhere else. */
  const devOnly = (...defs: RouteDef[]): RouteDef[] => (devMode ? defs : []);
  /** The minimum lead as the reference states it: this deployment's value and the floor. */
  const lead = `${formatLead(minLeadMs)} on this deployment (\`deployment.minLeadMs\` in \`GET /api/settings\`); a deployment sets it with \`MIN_LEAD_SECONDS\`, never below ${formatLead(MIN_LEAD_FLOOR_MS)}`;
  // What every send route says of conditions and actions: one server rule, one wording.
  const conditionsText = `\`conditions\` is what is wrong with the send, or worth knowing, now (SPEC §8, §12), derived by the server from the send and the same on every route, most severe first: \`missed\` (still scheduled ${MISSED_THRESHOLD_MS / 60_000} minutes past its fire time: the sweep is not running), \`stuck\` (still sending ${STUCK_THRESHOLD_MS / 60_000} minutes after it started, whatever the cause), \`wedged\` (\`count\` recipients whose delivery is unknown, settled by Resolve), \`refused\` (the provider refusing the account, with its \`cause\`, its own words as \`error\`, the \`advice\` for the fix, which is outside this API, and \`retry_at\`; the send resumes on its own once the account is fixed, having consumed no one), \`provider_unavailable\` (an outage or a rate limit, retried on its own at \`retry_at\`), \`bounce_spike\` (a send finished within ${BOUNCE_SPIKE_RECENT_MS / 86_400_000} days whose confirmed bounces reached ${BOUNCE_SPIKE_RATE * 100}% of its audience at fire, at least ${BOUNCE_SPIKE_MIN}; \`bounced\` and \`rate\`), \`remade\` (a template or identity change re-made the scheduled email after its last test, \`tested_at\`; a test of the post clears it), and \`daily_writes\` (on the Workers Free plan's limits, a scheduled send to more than ${DAILY_WRITES_SEND_RECIPIENTS.toLocaleString("en-US")} recipients, or to fewer when imports already wrote on the UTC day it fires, which may spend D1's daily allowance of written rows and stop the instance until midnight UTC; \`recipients\`; a warning, never a refusal). Each has a \`severity\` (\`action\`: a person must act; \`warn\`: worth a look; \`info\`), \`since\` (null when the record does not say), a \`message\` to show or relay as it stands, and the \`action\` that settles it, if any. \`actions\` is exactly what the server would accept on the send now, each \`{name, method, path}\`: \`cancel\` and \`reschedule\` while it is scheduled and its fire time is still ahead, \`resolve\` while it is wedged.`;
  // What every route that would send says while the deployment has no provider: one code.
  const notConnected =
    "Refused with 409 `provider_not_connected` while no email provider is connected (SPEC §9), since nothing can be sent.";
  const actionText =
    "An act carries no precondition on the send you read: it applies to the send as it stands, within the rules above, and the answer shows the result. An `If-Match` header is ignored. Every refusal carries the send as it stands in `send`, in the `GET /api/sends` row shape.";
  // One send as every send route carries it, for the examples.
  const sendExample = (over: Record<string, unknown> = {}) => ({
    id: "s_xyz789",
    post_id: "p_abc123",
    subject: "Spring migration",
    status: "sending",
    rev: 57,
    as_of: 1768467610000,
    fire_at: 1768467600000,
    scheduled_at: 1768381200000,
    started_at: 1768467601000,
    completed_at: null,
    remade_at: null,
    tested_at: 1768390000000,
    audience: { count: 1200, fixed: true, fixed_at: 1768467601000 },
    counts: {
      pending: 700,
      in_flight: 40,
      accepted: 455,
      delivered: 0,
      bounced: 3,
      complained: 1,
      skipped: 1,
      unsent: 0,
    },
    dispatch: { done: 460, percent: 38, rate_per_min: 230, eta_ms: 185000 },
    delivery: { confirmed: 4, percent_of_accepted: 1 },
    provider: { name: "ses", halt: null },
    phase: "progressing",
    conditions: [],
    actions: [],
    next_change_at: 1768467610000,
    links: {
      self: "/api/sends/s_xyz789",
      email_html: "/api/sends/s_xyz789/email?format=html",
      email_text: "/api/sends/s_xyz789/email?format=text",
      deliveries: "/api/sends/s_xyz789/deliveries",
      deliveries_csv: "/api/sends/s_xyz789/deliveries.csv",
      post: "/api/posts/p_abc123",
      archive: null,
    },
    ...over,
  });
  const scheduledExample = sendExample({
    status: "scheduled",
    fire_at: 1768554000000,
    started_at: null,
    audience: { count: 1200, fixed: false, fixed_at: null },
    counts: {
      pending: 0,
      in_flight: 0,
      accepted: 0,
      delivered: 0,
      bounced: 0,
      complained: 0,
      skipped: 0,
      unsent: 0,
    },
    dispatch: { done: 0, percent: 0, rate_per_min: null, eta_ms: null },
    delivery: { confirmed: 0, percent_of_accepted: 0 },
    phase: "scheduled",
    actions: [
      { name: "cancel", method: "POST", path: "/api/sends/s_xyz789/cancel" },
      { name: "reschedule", method: "POST", path: "/api/sends/s_xyz789/reschedule" },
    ],
    next_change_at: 1768554000000,
  });
  const r = new Router(isReaderPath);

  const manifest: RouteDef[] = [
    // --- system ---
    {
      method: "GET",
      path: "/health",
      access: "public",
      resource: "system",
      summary:
        "Health check: ok once the configuration is accepted and the database has run every migration this release ships.",
      description:
        "Answered before any route while either is not so (SPEC §9): `500` `invalid_config` naming the setting, or `500` `schema_behind` with the `missing` migrations and a `message` saying what to run.",
      handler: () => json({ status: "ok", service: "kestrel" }),
    },
    {
      // Reports the authenticated principal and the auth mode, so the editor can show
      // identity (and offer Access sign-out) instead of prompting for a token. The mode is
      // how this request authenticated, read off the principal, never off the config.
      method: "GET",
      path: "/api/whoami",
      access: "admin",
      resource: "system",
      summary:
        "The authenticated principal and the auth mode: how this request signed in (access or dev).",
      handler: (c) => {
        const { kind, email, via } = unwrap(c.principal, "principal");
        return json({ principal: { kind, email }, auth: { mode: via } });
      },
    },
    {
      // The running build (SPEC §9), so an API client (Claude, curl) can self-identify a
      // bug report without opening the editor. Admin like the rest of /api/*; the same
      // stamp also rides the settings `deployment` reflection for the editor to show.
      // Not deploy config or a secret — resolved at build (src/build.ts), never from env.
      method: "GET",
      path: "/api/version",
      access: "admin",
      resource: "system",
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
    ...devOnly({
      // Dev-only bootstrap that hands out the local admin token, so it must be public
      // (there is no credential yet). Absent once deployed, like every dev route.
      method: "GET",
      path: "/api/dev/token",
      access: "public",
      resource: "dev",
      summary: "Mint an admin token (local dev only).",
      description:
        "Public because it's how a local client gets the token every admin route requires. Registered only on a local instance. When `kestrel dev` started the server, the answer also carries `runId`, the ID it recorded for this run, which `kestrel seed` and `kestrel reset` check before wiping the database.",
      query: [
        {
          name: "kind",
          description:
            "`human` (default, as the editor uses) or `service` (no email, as Claude uses).",
        },
      ],
      handler: devRoutes.token,
    }),

    // --- setup guide (authed; read-only, bundled from docs/) ---
    // Under /api so the same Access application that gates the authoring API
    // gates these too, and the SPA's authed fetch reaches them (SPEC §5, §11).
    {
      method: "GET",
      path: "/api/docs",
      access: "admin",
      resource: "system",
      summary: "The setup guide as sanitized HTML fragments, in reading order (JSON).",
      handler: docsRoutes.list,
    },

    // --- API reference (authed; generated from THIS manifest) ---
    {
      method: "GET",
      path: "/api/reference",
      access: "admin",
      resource: "system",
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
      resource: "settings",
      summary:
        "Runtime preferences, a read-only reflection of deploy config (no secrets), and `inUse`: the scheduled sends a template or identity change would re-make.",
      description:
        "`deployment.provider` is `ses`; `fake`, a stand-in that records a send and delivers nothing (local development, a demo); or `none` while no email provider is connected (SPEC §9), when everything that would send is refused with 409 `provider_not_connected`. `deployment.notConnectedPreview` is true when that `none` is local development previewing the state (SPEC §10), whose way out is a restart rather than a deploy; it is false once deployed. `deployment.freePlanLimits` is true on the Workers Free plan's limits (`SUBREQUEST_BUDGET` unset), where a scheduled send to more than 5,000 recipients carries the `daily_writes` condition. `inUse.sends` is every scheduled send, soonest first; `inUse.retry_after` is the moment after which a save is no longer refused for the minimum lead (null when none is inside it); `inUse.identityFields` is the identity fields the current template renders, the only ones whose change reaches the email.",
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
            identityFields: ["name", "tagline", "logoUrl", "address"],
          },
        },
      },
      handler: settingsRoutes.get,
    },
    {
      method: "PUT",
      path: "/api/settings",
      access: "admin",
      accepts: JSON_BODY,
      resource: "settings",
      summary:
        "Update runtime preferences: test recipients, the publication identity, the email template, the confirmation email wording.",
      description:
        "Saving a changed template, or an identity field the template renders, re-makes every scheduled send's email at once (SPEC §6, §9), and is refused until the client acknowledges those sends by id in `remake` (409 `remake_required`, listing them) or while any of them is inside the minimum lead (409 `remake_too_close`, with `retry_after`); a save that leaves the email's inputs unchanged asks nothing. `GET /api/settings` lists them under `inUse` beforehand; the response's `remade` says what was re-made, and each of those sends then needs a fresh test. `warnings` is advice that never blocks the save: likely template mistakes, and a mailing address the template leaves out.",
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
      accepts: FORM_UPLOAD,
      resource: "settings",
      summary: "Upload the publication logo (multipart `file`); served publicly via /media.",
      description:
        "The logo is part of the identity, so when the template renders it and sends are scheduled this re-makes their emails under the same rule as `PUT /api/settings`, acknowledged as `?remake=` (comma-separated send ids) since the request carries no JSON body; the bytes are written only once the refusals are ruled out. The image is stored as sent: every surface shows the logo as a square, and an email stretches one that isn't, so send a square image at least 256 × 256 px (the editor crops and scales to that before uploading).",
      handler: settingsRoutes.uploadLogo,
    },
    {
      method: "DELETE",
      path: "/api/settings/logo",
      access: "admin",
      resource: "settings",
      summary: "Remove the publication logo.",
      description:
        "Under the same re-make rule as `PUT /api/settings` when the template renders the logo and sends are scheduled: acknowledged as `?remake=` (comma-separated send ids), refused inside the minimum lead. The image itself stays served, since emails already sent still show it (I3); only what renders from then on loses it.",
      handler: settingsRoutes.deleteLogo,
    },
    {
      // Sends a SAMPLE post through the SAVED template (the one render path, I5) so
      // the operator can see the template in a real inbox. It renders what will ship
      // — the stored template, never unsaved editor content — so the test is honest.
      method: "POST",
      path: "/api/settings/template/test",
      access: "admin",
      accepts: JSON_BODY,
      resource: "settings",
      summary:
        "Send a sample post through the saved email template, to `to` or the default recipients (I5).",
      description: `Renders the stored template, never unsaved editor content; saving first is the client's job, and that save may need the re-make acknowledgement (see \`PUT /api/settings\`). The answer names the recipients the provider didn't accept in \`failed\`, so a client can offer exactly those again and no one gets a second copy. ${notConnected}`,
      example: {
        request: { to: "you@example.com" },
        response: {
          sent: 1,
          total: 1,
          failed: [],
          provider: "fake",
          subject: "Template test — …",
        },
      },
      handler: renderRoutes.templateTest,
    },
    {
      method: "POST",
      path: "/api/settings/notifications/test",
      access: "admin",
      resource: "settings",
      summary:
        "Send a sample notification to the saved notifications address, through the live channel (SPEC §8).",
      description: `Takes no body and goes only to \`settings.notifications.to\`, so it cannot mail an arbitrary address; 400 when none is set. A channel that refuses (an unverified Cloudflare destination, say) is a 502 \`notify_failed\` carrying its words. Through the newsletter's provider, ${notConnected.charAt(0).toLowerCase()}${notConnected.slice(1)}`,
      example: { response: { to: "you@example.com", channel: "cloudflare" } },
      handler: settingsRoutes.notificationTest,
    },
    {
      method: "GET",
      path: "/api/reader-pages/:journey/:state",
      access: "admin",
      resource: "settings",
      summary:
        "A page a reader can land on, as a standalone HTML page: Settings' preview of it (SPEC §5).",
      description:
        "`journey` is `subscribe` (`form`, `check-inbox`, `not-an-email`), `confirm` (`ready`, `confirmed`, `expired`, `invalid`), `unsubscribe` (`ask`, `done`, `invalid`), or `reading` (`landing`, `archive`, `post`, `landing-empty`, `archive-empty`, `not-found`), naming the `state`. Rendered by the code that serves the real page, with the saved publication identity and a sample address and sample posts in place of a reader's own (the `-empty` pages show the landing page and archive before any post is sent), and nothing marking it as a preview, since Settings frames it as one; the post page renders the sample post through the saved template. Always 200, whatever status the real page carries; an unknown pair is a 404. A preview changes nothing: its forms submit nowhere (`form-action 'none'`).",
      handler: readerPageRoutes.readerPagePreview,
    },

    // --- posts + revisions (authed) ---
    {
      method: "POST",
      path: "/api/posts",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      summary:
        "Create a draft post. Its slug follows the subject (`slug_auto: true`) unless you send a `slug`, which sets it by hand.",
      example: {
        request: { subject: "Hello, world", markdown: "# Hello\n\nWelcome." },
        response: {
          post: { id: "p_abc123", status: "draft", slug: "hello-world", slug_auto: true },
          revision_id: "r_1",
        },
      },
      handler: postRoutes.createPost,
    },
    {
      method: "GET",
      path: "/api/posts",
      access: "admin",
      resource: "posts",
      summary:
        "List posts. Filter, sort, and paginate via query params; returns a `page` envelope. Each row carries its active send's id, status, and fire time; the response's `cursor` marks where the read stood among the changes to sends (`<seq>.<at>`, as on `GET /api/sends`), so a client can follow the listed posts' sends from it with `GET /api/sends/feed`.",
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
        {
          name: "limit",
          description: "Page size (default 50, max 200; a larger one is held to 200).",
        },
        {
          name: "offset",
          description:
            "Rows to skip, for pagination. On every list, a `sort` or `dir` not listed here, or a `limit` or `offset` that is not a whole number, is a 400 naming the field.",
        },
      ],
      handler: postRoutes.listPosts,
    },
    {
      method: "GET",
      path: "/api/posts/:id",
      access: "admin",
      resource: "posts",
      summary:
        "One post with its current markdown and any active schedule; `scheduled.remade_at` says when a template or identity change last re-made its email.",
      handler: postRoutes.getPost,
    },
    {
      method: "PUT",
      path: "/api/posts/:id",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      summary:
        "Update a draft. Send the revision you read as `base_revision` (or If-Match): a save without one is a 428 `base_required` carrying the post as it stands, and one whose base is no longer current is a 409 `stale_revision`.",
      description:
        "Only a draft is editable; a scheduled post is soft-locked until its schedule is canceled, and a save to a post that is not a draft is a 409 `post_not_draft` (its message says whether canceling the schedule would unlock it). While the post's slug follows the subject (`slug_auto: true`), every save derives it from the subject again and numbers it if another post holds it, so take the slug from the answer. Sending `slug` sets it by hand and turns `slug_auto` off; `slug_auto: true` has it follow the subject again. Sending both is a 400 naming `slug`.",
      example: {
        request: {
          subject: "Hello again, world",
          markdown: "# Hello\n\nEdited.",
          base_revision: "r_1",
        },
        response: {
          post: {
            id: "p_abc123",
            current_revision: "r_2",
            status: "draft",
            slug: "hello-again-world",
            slug_auto: true,
          },
        },
      },
      handler: postRoutes.updatePost,
    },
    {
      method: "DELETE",
      path: "/api/posts/:id",
      access: "admin",
      resource: "posts",
      summary:
        "Delete a draft and its revisions (drafts only; any other post is a 409 `post_not_draft`).",
      handler: postRoutes.deletePost,
    },
    {
      method: "GET",
      path: "/api/posts/:id/revisions",
      access: "admin",
      resource: "posts",
      summary: "The post's revision history.",
      handler: postRoutes.listRevisions,
    },
    {
      method: "GET",
      path: "/api/posts/:id/revisions/:n",
      access: "admin",
      resource: "posts",
      summary: "One revision by its number.",
      handler: postRoutes.getRevision,
    },

    // --- images (authed upload/list/delete) ---
    {
      method: "POST",
      path: "/api/posts/:id/images",
      access: "admin",
      accepts: [...FORM_UPLOAD, ...RASTER_IMAGE_TYPES],
      resource: "posts",
      summary:
        "Upload an image to a draft (multipart form field `file`); a post that is not a draft is a 409 `post_not_draft`.",
      handler: imageRoutes.uploadImage,
    },
    {
      method: "GET",
      path: "/api/posts/:id/images",
      access: "admin",
      resource: "posts",
      summary: "List a post's images.",
      handler: imageRoutes.listImages,
    },
    {
      method: "DELETE",
      path: "/api/posts/:id/images/:filename",
      access: "admin",
      resource: "posts",
      summary:
        "Delete one image from a draft; a post that is not a draft is a 409 `post_not_draft`.",
      handler: imageRoutes.deleteImage,
    },

    // --- render: preview + test (authed); all go through the one render path ---
    {
      method: "POST",
      path: "/api/posts/:id/preview",
      access: "admin",
      resource: "posts",
      summary:
        "Render the post to its email (returns the hosted URL, subject, warnings, and `frozen`).",
      description:
        "Once the post is scheduled this is its frozen copy, exactly as it will fire, and once sent the record's; a draft renders live (SPEC §5).",
      handler: renderRoutes.preview,
    },
    {
      method: "GET",
      path: "/api/posts/:id/preview",
      access: "admin",
      resource: "posts",
      summary: "The rendered email as a standalone HTML page (the editor's preview).",
      description:
        "Once the post is scheduled this is its frozen copy, exactly as it will fire, and once sent the record's; a draft renders live (SPEC §5).",
      handler: renderRoutes.previewPage,
    },
    {
      method: "GET",
      path: "/api/posts/:id/web",
      access: "admin",
      resource: "posts",
      summary:
        "The post's web version as a standalone HTML page: what its public post page will show.",
      description:
        "Built from the same copy as the preview (a draft's live render, the frozen copy once scheduled, the record once sent) by the post page's own code: the email-only regions left out, the masthead and display font added (SPEC §5). Once the send starts it matches the public post page, less the local-dev dashboard link.",
      handler: renderRoutes.webPage,
    },
    {
      method: "POST",
      path: "/api/posts/:id/test",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      summary:
        "Send a test to one address through the same per-recipient path as a real send (I5).",
      description:
        "Once the post is scheduled this sends its frozen copy, exactly as it will fire, and once sent the record's; a draft's test is a live render (SPEC §5). The response's `frozen` says which. A test of a scheduled send's frozen copy is recorded as its `tested_at`, which clears the send's `remade` condition. " +
        notConnected,
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
    ...devOnly(
      {
        method: "GET",
        path: "/api/dev/outbox",
        access: "admin",
        resource: "dev",
        summary: "Inspect the fake transport's outbox (local dev only).",
        handler: renderRoutes.devOutbox,
      },
      {
        method: "POST",
        path: "/api/dev/seed",
        access: "admin",
        accepts: FORM_UPLOAD,
        resource: "dev",
        summary: "Load the local demo dataset (local dev only).",
        handler: devRoutes.seed,
      },
      {
        method: "POST",
        path: "/api/dev/reset",
        access: "admin",
        resource: "dev",
        summary: "Reset the local database to a fresh install (local dev only).",
        handler: devRoutes.reset,
      },
    ),

    // --- schedule / send / cancel (authed); freeze + soft-lock (M5) ---
    {
      method: "POST",
      path: "/api/posts/:id/schedule",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      summary: `Freeze the render and schedule the send for a future time (at least ${formatLead(minLeadMs)} out).`,
      description:
        "Freezes the current draft, with the template and identity as they stand, onto a send row and soft-locks the post; cancelable until its fire time. A later template or identity change re-makes that frozen email after the publisher confirms it (SPEC §6); there is no per-send template to name, and a `template_revision` field is a 400. `fire_at` is epoch milliseconds or an ISO-8601 timestamp with a `Z` or `±hh:mm` offset; a timestamp without one is a 400, since the Worker cannot know which local time was meant. `fire_at` must be at least the minimum lead out, a 400 `fire_at_too_soon` otherwise (for the soonest send, use Send now, `POST /api/posts/:id/send`): " +
        lead +
        ". The time is then rounded up to the next whole minute (one already on the minute stays), since the sweep fires sends on the minute; the lead is checked on the time as requested, so rounding only lengthens the window. Answers with the new send's view (as `GET /api/sends/:id` describes it) and a `cursor` to follow it from. Refusals: 409 `active_send_exists` when the post already has its one active send (carried as `send`), 409 `post_not_draft`, 400 `subject_required` for an empty subject, 409 `settings_changed` when a template or identity save kept landing while it froze (try again), and 409 `provider_not_connected` while no email provider is connected (SPEC §9).",
      example: {
        request: { fire_at: "2026-01-16T09:00:00Z" },
        response: { send: scheduledExample, cursor: "57.1768467610000" },
      },
      handler: scheduleRoutes.schedule,
    },
    {
      method: "POST",
      path: "/api/posts/:id/send",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      summary:
        "Send now: freeze and schedule one minimum lead out, on the minute, cancelable until then. Idempotent per post.",
      description:
        "The same freeze as scheduling, with the template and identity as they stand, and `fire_at` set to now plus the minimum lead, rounded up to the next whole minute as every fire time is: " +
        lead +
        ". For nearly all of that window the send is inside the minimum lead, so a template or identity save that would re-make it is refused until it has fired. A second call for a post already in its window answers with that send and `idempotent: true`; the other refusals are as for scheduling.",
      example: {
        response: { send: scheduledExample, cursor: "57.1768467610000" },
      },
      handler: scheduleRoutes.sendNow,
    },
    {
      method: "GET",
      path: "/api/sends",
      access: "admin",
      resource: "sends",
      summary:
        "List sends with delivery progress. Filter, sort, and paginate via query params; returns a `page` envelope. Each row is the send's view, the same shape `GET /api/sends/:id`, the feed, and every action answer with (see `GET /api/sends/:id`), read at the same moment, so a list row and the watch never read a send differently. A row's `rev` rises with every change a reader could see (a cancel, a move, a re-make, dispatch progress, a receipt), ordered across all sends. The response's `cursor` marks where this read stood among those changes: `<seq>.<at>`, the change sequence at the read and the server's time of it (epoch milliseconds), both decimal; pass it to `GET /api/sends/feed` as `since`. `audience.count` is a snapshot of the audience while a send is scheduled; once it fires (`audience.fixed`), it is the audience fixed at fire, which never grows.",
      description:
        "`provider.halt` describes a `sending` send whose provider refused its last batch as a whole (SPEC §12), and is null otherwise: its `reason`, `cause`, the provider's own words as `error`, and `since`. The send retries on its own, spaced out the longer the halt lasts: `retries` counts the halted attempts in a row and `retry_at` is when the next is due, up to an hour apart, and both reset the moment a batch is answered. `unavailable` is an outage or a rate limit, retried " +
        retrySchedule(HALT_BACKOFF_MS.unavailable) +
        ", and worth raising only once the send carries the `stuck` condition. `account` is the provider refusing the account itself, retried " +
        retrySchedule(HALT_BACKOFF_MS.account) +
        "; `cause` names what (`credentials`, `configuration`, `sender`, `quota`, `suspended`, or `not_connected`, a deployment with no provider connected). Either way no recipient has been consumed. The fix for `account` is outside this API (the provider's dashboard, or the deployment's secrets, which the API never exposes, SPEC §9), and once it lands the send resumes by itself at its next retry, so it is never rescheduled or sent again. There is no API action to retry sooner. " +
        conditionsText +
        " An unknown `status`, `failures`, `sort`, or `dir`, or a `limit` or `offset` that is not a whole number, is a 400 naming the field.",
      query: [
        {
          name: "status",
          description:
            "Filter by status: `scheduled`, `sending`, `sent`, or `canceled`; anything else is a 400.",
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
        {
          name: "limit",
          description: "Page size (default 50, max 200; a larger one is held to 200).",
        },
        {
          name: "offset",
          description:
            "Rows to skip, for pagination. On every list, a `sort` or `dir` not listed here, or a `limit` or `offset` that is not a whole number, is a 400 naming the field.",
        },
      ],
      handler: sendRoutes.list,
    },
    {
      // Before /api/sends/:id, which would otherwise take "feed" as an id.
      method: "GET",
      path: "/api/sends/feed",
      access: "admin",
      resource: "sends",
      summary:
        "What changed among sends since a cursor, each send with its phase, counters, conditions, and actions, every open condition across the sends, and when to read again: what a client follows to keep up with sends, whichever client changed them, without polling each one.",
      description: `With \`since\` (the \`cursor\` from \`GET /api/sends\`, \`GET /api/sends/:id\`, or this route's last read), \`sends\` is every send that changed after that read, whatever its state: a cancel, a move, a re-make, a new schedule, dispatch progress, a receipt, a completion. It also holds each send the clock changed with no write since then: one whose fire time passed (\`due\`), one past the ${MISSED_THRESHOLD_MS / 60_000}-minute missed tolerance (the \`missed\` condition), and one in flight past the ${STUCK_THRESHOLD_MS / 60_000}-minute stuck threshold (\`stuck\`). A send turns wedged (\`wedged\`) by a write, when the run that left recipients with an unknown fate hands it back, so it is reported like any other change. \`removed\` is every send removed after the cursor (a canceled send deleted with its post), each \`{id, rev}\`, so a client drops it rather than keeping a row for a send that is gone. Without \`since\`, \`sends\` is every send that can change on its own: due, \`sending\`, or settling (\`sent\` within the last ${SETTLE_FOLLOW_MS / 60_000} minutes with a recipient still awaiting a receipt), and \`removed\` is empty. Either way each send is its view, the shape \`GET /api/sends/:id\` describes, read off the send's counters, never its delivery rows, so a send reads the same here as on its page; soonest fire first. \`cursor\` is where this read stood, to pass as \`since\` next time: \`<seq>.<at>\`, the change sequence at the read and the server's time of it (\`now\`), both decimal. The format is part of this contract, so a client holding cursors from several reads (a list, and one send's page) may compare them and follow everything from one read: the cursor with the smaller of each number answers for both. A read reports at most \`limit\` changes after the cursor, in the order they were made, and never splits the changes one write made; the sends the clock changed are always all reported. When more are waiting, \`more\` is true, \`cursor\` stands where the read stopped, and \`read_again_at\` is \`now\`: read again at once from it. A cursor ahead of this database (a sequence above the current one, or a read time more than a minute after \`now\`, as after a reset or a restore of the database) is a 409 \`cursor_ahead\` naming \`since\`: nothing after it would ever be reported, so read the sends again (\`GET /api/sends\` or \`GET /api/sends/:id\`) and follow from that read's cursor. \`read_again_at\` is when to read again, by the server's clock (\`now\`), from each unfinished send's \`next_change_at\`, the earliest it can change with no one acting: about 3 seconds while any send can move now (due, short of the missed tolerance, or sending with a run in hand or work queued for the next tick); while sends are only settling, 3 seconds, then 15, then 60, by how long ago the youngest finished dispatch; otherwise about once a minute (one sweep tick); and never later than just past the next change the clock or the sweep will make (a fire time, a halted send's next retry, the stuck threshold). A send waiting on a person (the provider refusing the account, a wedged send awaiting Resolve, a missed fire time) does not quicken it. A client that reads again then is never more than a few seconds behind a send that is moving, behind a settling send's receipts by at most that pace, and behind any other change (the other client's cancel or move, a Resolve, a late receipt) by about a minute. \`read_again_at\` is advisory: reading sooner, such as right after acting on a send, is always fine, and reading late or skipping a read loses nothing, since the next read from the last cursor reports every send that changed in between. \`GET /api/sends\` and \`GET /api/sends/:id\` carry no pace of their own: a client following from one of them reads this route at once, then keeps to its \`read_again_at\`. \`conditions\` repeats every open condition across the sends that can have one (scheduled, sending, and sent within the bounce-spike window), each with its \`send_id\` and \`subject\`, whether or not the send changed, so one read shows every open problem; most severe first. ${conditionsText} Reading it changes nothing.`,
      query: [
        {
          name: "since",
          description:
            "The `cursor` of an earlier read of sends. Omit it for the sends that can change on their own. A value this API did not issue is a 400 naming the field; one ahead of this database is a 409 `cursor_ahead`.",
        },
        {
          name: "limit",
          description: `The most changes after \`since\` one read reports: a whole number from 1 to ${sendRoutes.FEED_MAX_LIMIT} (default ${sendRoutes.FEED_DEFAULT_LIMIT}). Anything else is a 400 naming the field.`,
        },
      ],
      example: {
        response: {
          now: 1768467610000,
          sends: [
            sendExample({
              status: "scheduled",
              phase: "due",
              started_at: null,
              audience: { count: 1200, fixed: false, fixed_at: null },
              counts: {
                pending: 0,
                in_flight: 0,
                accepted: 0,
                delivered: 0,
                bounced: 0,
                complained: 0,
                skipped: 0,
                unsent: 0,
              },
              dispatch: { done: 0, percent: 0, rate_per_min: null, eta_ms: null },
              delivery: { confirmed: 0, percent_of_accepted: 0 },
            }),
          ],
          removed: [{ id: "s_old456", rev: 56 }],
          cursor: "57.1768467610000",
          more: false,
          conditions: [
            {
              send_id: "s_abc111",
              subject: "Autumn count",
              kind: "wedged",
              severity: "action",
              since: null,
              message:
                "The provider never answered for 2 recipients, so whether they were mailed is unknown, and sending again could mail them twice. The send cannot finish until they are resolved.",
              action: { name: "resolve", method: "POST", path: "/api/sends/s_abc111/resolve" },
              count: 2,
            },
          ],
          read_again_at: 1768467613000,
        },
      },
      handler: sendRoutes.feed,
    },
    {
      method: "GET",
      path: "/api/sends/:id",
      access: "admin",
      resource: "sends",
      summary:
        "One send: its view, the delivery-outcome breakdown of its record, and the `cursor` marking where this read stood among the changes to sends, to follow it from with `GET /api/sends/feed` (it carries no pace, so read the feed at once from it).",
      description:
        "`send` is the send's view, the one shape every send route carries (the list, the feed, every action's answer and refusal), so a client keeps one copy current from any of them and tells two apart by `rev`, the higher the newer. It holds the stored facts: `status` (`scheduled`, `sending`, `sent`, `canceled`), the times, `remade_at` (a template or identity change re-made it while scheduled) and `tested_at`, and `audience` (`count`, an estimate until the send fires and the audience at fire once `fixed`, from `fixed_at`). Beside them, what the server derives as of `as_of`, the server's clock at the read: `counts` (every recipient in one bucket), `dispatch` (hand-off progress; `rate_per_min` is what a sweep tick carries, one tick a minute, and `eta_ms` counts the ticks the rest needs, the wait between them included, given only while it is handing off and once a tick has finished, never while paused), `delivery` (receipts over accepted), `provider` (its `name`, and `halt` while the provider refuses its batches), `phase` (`scheduled`, `due`, `progressing`, `retrying`, `backing-off`, `needs-attention`, `settling`, `complete`, `canceled`), `conditions`, `actions`, and `next_change_at` (see `GET /api/sends/feed`). `links` names the send's other resources: the frozen email (`email_html`, `email_text`), the recipient rows and their CSV, the post, and `archive`, the published page, absolute, once the send is sent. " +
        conditionsText +
        " `outcomes` counts the record's recipients by outcome from its rows, summing to the audience at fire. The answer carries `ETag`: the send's `rev` and a tag of what the clock derives from it, so a request with `If-None-Match` answers 304 while nothing about the send has changed, written or derived.",
      example: {
        response: {
          send: sendExample(),
          outcomes: {
            recipients: 1200,
            delivered: 0,
            bounced: 3,
            complained: 1,
            unsent: 0,
            skipped: 1,
            accepted: 455,
            in_flight: 740,
          },
          cursor: "57.1768467610000",
        },
      },
      handler: sendRoutes.get,
    },
    {
      method: "GET",
      path: "/api/sends/:id/email",
      access: "admin",
      resource: "sends",
      summary:
        "The send's frozen email (I3), exactly as it will fire or went out, with the per-recipient placeholders unfilled: HTML, or its plain-text part.",
      description:
        "Its own route so the send's view never carries the bodies. The HTML is served under the same no-script, no-framing headers as a post page.",
      query: [
        {
          name: "format",
          description: "`html` (default) or `text`; anything else is a 400 naming the field.",
        },
      ],
      handler: sendRoutes.email,
    },
    {
      method: "GET",
      path: "/api/sends/:id/deliveries",
      access: "admin",
      resource: "sends",
      summary:
        "The send's per-recipient delivery rows (JSON), filtered by outcome view and paginated; returns a `page` envelope. Reads the delivery rows directly (the source of truth), not the send's counters — heavier than the send's view, so it is not a poll target.",
      query: [
        {
          name: "view",
          description:
            "`failures` (default: bounced/complained/unsent), `delivered`, `all`, or a single bucket (`bounced`, `complained`, `unsent`, `skipped`, `accepted`, `in_flight`). Anything else is a 400 naming the field.",
        },
        { name: "search", description: "Email contains-search." },
        { name: "sort", description: "`email` (default), `status`, `event`, or `updated`." },
        { name: "dir", description: "`asc` (default) or `desc`." },
        {
          name: "limit",
          description: "Page size (default 50, max 200; a larger one is held to 200).",
        },
        {
          name: "offset",
          description:
            "Rows to skip, for pagination. On every list, a `sort` or `dir` not listed here, or a `limit` or `offset` that is not a whole number, is a 400 naming the field.",
        },
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
      path: "/api/sends/:id/deliveries.csv",
      access: "admin",
      resource: "sends",
      summary: "The send's per-recipient delivery record as CSV (email, status, event, error).",
      handler: sendRoutes.deliveriesCsv,
    },
    {
      method: "POST",
      path: "/api/sends/:id/cancel",
      access: "admin",
      resource: "sends",
      summary: "Cancel a scheduled send during its review window; unlocks the post.",
      description:
        "Answers with the send's view and a `cursor`. The review window closes at the fire time (SPEC §6), whether or not the sweep has started the send: from then this is a 409 `window_closed`. A send canceled already answers 200 with `changed: false`, so a retried cancel is safe; otherwise `changed` is true. " +
        actionText,
      example: {
        response: {
          send: sendExample({ status: "canceled", phase: "canceled", actions: [] }),
          cursor: "58.1768467620000",
          changed: true,
        },
      },
      handler: sendRoutes.cancel,
    },
    {
      method: "POST",
      path: "/api/sends/:id/reschedule",
      access: "admin",
      accepts: JSON_BODY,
      resource: "sends",
      summary: "Move a scheduled send's fire time without re-freezing the render (I3, I6).",
      description:
        "Updates only `fire_at` on a send still in its review window: the frozen render is untouched (the audience is resolved when the send fires) and the review window is preserved; a re-made send keeps its `remade_at`. Distinct from cancel → edit → schedule again, which is for content changes. The same `fire_at` form as scheduling (epoch milliseconds or an ISO-8601 timestamp with a `Z` or `±hh:mm` offset), and the same minimum lead, a 400 `fire_at_too_soon` otherwise: " +
        lead +
        ". As when scheduling, the new time is rounded up to the next whole minute, after the lead is checked on the time as requested. A move to the time the send already has (after that rounding) answers 200 with `changed: false` before the lead is checked, so a retried move is safe. Once the fire time has passed it is a 409 `window_closed`, and a canceled send is a 409 `send_canceled` (schedule the post again instead). " +
        actionText,
      example: {
        request: { fire_at: "2026-01-16T09:00:00Z" },
        response: { send: scheduledExample, cursor: "58.1768467620000", changed: true },
      },
      handler: sendRoutes.reschedule,
    },
    {
      method: "POST",
      path: "/api/sends/:id/resolve",
      access: "admin",
      accepts: JSON_BODY,
      resource: "sends",
      summary:
        "Resolve a send wedged on ambiguous (dispatched) deliveries; body {resolution: 'unsent'|'accepted'}.",
      description:
        "A request that got no answer leaves its recipients `dispatched` — the loop never re-sends it (I4), so the send can't reach its completion gate. This adjudicates those rows: 'unsent' (assume not sent; the address is picked up by the next post) or 'accepted' (assume sent, operator-confirmed), then completes the send. Never re-mails an already-accepted recipient. Offered in `actions` exactly while the send is wedged. Refusals: 409 `run_in_progress` while a run holds the send (its in-flight rows may still get the provider's answer, so try again a moment later), 409 `not_wedged` when the send is not wedged (nothing ambiguous, recipients still to hand off, or a run yet to look at them) and when another Resolve has settled it. Once a send is wedged no run touches it, so the recipients Resolve settles are the ones the send showed; an `expected_count` in the body is ignored. " +
        actionText,
      example: {
        request: { resolution: "unsent" },
        response: {
          send: sendExample({ status: "sent", phase: "settling", completed_at: 1768467620000 }),
          cursor: "58.1768467620000",
          resolved: 12,
          completed: true,
        },
      },
      handler: sendRoutes.resolve,
    },

    // --- subscribers (authed admin) ---
    {
      method: "POST",
      path: "/api/subscribers",
      access: "admin",
      accepts: JSON_BODY,
      resource: "subscribers",
      summary: "Add a subscriber via the normal double opt-in (never an auto-confirm).",
      description: `An address that was erased (SPEC §7) is refused 409 \`erasure_acknowledgement_required\`, with \`erased_at\`, until the request carries \`acknowledge_erasure: true\`: the publisher confirms the person asked to join again. The confirmation then goes as usual, and the person's own confirming lifts the marker. The public form never asks. ${notConnected} Nothing is stored then, since the confirmation could not go.`,
      example: { request: { email: "reader@example.com" } },
      handler: subscriberRoutes.create,
    },
    {
      method: "GET",
      path: "/api/subscribers",
      access: "admin",
      resource: "subscribers",
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
        {
          name: "limit",
          description: "Page size (default 50, max 200; a larger one is held to 200).",
        },
        {
          name: "offset",
          description:
            "Rows to skip, for pagination. On every list, a `sort` or `dir` not listed here, or a `limit` or `offset` that is not a whole number, is a 400 naming the field.",
        },
        {
          name: "email",
          description: "Exact-match lookup of a single subscriber (bypasses the list).",
        },
      ],
      handler: subscriberRoutes.list,
    },
    {
      // Before `/api/subscribers/:id`, which would otherwise take `export` as an id.
      method: "GET",
      path: "/api/subscribers/export",
      access: "admin",
      resource: "subscribers",
      summary:
        "The whole list in the import format (`kestrel-subscribers/1`, SPEC §7), a page at a time.",
      description:
        "Every subscriber (`confirmed` is written as `status: subscribed`) with how they joined, their evidence, and their suppression, plus every address suppressed with no subscriber behind it (`status: none`), an erased one as `suppression: erased`. An imported bounce or complaint is written as `bounce` or `complaint`. Times are UTC ISO-8601. Importing it into another instance carries the list over, every confirmation arriving as imported. Pages run in address order, and following `next` until it is `null` reads every address on the list for the whole export exactly once; one added or removed partway through may or may not appear. The server sets the page size: 1,000 rows on the Workers Free plan's limits (`SUBREQUEST_BUDGET` unset), 10,000 otherwise. `exported_at` is when the first page was read, the same on every page. For a CSV, write the pages' rows as the format's CSV, its header once: a value starting with `=`, `+`, `-`, or `@` carries a leading `'` so a spreadsheet won't run it as a formula, and the importer removes it.",
      query: [
        {
          name: "after",
          description:
            "The `next` a page returned, for the page after it; leave it out for the first. A value this server didn't issue is a 400 naming the field.",
        },
      ],
      example: {
        response: {
          format: "kestrel-subscribers/1",
          exported_at: 1768467600000,
          subscribers: [
            {
              email: "ada@example.com",
              status: "subscribed",
              opt_in: "double",
              origin: "kestrel",
              suppression: null,
              subscribed_at: "2026-01-02T09:30:00.000Z",
              confirmed_at: "2026-01-02T09:42:00.000Z",
              unsubscribed_at: null,
              suppressed_at: null,
              evidence: '{"confirmed_ip":"203.0.113.7"}',
              format: "kestrel-subscribers/1",
            },
          ],
          next: "eyJ2IjoxLCJhZnRlciI6ImFkYUBleGFtcGxlLmNvbSIsImF0IjoxNzY4NDY3NjAwMDAwfQ",
        },
      },
      handler: importRoutes.exportList,
    },
    {
      method: "GET",
      path: "/api/subscribers/:id",
      access: "admin",
      resource: "subscribers",
      summary: "One subscriber.",
      handler: subscriberRoutes.get,
    },
    {
      method: "POST",
      path: "/api/subscribers/:id/unsubscribe",
      access: "admin",
      resource: "subscribers",
      summary: "Unsubscribe a subscriber (admin-initiated).",
      handler: subscriberRoutes.unsubscribe,
    },
    {
      method: "POST",
      path: "/api/subscribers/:id/erase",
      access: "admin",
      resource: "subscribers",
      summary:
        "Erase a subscriber (SPEC §7): remove their data and keep only a do-not-contact marker. Can't be undone.",
      description:
        "One batch: deletes the subscriber's row, with how they joined and its evidence; replaces their address on every past delivery row with one placeholder, `erased:` and random hex, so each send's record still sums to its audience; and suppresses the address with reason `erased`, holding only the address and the time. A bounce, complaint, or manual suppression the address already has is kept as it is. Answers `erased`: the `email`, how many `deliveries` now show the placeholder, and the `suppression` the address is left with. The person can come back by subscribing again: their own confirmation lifts the marker, an import never does (while the address carries the `erased` marker, a row for it, `subscribed` or `unsubscribed`, is `blocked_by_suppression` and creates no subscriber; an address left with its earlier suppression is treated as that suppression), and `POST /api/subscribers` asks for `acknowledge_erasure: true` first. Nothing about the id is kept, so erasing it again answers 404 `not_found`. While a send run is handing the subscriber to the provider (their row pending or dispatched under the run's lease) it refuses 409 `run_in_progress` and changes nothing: try again a moment later. A receipt that later lands on an erased row records its outcome without the provider's words, and a bounce or complaint suppresses the address the receipt names, replacing the marker.",
      example: {
        response: {
          erased: { email: "reader@example.com", deliveries: 12, suppression: "erased" },
        },
      },
      handler: subscriberRoutes.erase,
    },

    // --- imports (authed admin) ---
    {
      method: "GET",
      path: "/api/imports/format",
      access: "admin",
      resource: "imports",
      summary:
        "Everything about the import format (SPEC §7), generated from the definition the importer reads with: the preferred file and why, each accepted file with when to use it and what it loses, the columns, the plain list's rules, this deployment's limits, the outcomes, and the attestation.",
      description:
        "Read it before converting a list. The full CSV (`kestrel-subscribers/1`) is preferred: it carries unsubscribes, bounces, and how each person joined, and it is what the export writes. A plain `.txt` list of addresses is the fallback for a list that is only addresses. Another service's export is converted to the format first; nothing is guessed. `limits.max_rows` is what this deployment takes, with `max_rows_reason` when it is below the format's own limit.",
      handler: importRoutes.format,
    },
    {
      method: "GET",
      path: "/api/imports/template.csv",
      access: "admin",
      resource: "imports",
      summary:
        "A CSV template in the import format, showing its cases; uploaded unchanged it plans cleanly.",
      handler: importRoutes.templateCsv,
    },
    {
      method: "GET",
      path: "/api/imports/template.txt",
      access: "admin",
      resource: "imports",
      summary: "A plain-list template: one address per line.",
      handler: importRoutes.templateTxt,
    },
    {
      method: "POST",
      path: "/api/imports/plan",
      access: "admin",
      accepts: JSON_BODY,
      resource: "imports",
      summary:
        "Plan an import: what it would do to every row against the list as it stands. Writes nothing, so call it as often as a file needs.",
      description: `Body \`{ file: { name, text }, plain_list_status? }\`: the file's name (\`.csv\` for the format, \`.txt\` for a plain list) and its contents as UTF-8 text, and for a plain list what its addresses are, \`subscribed\` (the default), \`unsubscribed\`, or \`bounced\` (a 400 naming the field on a CSV, whose rows say). Answers \`counts\` (every row once, by outcome, summing to \`file.rows\`), \`suppressions_added\`, \`confirmed\` (the rows to be confirmed, by \`opt_in\` and \`origin\`), \`rows\` (each row that won't be confirmed, with its outcome), \`sends_growing\` (each send whose audience would grow, with \`gains\`: a scheduled one, or one that fired but hasn't fixed its audience yet), \`attestation\` (\`{ version, text }\` when anyone would be confirmed, else null), \`plan_hash\`, and \`daily_writes_warning\` (on the Workers Free plan's limits, the server's words when this import and the imports already committed that UTC day would write more of D1's daily allowance of written rows than it leaves room for, advising importing the file the next day; else null; never a refusal, and outside the hash; a send's share of the day is its own \`daily_writes\` condition). The outcomes and when each applies are in \`GET /api/imports/format\`. Refusals name what was wrong and what was expected: 400 \`unrecognized_format\` (not a file in the format at all, with \`row\` where it shows), 400 \`invalid_field\` (a column or value the format doesn't take, with \`row\`, \`column\`, and \`allowed\` where the values are a set), 400 \`too_many_rows\` (over this deployment's \`limit\`), and 413 \`body_too_large\` (over ${IMPORT_LIMITS.maxBodyBytes / (1024 * 1024)} MB).`,
      example: {
        request: {
          file: {
            name: "subscribers.csv",
            text: "email,status,opt_in,origin\r\nada@example.com,subscribed,double,sendy\r\nedsger@example.com,unsubscribed,unknown,sendy\r\n",
          },
        },
        response: {
          file: {
            name: "subscribers.csv",
            kind: "csv",
            rows: 2,
            addresses: 2,
            plain_list_status: null,
          },
          counts: {
            create_confirmed: 1,
            confirm_pending: 0,
            unchanged: 0,
            mark_unsubscribed: 0,
            create_unsubscribed: 1,
            kept_confirmed_newer: 0,
            kept_unsubscribed: 0,
            blocked_by_suppression: 0,
            suppression_added: 0,
            left_out: 0,
            invalid: 0,
            merged: 0,
          },
          suppressions_added: 0,
          confirmed: { opt_in: { double: 1, single: 0, unknown: 0 }, origin: { sendy: 1 } },
          rows: [
            {
              row: 2,
              email: "edsger@example.com",
              outcome: "create_unsubscribed",
              suppression_added: false,
            },
          ],
          sends_growing: [
            { id: "s_xyz789", subject: "Spring migration", fire_at: 1768554000000, gains: 1 },
          ],
          attestation: {
            version: 1,
            text: "Everyone I'm importing as subscribed opted in to receive Field Notes. This isn't a purchased, rented, or scraped list.",
          },
          plan_hash: "9f2c…",
        },
      },
      handler: importRoutes.planRoute,
    },
    {
      method: "POST",
      path: "/api/imports",
      access: "admin",
      accepts: JSON_BODY,
      resource: "imports",
      summary:
        "Commit a plan: apply it all, or nothing, in one batch, and keep the import's record. Never sends an email.",
      description:
        "The plan's body plus `plan_hash`, `attestation: { version, accepted: true }` when the plan returned one, and `acknowledge_sends`: the id of every send in `sends_growing`. It plans again and refuses 409 `plan_stale` when the hash differs (the file, its declared meaning, whether an attestation is needed, or the growing sends changed, or another import was committed since; plan again). The list moving in between is not refused: every write re-checks the list as it stands, so a reader who unsubscribed meanwhile stays unsubscribed, and `differed` lists each row whose result differs from the commit's own plan. 409 `attestation_required` (with the `attestation` to show) when the plan confirms anyone and none was given. 409 `sends_acknowledgement_required` (with the `sends`) when a send that would grow isn't acknowledged, and always for a service token, which can't acknowledge one: the publisher finishes that import in the dashboard. A service token may attest; the record says so, and the publisher is emailed the counts. Answers 201 with the `import` record (never an address), `counts` and `suppressions_added` as applied, `rows` (those not confirmed, as applied), `differed`, and `replayed: false`. A commit repeated with the same plan and file answers 200 with the stored record and `replayed: true`, applying nothing twice. The plan route's refusals apply too.",
      example: {
        request: {
          file: { name: "subscribers.csv", text: "email,status,opt_in,origin\r\n…" },
          plan_hash: "9f2c…",
          attestation: { version: 1, accepted: true },
          acknowledge_sends: ["s_xyz789"],
        },
      },
      handler: importRoutes.commit,
    },

    // --- suppressions (authed admin) ---
    {
      method: "GET",
      path: "/api/suppressions",
      access: "admin",
      resource: "suppressions",
      summary: "List suppressed addresses (bounced or complained, never mailed).",
      handler: suppressionRoutes.list,
    },
    {
      method: "POST",
      path: "/api/suppressions",
      access: "admin",
      accepts: JSON_BODY,
      resource: "suppressions",
      summary: "Suppress an address manually.",
      example: {
        request: { email: "reader@example.com", reason: "manual" },
        response: { suppressed: "reader@example.com", reason: "manual" },
      },
      handler: suppressionRoutes.add,
    },
    {
      method: "DELETE",
      path: "/api/suppressions/:email",
      access: "admin",
      resource: "suppressions",
      summary: "Clear a suppression for an address.",
      handler: suppressionRoutes.clear,
    },

    // --- provider webhooks (public; signature-verified inside the adapter) ---
    {
      method: "POST",
      path: "/webhooks/ses",
      access: "webhook",
      resource: "delivery",
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
      resource: "archive",
      summary:
        "The newsletter's public landing page: identity, the latest post, and a subscribe call to action.",
      handler: archiveRoutes.landing,
    },
    {
      method: "GET",
      path: "/subscribe",
      access: "public",
      resource: "subscriptions",
      summary:
        "The public subscribe form (HTML); while no email provider is connected, a page saying signups aren't open yet (SPEC §9).",
      handler: publicRoutes.subscribeForm,
    },
    {
      method: "POST",
      path: "/subscribe",
      access: "public",
      resource: "subscriptions",
      summary: "Request a subscription; starts the double opt-in (confirmation email).",
      description:
        "Answers the same way whatever the address's state (new, pending, confirmed, unsubscribed, or suppressed), and before any confirmation is sent, so neither the reply nor its timing reveals list membership. A confirmation goes out only if one is due: never to a confirmed or suppressed address, and at most one per address per cooldown. A confirmation the email provider refuses is logged and changes nothing, so submitting again is safe; the authed `POST /api/subscribers` reports the refusal. While no email provider is connected every request is refused alike, 409 `provider_not_connected` (as JSON, or the page saying signups aren't open yet), and nothing is stored (SPEC §9).",
      example: {
        request: { email: "you@example.com" },
        response: { status: "check_inbox" },
      },
      handler: publicRoutes.subscribe,
    },
    {
      method: "GET",
      path: "/confirm",
      access: "public",
      resource: "subscriptions",
      summary: "Confirmation landing page (`?token=`): a Confirm button, and no change.",
      description:
        "Opening the link records nothing, since mail scanners open every link; the page's button POSTs the token. An expired link's page offers to send a fresh one instead.",
      query: [
        {
          name: "token",
          description: "The one-shot confirmation token from the emailed link.",
          required: true,
        },
      ],
      handler: publicRoutes.confirmLanding,
    },
    {
      method: "POST",
      path: "/confirm",
      access: "public",
      resource: "subscriptions",
      summary: "Confirm a subscription: the landing page's button (form field `token`).",
      handler: publicRoutes.confirm,
    },
    {
      method: "GET",
      path: "/unsubscribe",
      access: "public",
      resource: "subscriptions",
      summary: "Unsubscribe landing page (`?token=`, or `?test=1` on a test email or a preview).",
      query: [
        {
          name: "token",
          description: "The subscriber's unsubscribe token, from any delivered email's link.",
        },
        {
          name: "test",
          description:
            "`1` on the link of a test email or a preview, which carries no token: the page a subscriber sees, marked as a test and showing a sample address, whose button posts back with the marker. It unsubscribes no one. A token, when present, wins.",
        },
      ],
      handler: publicRoutes.unsubscribeLanding,
    },
    {
      method: "POST",
      path: "/unsubscribe",
      access: "public",
      resource: "subscriptions",
      summary:
        "Process a one-click / form unsubscribe (`?token=`, or `?test=1` on a test email or a preview).",
      query: [
        {
          name: "token",
          description: "The subscriber's unsubscribe token, from any delivered email's link.",
        },
        {
          name: "test",
          description:
            "`1` on the link of a test email or a preview, which carries no token: answers 200 (a form gets the page a subscriber sees once unsubscribed, marked as a test and showing a sample address) and unsubscribes no one. A token, when present, wins.",
        },
      ],
      handler: publicRoutes.unsubscribe,
    },

    // --- delivery webhooks (public; provider-signature-verified, not requireAuth) ---

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
      resource: "archive",
      summary:
        "The public archive index: every published post (its send has started), newest first.",
      handler: archiveRoutes.archiveIndex,
    },
    {
      method: "GET",
      path: `${archiveBasePath}/:slug`,
      access: "public",
      resource: "archive",
      summary:
        "A published post's archive page / view-in-browser (I3), from the moment its send starts.",
      handler: archiveRoutes.archivePage,
    },

    // --- media bytes (public; readers + archive load these unauthenticated) ---
    {
      method: "GET",
      path: "/media/:key(.*)",
      access: "public",
      resource: "media",
      summary: "Serve image bytes from storage (public; readers + archive load these).",
      handler: imageRoutes.serveMedia,
    },
  ];

  for (const def of manifest) {
    r.register(def);
  }

  return r;
}
