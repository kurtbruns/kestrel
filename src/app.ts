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

import type { ReferenceResponse } from "../shared/reference";
import {
  BOUNCE_SPIKE_MIN,
  BOUNCE_SPIKE_RATE,
  BOUNCE_SPIKE_RECENT_MS,
  formatLead,
  MIN_LEAD_FLOOR_MS,
  STUCK_THRESHOLD_MS,
} from "../shared/sends";
import { buildInfo } from "./build";
import type { Config } from "./env";
import { json } from "./lib/errors";
import { HALT_BACKOFF_MS, MISSED_THRESHOLD_MS } from "./lib/time";
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
  const conditionsText = `\`conditions\` is what is wrong with the send, or worth knowing, now (SPEC §8, §12), derived by the server from the send and the same on every route, most severe first: \`missed\` (still scheduled ${MISSED_THRESHOLD_MS / 60_000} minutes past its fire time: the sweep is not running), \`stuck\` (still sending ${STUCK_THRESHOLD_MS / 60_000} minutes after it started, whatever the cause), \`wedged\` (\`count\` recipients whose delivery is unknown, settled by Resolve), \`refused\` (the provider refusing the account, with its \`cause\`, its own words as \`error\`, the \`advice\` for the fix, which is outside this API, and \`retry_at\`; the send resumes on its own once the account is fixed, having consumed no one), \`provider_unavailable\` (an outage or a rate limit, retried on its own at \`retry_at\`), \`bounce_spike\` (a send finished within ${BOUNCE_SPIKE_RECENT_MS / 86_400_000} days whose confirmed bounces reached ${BOUNCE_SPIKE_RATE * 100}% of its audience at fire, at least ${BOUNCE_SPIKE_MIN}; \`bounced\` and \`rate\`), and \`remade\` (a template or identity change re-made the scheduled email after its last test, \`tested_at\`; a test of the post clears it). Each has a \`severity\` (\`action\`: a person must act; \`warn\`: worth a look; \`info\`), \`since\` (null when the record does not say), a \`message\` to show or relay as it stands, and the \`action\` that settles it, if any. \`actions\` is exactly what the server would accept on the send now, each \`{name, method, path}\`: \`cancel\` and \`reschedule\` while it is scheduled and its fire time is still ahead, \`resolve\` while it is wedged.`;
  const actionText =
    'Send `If-Match: "<rev>"` (the send\'s `rev` as you last read it) to act only on the send you decided about: a send that has changed since is a 412 `precondition_failed` carrying the send as it stands. That includes a change your own earlier attempt made, so a retry after a lost answer that sends `If-Match` gets the 412, with the send showing whether the act landed; a retry without it is answered `changed: false`. Every refusal carries the send as it stands in `send`, in the `GET /sends` row shape.';
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
    dispatch: { done: 460, percent: 38, rate_per_min: 920, eta_ms: 48000 },
    delivery: { confirmed: 4, percent_of_accepted: 1 },
    provider: { name: "ses", halt: null },
    phase: "progressing",
    conditions: [],
    actions: [],
    next_change_at: 1768467610000,
    links: {
      self: "/sends/s_xyz789",
      email_html: "/sends/s_xyz789/email?format=html",
      email_text: "/sends/s_xyz789/email?format=text",
      deliveries: "/sends/s_xyz789/deliveries",
      deliveries_csv: "/sends/s_xyz789/deliveries.csv",
      post: "/posts/p_abc123",
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
      { name: "cancel", method: "POST", path: "/sends/s_xyz789/cancel" },
      { name: "reschedule", method: "POST", path: "/sends/s_xyz789/reschedule" },
    ],
    next_change_at: 1768554000000,
  });
  const r = new Router();

  const manifest: RouteDef[] = [
    // --- system ---
    {
      method: "GET",
      path: "/health",
      access: "public",
      resource: "system",
      summary: "Liveness probe.",
      handler: () => json({ status: "ok", service: "kestrel" }),
    },
    {
      // Reports the authenticated principal and the auth mode, so the editor can show
      // identity (and offer Access sign-out) instead of prompting for a token.
      method: "GET",
      path: "/api/whoami",
      access: "admin",
      resource: "system",
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
      summary: "Mint a local dev admin token (local dev only).",
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
        "The logo is part of the identity, so when the template renders it and sends are scheduled this re-makes their emails under the same rule as `PUT /api/settings`, acknowledged as `?remake=` (comma-separated send ids) since the request carries no JSON body; the bytes are written only once the refusals are ruled out.",
      handler: settingsRoutes.uploadLogo,
    },
    {
      method: "DELETE",
      path: "/api/settings/logo",
      access: "admin",
      resource: "settings",
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
      accepts: JSON_BODY,
      resource: "settings",
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
    {
      method: "POST",
      path: "/api/settings/notifications/test",
      access: "admin",
      resource: "settings",
      summary:
        "Send a sample notification to the saved notifications address, through the live channel (SPEC §8).",
      description:
        "Takes no body and goes only to `settings.notifications.to`, so it cannot mail an arbitrary address; 400 when none is set. A channel that refuses (an unverified Cloudflare destination, say) is a 502 `notify_failed` carrying its words.",
      example: { response: { to: "you@example.com", channel: "cloudflare" } },
      handler: settingsRoutes.notificationTest,
    },

    // --- posts + revisions (authed) ---
    {
      method: "POST",
      path: "/posts",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
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
      resource: "posts",
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
      path: "/posts/:id",
      access: "admin",
      resource: "posts",
      summary:
        "One post with its current markdown and any active schedule; `scheduled.remade_at` says when a template or identity change last re-made its email.",
      handler: postRoutes.getPost,
    },
    {
      method: "PUT",
      path: "/posts/:id",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
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
      resource: "posts",
      summary: "Delete a draft and its revisions (drafts only).",
      handler: postRoutes.deletePost,
    },
    {
      method: "GET",
      path: "/posts/:id/revisions",
      access: "admin",
      resource: "posts",
      summary: "The post's revision history.",
      handler: postRoutes.listRevisions,
    },
    {
      method: "GET",
      path: "/posts/:id/revisions/:n",
      access: "admin",
      resource: "posts",
      summary: "One revision by its number.",
      handler: postRoutes.getRevision,
    },

    // --- images (authed upload/list/delete) ---
    {
      method: "POST",
      path: "/posts/:id/images",
      access: "admin",
      accepts: [...FORM_UPLOAD, ...imageRoutes.POST_IMAGE_TYPES],
      resource: "posts",
      summary: "Upload an image to a post (multipart form field `file`).",
      handler: imageRoutes.uploadImage,
    },
    {
      method: "GET",
      path: "/posts/:id/images",
      access: "admin",
      resource: "posts",
      summary: "List a post's images.",
      handler: imageRoutes.listImages,
    },
    {
      method: "DELETE",
      path: "/posts/:id/images/:filename",
      access: "admin",
      resource: "posts",
      summary: "Delete one image from a post.",
      handler: imageRoutes.deleteImage,
    },

    // --- render: preview + test (authed); all go through the one render path ---
    {
      method: "POST",
      path: "/posts/:id/preview",
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
      path: "/posts/:id/preview",
      access: "admin",
      resource: "posts",
      summary: "The rendered email as a standalone HTML page (editor preview / open-in-browser).",
      description:
        "Once the post is scheduled this is its frozen copy, exactly as it will fire, and once sent the record's; a draft renders live (SPEC §5).",
      handler: renderRoutes.previewPage,
    },
    {
      method: "POST",
      path: "/posts/:id/test",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      summary:
        "Send a test to one address through the same per-recipient path as a real send (I5).",
      description:
        "Once the post is scheduled this sends its frozen copy, exactly as it will fire, and once sent the record's; a draft's test is a live render (SPEC §5). The response's `frozen` says which. A test of a scheduled send's frozen copy is recorded as its `tested_at`, which clears the send's `remade` condition.",
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
      path: "/posts/:id/schedule",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      summary: `Freeze the render and schedule the send for a future time (at least ${formatLead(minLeadMs)} out).`,
      description:
        "Freezes the current draft, with the template and identity as they stand, onto a send row and soft-locks the post; cancelable until its fire time. A later template or identity change re-makes that frozen email after the publisher confirms it (SPEC §6); there is no per-send template to name, and a `template_revision` field is a 400. `fire_at` is epoch milliseconds or an ISO-8601 timestamp with a `Z` or `±hh:mm` offset; a timestamp without one is a 400, since the Worker cannot know which local time was meant. `fire_at` must be at least the minimum lead out, a 400 `fire_at_too_soon` otherwise: " +
        lead +
        ". Answers with the new send's view (as `GET /sends/:id` describes it) and a `cursor` to follow it from. Refusals: 409 `active_send_exists` when the post already has its one active send (carried as `send`), 409 `post_not_draft`, 400 `subject_required` for an empty subject, and 409 `settings_changed` when a template or identity save kept landing while it froze (try again).",
      example: {
        request: { fire_at: "2026-01-16T09:00:00Z" },
        response: { send: scheduledExample, cursor: "57.1768467610000" },
      },
      handler: scheduleRoutes.schedule,
    },
    {
      method: "POST",
      path: "/posts/:id/send",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      summary:
        "Send now: freeze and schedule one minimum lead out, cancelable until then. Idempotent per post.",
      description:
        "The same freeze as scheduling, with the template and identity as they stand, and `fire_at` set to now plus the minimum lead: " +
        lead +
        ". For that whole window the send is inside the minimum lead, so a template or identity save that would re-make it is refused until it has fired. A second call for a post already in its window answers with that send and `idempotent: true`; the other refusals are as for scheduling.",
      example: {
        response: { send: scheduledExample, cursor: "57.1768467610000" },
      },
      handler: scheduleRoutes.sendNow,
    },
    {
      method: "GET",
      path: "/sends",
      access: "admin",
      resource: "sends",
      summary:
        "List sends with delivery progress. Filter, sort, and paginate via query params; returns a `page` envelope. Each row is the send's view, the same shape `GET /sends/:id`, the feed, and every action answer with (see `GET /sends/:id`), read at the same moment, so a list row and the watch never read a send differently. A row's `rev` rises with every change a reader could see (a cancel, a move, a re-make, dispatch progress, a receipt), ordered across all sends. The response's `cursor` marks where this read stood among those changes: `<seq>.<at>`, the change sequence at the read and the server's time of it (epoch milliseconds), both decimal; pass it to `GET /sends/feed` as `since`. `audience.count` is a snapshot of the audience while a send is scheduled; once it fires (`audience.fixed`), it is the audience fixed at fire, which never grows.",
      description:
        "`provider.halt` describes a `sending` send whose provider refused its last batch as a whole (SPEC §12), and is null otherwise: its `reason`, `cause`, the provider's own words as `error`, and `since`. The send retries on its own, spaced out the longer the halt lasts: `retries` counts the halted attempts in a row and `retry_at` is when the next is due, up to an hour apart, and both reset the moment a batch is answered. `unavailable` is an outage or a rate limit, retried " +
        retrySchedule(HALT_BACKOFF_MS.unavailable) +
        ", and worth raising only once the send carries the `stuck` condition. `account` is the provider refusing the account itself, retried " +
        retrySchedule(HALT_BACKOFF_MS.account) +
        "; `cause` names what (`credentials`, `sender`, `quota`, or `suspended`). Either way no recipient has been consumed. The fix for `account` is outside this API (the provider's dashboard, or the deployment's secrets, which the API never exposes, SPEC §9), and once it lands the send resumes by itself at its next retry, so it is never rescheduled or sent again. There is no API action to retry sooner. " +
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
      // Before /sends/:id, which would otherwise take "feed" as an id.
      method: "GET",
      path: "/sends/feed",
      access: "admin",
      resource: "sends",
      summary:
        "What changed among sends since a cursor, each send with its phase, counters, conditions, and actions, every open condition across the sends, and when to read again: what a client follows to keep up with sends, whichever client changed them, without polling each one.",
      description: `With \`since\` (the \`cursor\` from \`GET /sends\`, \`GET /sends/:id\`, or this route's last read), \`sends\` is every send that changed after that read, whatever its state: a cancel, a move, a re-make, a new schedule, dispatch progress, a receipt, a completion. It also holds each send the clock changed with no write since then: one whose fire time passed (\`due\`), one past the ${MISSED_THRESHOLD_MS / 60_000}-minute missed tolerance (the \`missed\` condition), and one in flight past the ${STUCK_THRESHOLD_MS / 60_000}-minute stuck threshold (\`stuck\`). A send turns wedged (\`wedged\`) by a write, when the run that left recipients with an unknown fate hands it back, so it is reported like any other change. \`removed\` is every send removed after the cursor (a canceled send deleted with its post), each \`{id, rev}\`, so a client drops it rather than keeping a row for a send that is gone. Without \`since\`, \`sends\` is every send that can change on its own: due, \`sending\`, or settling (\`sent\` within the last ${SETTLE_FOLLOW_MS / 60_000} minutes with a recipient still awaiting a receipt), and \`removed\` is empty. Either way each send is its view, the shape \`GET /sends/:id\` describes, read off the send's counters, never its delivery rows, so a send reads the same here as on its page; soonest fire first. \`cursor\` is where this read stood, to pass as \`since\` next time: \`<seq>.<at>\`, the change sequence at the read and the server's time of it (\`now\`), both decimal. The format is part of this contract, so a client holding cursors from several reads (a list, and one send's page) may compare them and follow everything from one read: the cursor with the smaller of each number answers for both. A read reports at most \`limit\` changes after the cursor, in the order they were made, and never splits the changes one write made; the sends the clock changed are always all reported. When more are waiting, \`more\` is true, \`cursor\` stands where the read stopped, and \`read_again_at\` is \`now\`: read again at once from it. A cursor ahead of this database (a sequence above the current one, or a read time more than a minute after \`now\`, as after a reset or a restore of the database) is a 409 \`cursor_ahead\` naming \`since\`: nothing after it would ever be reported, so read the sends again (\`GET /sends\` or \`GET /sends/:id\`) and follow from that read's cursor. \`read_again_at\` is when to read again, by the server's clock (\`now\`), from each unfinished send's \`next_change_at\`, the earliest it can change with no one acting: about 3 seconds while any send can move now (due, short of the missed tolerance, or sending with a run in hand or work queued for the next tick); while sends are only settling, 3 seconds, then 15, then 60, by how long ago the youngest finished dispatch; otherwise about once a minute (one sweep tick); and never later than just past the next change the clock or the sweep will make (a fire time, a halted send's next retry, the stuck threshold). A send waiting on a person (the provider refusing the account, a wedged send awaiting Resolve, a missed fire time) does not quicken it. A client that reads again then is never more than a few seconds behind a send that is moving, behind a settling send's receipts by at most that pace, and behind any other change (the other client's cancel or move, a Resolve, a late receipt) by about a minute. \`read_again_at\` is advisory: reading sooner, such as right after acting on a send, is always fine, and reading late or skipping a read loses nothing, since the next read from the last cursor reports every send that changed in between. \`GET /sends\` and \`GET /sends/:id\` carry no pace of their own: a client following from one of them reads this route at once, then keeps to its \`read_again_at\`. \`conditions\` repeats every open condition across the sends that can have one (scheduled, sending, and sent within the bounce-spike window), each with its \`send_id\` and \`subject\`, whether or not the send changed, so one read shows every open problem; most severe first. ${conditionsText} Reading it changes nothing.`,
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
              action: { name: "resolve", method: "POST", path: "/sends/s_abc111/resolve" },
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
      path: "/sends/:id",
      access: "admin",
      resource: "sends",
      summary:
        "One send: its view, the delivery-outcome breakdown of its record, and the `cursor` marking where this read stood among the changes to sends, to follow it from with `GET /sends/feed` (it carries no pace, so read the feed at once from it).",
      description:
        "`send` is the send's view, the one shape every send route carries (the list, the feed, every action's answer and refusal), so a client keeps one copy current from any of them and tells two apart by `rev`, the higher the newer. It holds the stored facts: `status` (`scheduled`, `sending`, `sent`, `canceled`), the times, `remade_at` (a template or identity change re-made it while scheduled) and `tested_at`, and `audience` (`count`, an estimate until the send fires and the audience at fire once `fixed`, from `fixed_at`). Beside them, what the server derives as of `as_of`, the server's clock at the read: `counts` (every recipient in one bucket), `dispatch` (hand-off progress; `eta_ms` only while it is handing off, never while paused), `delivery` (receipts over accepted), `provider` (its `name`, and `halt` while the provider refuses its batches), `phase` (`scheduled`, `due`, `progressing`, `retrying`, `backing-off`, `needs-attention`, `settling`, `complete`, `canceled`), `conditions`, `actions`, and `next_change_at` (see `GET /sends/feed`). `links` names the send's other resources: the frozen email (`email_html`, `email_text`), the recipient rows and their CSV, the post, and `archive`, the published page, absolute, once the send is sent. " +
        conditionsText +
        " `outcomes` counts the record's recipients by outcome from its rows, summing to the audience at fire. The answer carries `ETag`: the send's `rev` and a tag of what the clock derives from it, so a request with `If-None-Match` answers 304 while nothing about the send has changed, written or derived. An action's `If-Match` takes this `ETag` or the bare `rev`.",
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
      path: "/sends/:id/email",
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
      path: "/sends/:id/deliveries",
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
      path: "/sends/:id/deliveries.csv",
      access: "admin",
      resource: "sends",
      summary: "The send's per-recipient delivery record as CSV (email, status, event, error).",
      handler: sendRoutes.deliveriesCsv,
    },
    {
      method: "POST",
      path: "/sends/:id/cancel",
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
      path: "/sends/:id/reschedule",
      access: "admin",
      accepts: JSON_BODY,
      resource: "sends",
      summary: "Move a scheduled send's fire time without re-freezing the render (I3, I6).",
      description:
        "Updates only `fire_at` on a send still in its review window: the frozen render is untouched (the audience is resolved when the send fires) and the review window is preserved; a re-made send keeps its `remade_at`. Distinct from cancel → edit → schedule again, which is for content changes. The same `fire_at` form as scheduling (epoch milliseconds or an ISO-8601 timestamp with a `Z` or `±hh:mm` offset), and the same minimum lead, a 400 `fire_at_too_soon` otherwise: " +
        lead +
        ". A move to the time the send already has answers 200 with `changed: false` before the lead is checked, so a retried move is safe. Once the fire time has passed it is a 409 `window_closed`, and a canceled send is a 409 `send_canceled` (schedule the post again instead). " +
        actionText,
      example: {
        request: { fire_at: "2026-01-16T09:00:00Z" },
        response: { send: scheduledExample, cursor: "58.1768467620000", changed: true },
      },
      handler: sendRoutes.reschedule,
    },
    {
      method: "POST",
      path: "/sends/:id/resolve",
      access: "admin",
      accepts: JSON_BODY,
      resource: "sends",
      summary:
        "Resolve a send wedged on ambiguous (dispatched) deliveries; body {resolution: 'unsent'|'accepted', expected_count?}.",
      description:
        "On a non-idempotent provider a mid-batch transport error leaves recipients `dispatched` — the loop won't blind-retry them (I4), so the send can't reach its completion gate. This adjudicates those rows: 'unsent' (assume not sent; the address is picked up by the next post) or 'accepted' (assume sent, operator-confirmed), then completes the send. Never re-mails an already-accepted recipient. Offered in `actions` exactly while the send is wedged. Refusals: 409 `run_in_progress` while a run holds the send (its in-flight rows may still get the provider's answer, so try again a moment later), 409 `not_wedged` when the send is not wedged (nothing ambiguous, recipients still to hand off, or a run yet to look at them), and, when `expected_count` (the wedged count you decided on) is given, 409 `count_changed` if the count has moved. " +
        actionText,
      example: {
        request: { resolution: "unsent", expected_count: 12 },
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
      path: "/subscribers",
      access: "admin",
      accepts: JSON_BODY,
      resource: "subscribers",
      summary: "Add a subscriber via the normal double opt-in (never an auto-confirm).",
      example: { request: { email: "reader@example.com" } },
      handler: subscriberRoutes.create,
    },
    {
      method: "GET",
      path: "/subscribers",
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
      method: "GET",
      path: "/subscribers/:id",
      access: "admin",
      resource: "subscribers",
      summary: "One subscriber.",
      handler: subscriberRoutes.get,
    },
    {
      method: "POST",
      path: "/subscribers/:id/unsubscribe",
      access: "admin",
      resource: "subscribers",
      summary: "Unsubscribe a subscriber (admin-initiated).",
      handler: subscriberRoutes.unsubscribe,
    },

    // --- suppressions (authed admin) ---
    {
      method: "GET",
      path: "/suppressions",
      access: "admin",
      resource: "suppressions",
      summary: "List suppressed addresses (bounced or complained, never mailed).",
      handler: suppressionRoutes.list,
    },
    {
      method: "POST",
      path: "/suppressions",
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
      path: "/suppressions/:email",
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
      summary: "The public subscribe form (HTML).",
      handler: publicRoutes.subscribeForm,
    },
    {
      method: "POST",
      path: "/subscribe",
      access: "public",
      resource: "subscriptions",
      summary: "Request a subscription; starts the double opt-in (confirmation email).",
      description:
        "Answers the same way whatever the address's state (new, pending, confirmed, unsubscribed, or suppressed), and before any confirmation is sent, so neither the reply nor its timing reveals list membership. A confirmation goes out only if one is due: never to a confirmed or suppressed address, and at most one per address per cooldown. A confirmation the email provider refuses is logged and changes nothing, so submitting again is safe; the authed `POST /subscribers` reports the refusal.",
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
      summary: "Unsubscribe landing page (`?token=`).",
      query: [
        {
          name: "token",
          description: "The subscriber's unsubscribe token, from any delivered email's link.",
          required: true,
        },
      ],
      handler: publicRoutes.unsubscribeLanding,
    },
    {
      method: "POST",
      path: "/unsubscribe",
      access: "public",
      resource: "subscriptions",
      summary: "Process a one-click / form unsubscribe (`?token=`).",
      query: [
        {
          name: "token",
          description: "The subscriber's unsubscribe token, from any delivered email's link.",
          required: true,
        },
      ],
      handler: publicRoutes.unsubscribe,
    },

    // --- delivery webhooks (public; provider-signature-verified, not requireAuth) ---
    {
      method: "POST",
      path: "/webhooks/resend",
      access: "webhook",
      resource: "delivery",
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
      resource: "archive",
      summary: "The public archive index: every sent post, newest first.",
      handler: archiveRoutes.archiveIndex,
    },
    {
      method: "GET",
      path: `${archiveBasePath}/:slug`,
      access: "public",
      resource: "archive",
      summary: "A frozen post's archive page / view-in-browser (I3).",
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
