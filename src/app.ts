/**
 * Composition root: the route manifest, and the Router built from it.
 *
 * Every route is declared as data — a `RouteDef` — in one ordered array. Its
 * `access` field is where the public-vs-admin line is drawn: `admin` is gated by
 * `requireAuth`, `public`/`webhook` are open (a webhook is signature-verified in
 * its adapter). `createRouter` registers each def AND the same manifest drives the
 * generated `/api/reference` (see src/reference/), so the documented tier and the
 * enforced gate come from one field and cannot drift. No public page may redirect or
 * link a reader into an admin path (SPEC §11); `/llms.txt` names the gated Markdown for
 * agents in plain text, which is neither.
 *
 * Order is significant: the router returns the first matching pattern, so the
 * archive `${archiveBasePath}/:slug`, `/media/:key(.*)`, and `/` routes keep their
 * relative positions. Keep new routes grouped with their tier.
 *
 * The `/api/dev/*` routes are registered only when `devMode` holds, so a deployed env
 * has no such routes at all (a 404 by absence, not by check) and its reference omits them.
 */

import { UNLISTED_PATH } from "../shared/archive_url";
import { FREE_PLAN_LIST } from "../shared/free_plan";
import { IMPORT_LIMITS } from "../shared/imports";
import type { ReferenceField, ReferenceResponse } from "../shared/reference";
import { formatLead, MIN_LEAD_FLOOR_MS } from "../shared/sends";
import { SUBSCRIBER_ACTIONS } from "../shared/subscriber_meanings";
import { buildInfo } from "./build";
import type { Config } from "./env";
import { json, notFound } from "./lib/errors";
import { RASTER_IMAGE_TYPES } from "./lib/image_types";
import { unwrap } from "./lib/unwrap";
import { buildReferenceResponse, referenceIndexMarkdown, resourceMarkdown } from "./reference";
import { sendBrief } from "./reference/objects";
import { type BodyField, param, type RouteDef, type RouteRefusal, Router } from "./router";
import * as archiveRoutes from "./routes/archive";
import * as devRoutes from "./routes/dev";
import * as docsRoutes from "./routes/docs";
import * as imageRoutes from "./routes/images";
import * as importRoutes from "./routes/imports";
import * as llmsRoutes from "./routes/llms";
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

// The body types a route declares (`RouteDef.accepts`); a raw upload adds its own.
const JSON_BODY = ["application/json"];
const FORM_UPLOAD = ["multipart/form-data"];

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
  const lead = `${formatLead(minLeadMs)} on this deployment (\`deployment.min_lead_ms\` in \`GET /api/settings\`); a deployment sets it with \`MIN_LEAD_SECONDS\`, never below ${formatLead(MIN_LEAD_FLOOR_MS)}`;
  // A post's archive address, and its listing: the post's settings, which Schedule and Send
  // now take as well as their own route, the address also on a create or a save.
  const slugField: BodyField = {
    name: "slug",
    type: "string",
    description: "The archive address, set by hand; turns `slug_auto` off.",
  };
  const slugAutoField: BodyField = {
    name: "slug_auto",
    type: "boolean",
    description: "`true`: the slug follows the subject again. Not with `slug`.",
  };
  const postSettingsFields: BodyField[] = [
    {
      name: "email_only",
      type: "boolean",
      description:
        "`true`: mailed but left out of the archive; `false`: listed. Absent, unchanged.",
    },
    slugField,
    slugAutoField,
  ];
  // A post's content and address, as a create or a save takes them.
  const postEditFields: BodyField[] = [
    { name: "subject", type: "string", description: "The subject line, and the post's title." },
    { name: "markdown", type: "string", description: "The body, in Markdown." },
    slugField,
    slugAutoField,
  ];
  // A list's file, as an import's plan and commit take it.
  const importFileFields: BodyField[] = [
    {
      name: "file.name",
      type: "string",
      required: true,
      description: "The file's name: `.csv` for the format, `.txt` for a plain list.",
    },
    {
      name: "file.text",
      type: "string",
      required: true,
      description: `The file's contents as UTF-8 text, at most ${IMPORT_LIMITS.maxBodyBytes / (1024 * 1024)} MB.`,
    },
    {
      name: "plain_list_status",
      type: '"subscribed" | "unsubscribed" | "bounced"',
      description:
        "For a plain list, what its addresses are (default `subscribed`). A 400 on a CSV, whose rows say.",
    },
  ];
  // What an import's plan refuses, naming what was wrong and what was expected; a commit too.
  const importRefusals: RouteRefusal[] = [
    { code: "unrecognized_format", details: ["row"] },
    { code: "invalid_field", details: ["row", "column", "allowed"] },
    { code: "too_many_rows", details: ["limit"] },
    { code: "body_too_large" },
  ];
  // What a post's create or save answers beside the post.
  const subjectSlugHeld: ReferenceField = {
    name: "subject_slug_held",
    type: "string | null",
    description:
      "The subject's slug when another post holds it, so the address took a number; null otherwise, and once the post is published.",
  };
  const postSavedFields: ReferenceField[] = [
    subjectSlugHeld,
    { name: "revision_id", type: "string", description: "The revision the save wrote." },
  ];
  // A fire time, as Schedule and Reschedule take it.
  const fireAtField: BodyField = {
    name: "fire_at",
    type: "epoch ms or ISO-8601",
    required: true,
    description:
      "Epoch ms, or ISO-8601 with a `Z` or `±hh:mm` offset. At least the minimum lead out; rounded up to the minute.",
  };
  // The refusals several routes share, each in one wording.
  const notConnected: RouteRefusal = { code: "provider_not_connected" };
  const remakeRefusals: RouteRefusal[] = [
    { code: "remake_required", details: ["sends"] },
    {
      code: "remake_too_close",
      when: "A send it would re-make is inside the minimum lead; that send fires unchanged, so tell the publisher it goes out as it stands.",
      details: ["retry_after", "sends"],
    },
    { code: "conflict", details: ["settings"] },
  ];
  const slugRefusals: RouteRefusal[] = [{ code: "slug_invalid" }, { code: "slug_taken" }];
  const activeSendExists: RouteRefusal = {
    code: "active_send_exists",
    details: ["send", "cursor"],
  };
  // What a freeze refuses, beside its one active send.
  const freezeRefusals: RouteRefusal[] = [
    { code: "post_not_draft", details: ["post"] },
    { code: "subject_required" },
    { code: "settings_changed", details: ["settings"] },
    notConnected,
    ...slugRefusals,
  ];
  const notDraft: RouteRefusal = { code: "post_not_draft", details: ["post"] };
  // A send in a route's example: its state, since the whole view is described once.
  const scheduledBrief = sendBrief({
    status: "scheduled",
    phase: "scheduled",
    fire_at: 1768554000000,
    actions: [
      { name: "cancel", method: "POST", path: "/api/sends/s_xyz789/cancel" },
      { name: "reschedule", method: "POST", path: "/api/sends/s_xyz789/reschedule" },
    ],
  });
  // The fields every read or act on sends answers beside the send.
  const cursorField: ReferenceField = {
    name: "cursor",
    type: "string",
    description: "Where this answer stands among changes to sends (Following changes).",
  };
  const pageField: ReferenceField = {
    name: "page",
    type: "object",
    description: "The list's `{ total, limit, offset, sort, dir }` (Lists and paging).",
  };
  const freezeWarningsField: ReferenceField = {
    name: "warnings",
    type: "string[]",
    description:
      "What the render found wrong with the frozen copy (an image the post never uploaded, say), which preview and test of the copy report too.",
  };
  const changedField: ReferenceField = {
    name: "changed",
    type: "boolean",
    description: "False when the send already stood as asked, and nothing was written.",
  };
  // A list's page size and offset, the same on every list (see Lists and paging).
  const pageParams = [
    { name: "limit", description: "Page size (default 50, max 200)." },
    { name: "offset", description: "Rows to skip." },
  ];
  const r = new Router(isReaderPath);

  const manifest: RouteDef[] = [
    // --- system ---
    {
      method: "GET",
      path: "/health",
      access: "public",
      resource: "system",
      title: "Check health",
      summary:
        "Health check: ok once the configuration is accepted and the database has run every migration this release ships.",
      description: "Answered before any route while either is not so, on every API path alike.",
      errors: [
        { code: "invalid_config", details: ["variable"] },
        { code: "schema_behind", details: ["missing"] },
      ],
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
      title: "Get who is signed in",
      summary:
        "The authenticated principal and the auth mode: how this request signed in (access or dev). A service token's principal carries its Client ID as `token_id`.",
      returns: {
        fields: [
          {
            name: "principal",
            type: "{ kind, email, token_id }",
            description:
              "`kind` `human`, signed in as `email`, or `service`, a service token as Claude uses, with no `email` and its Client ID as `token_id` when the token names one.",
          },
          {
            name: "auth.mode",
            type: '"access" | "dev"',
            description: "How this request signed in.",
          },
        ],
      },
      handler: (c) => {
        const { kind, email, tokenId, via } = unwrap(c.principal, "principal");
        return json({ principal: { kind, email, token_id: tokenId }, auth: { mode: via } });
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
      title: "Get the running build",
      summary:
        "The running build: version, short SHA, release tag (if this build is one), build time, and repo links.",
      example: {
        response: {
          version: "0.1.0",
          sha: "a1b2c3d",
          tag: "v0.1.0",
          build_time: "2026-01-15T09:00:00.000Z",
          repo_url: "https://github.com/kurtbruns/kestrel",
          commit_url: "https://github.com/kurtbruns/kestrel/commit/a1b2c3d",
          tag_url: "https://github.com/kurtbruns/kestrel/releases/tag/v0.1.0",
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
      title: "Mint a dev token",
      summary: "Mint an admin token (local dev only).",
      description:
        "Public because it's how a local client gets the token every admin route requires. Registered only on a local instance. When `kestrel dev` started the server, the answer also carries `run_id`, the ID it recorded for this run, which `kestrel seed` and `kestrel reset` check before wiping the database.",
      query: [
        {
          name: "kind",
          description:
            "`human` (default, as the editor uses) or `service` (no email, as Claude uses).",
        },
      ],
      handler: devRoutes.token,
    }),

    // --- docs (authed; read-only, bundled from docs/) ---
    // Under /api so the same Access application that gates the authoring API
    // gates these too, and the SPA's authed fetch reaches them (SPEC §5, §11).
    {
      method: "GET",
      path: "/api/docs",
      access: "admin",
      resource: "system",
      title: "List the docs",
      summary:
        "The docs (the publisher's pages and the setup guide) as sanitized HTML fragments, in reading order (JSON).",
      handler: docsRoutes.list,
    },
    {
      method: "GET",
      path: "/api/docs/:name.md",
      access: "admin",
      resource: "system",
      title: "Get a doc as Markdown",
      summary: "One doc's Markdown, for an agent to read (text/markdown).",
      description:
        "`name` is a doc's `slug` from `GET /api/docs`, or a set's `id` for that set's index: `publishing.md` lists the publisher's pages, `self-hosting.md` the setup guide's. Links between docs point at each other's Markdown, relative to this route, so an agent can follow them.",
      handler: docsRoutes.markdown,
    },

    // --- API reference (authed; generated from THIS manifest) ---
    {
      method: "GET",
      path: "/api/reference",
      access: "admin",
      resource: "system",
      title: "Get the API reference",
      summary:
        "Every route, generated from the registration so it can't drift, with the rules, refusal codes, and objects they share.",
      // Returned as data (the SPA renders it natively as a sidebar plus sections, no iframe);
      // it's also a machine-readable listing of the surface for Claude and tooling.
      handler: () => {
        const body: ReferenceResponse = buildReferenceResponse(r.routes.map((route) => route.def));
        return json(body);
      },
    },
    {
      method: "GET",
      path: "/api/reference.md",
      access: "admin",
      resource: "system",
      title: "Get the API reference's index",
      summary:
        "The reference's index as Markdown, for an agent to read first (text/markdown): the topics every route shares, and every route on one line.",
      handler: (c) =>
        docsRoutes.markdownResponse(
          referenceIndexMarkdown(
            buildReferenceResponse(r.routes.map((route) => route.def)),
            c.url.origin,
          ),
        ),
    },
    {
      method: "GET",
      path: "/api/reference/:resource.md",
      access: "admin",
      resource: "system",
      title: "Get a resource's reference",
      summary:
        "One resource's reference as Markdown (text/markdown): the object its routes return, then each route in full.",
      description:
        "`resource` is one the index lists, such as `sends` or `posts`, as each resource's `Reference:` line there names it.",
      errors: [{ code: "not_found", when: "No route acts on a resource by that name." }],
      handler: (c) => {
        const md = resourceMarkdown(
          buildReferenceResponse(r.routes.map((route) => route.def)),
          param(c, "resource"),
        );
        if (md === null) {
          throw notFound("resource");
        }
        return docsRoutes.markdownResponse(md);
      },
    },

    // --- app settings (authed; runtime preferences, never secrets) ---
    {
      method: "GET",
      path: "/api/settings",
      access: "admin",
      resource: "settings",
      title: "Get the settings",
      summary:
        "Runtime preferences, a read-only reflection of deploy config (no secrets), and `in_use`: the scheduled sends a template or identity change would re-make.",
      returns: { object: "settings" },
      handler: settingsRoutes.get,
    },
    {
      method: "PUT",
      path: "/api/settings",
      access: "admin",
      accepts: JSON_BODY,
      resource: "settings",
      title: "Update the settings",
      summary:
        "Update runtime preferences: test recipients, the publication identity, the email template, the confirmation email wording.",
      description:
        "Every field is optional: send only what changes. Saving a changed template, or an identity field the template renders, re-makes every scheduled send's email at once, once the client acknowledges those sends by id in `remake`; a save that leaves the email's inputs unchanged asks nothing. `GET /api/settings` lists them under `in_use` beforehand.",
      example: {
        request: { email_template: "<style>…</style>…", remake: ["s_xyz789"] },
        response: {
          settings: { email_template: "…" },
          warnings: [],
          remade: [sendBrief({ fire_at: 1768467600000, remade_at: 1768460000000 })],
        },
      },
      body: [
        {
          name: "test_recipients",
          type: "string[]",
          description: "The addresses a test goes to when it names none.",
        },
        { name: "publication.name", type: "string", description: "The publication's name." },
        { name: "publication.tagline", type: "string", description: "One line under the name." },
        {
          name: "publication.address",
          type: "string",
          description: "The mailing address the template prints in each email's footer.",
        },
        {
          name: "email_template",
          type: "string",
          description:
            "The email template's HTML. One missing the unsubscribe link or the body is a 400.",
        },
        {
          name: "confirmation_email.subject",
          type: "string",
          description: "The confirmation email's subject.",
        },
        {
          name: "confirmation_email.body",
          type: "string",
          description: "Its text above the button.",
        },
        {
          name: "confirmation_email.button_label",
          type: "string",
          description: "Its button's label.",
        },
        {
          name: "confirmation_email.reassurance",
          type: "string",
          description: "Its line under the button.",
        },
        {
          name: "notifications.to",
          type: "string",
          description: "The address the publisher's notifications go to.",
        },
        {
          name: "remake",
          type: "string[]",
          description:
            "The id of every scheduled send this save would re-make, acknowledging it (`in_use.sends` in `GET /api/settings`).",
        },
      ],
      errors: remakeRefusals,
      returns: {
        fields: [
          {
            name: "settings",
            type: "object",
            description: "The preferences as saved, as `GET /api/settings` carries them.",
          },
          {
            name: "warnings",
            type: "string[]",
            description:
              "Advice that never blocks the save: likely template mistakes, and a mailing address the template leaves out.",
          },
          {
            name: "remade",
            type: "object[]",
            description:
              "The scheduled sends the save re-made, each as its send view, as `in_use.sends` lists them; each then needs a fresh test.",
          },
        ],
      },
      handler: settingsRoutes.update,
    },
    {
      method: "POST",
      path: "/api/settings/logo",
      access: "admin",
      accepts: FORM_UPLOAD,
      resource: "settings",
      title: "Upload the logo",
      summary: "Upload the publication logo (multipart `file`); served publicly via /media.",
      description:
        "The logo is part of the identity, so when the template renders it and sends are scheduled this re-makes their emails under the same rule as `PUT /api/settings`, acknowledged in `remake`; the bytes are written only once the refusals are ruled out. The image is stored as sent (the editor crops and scales it before uploading).",
      query: [
        {
          name: "remake",
          description:
            "The ids of the scheduled sends this would re-make, comma-separated, acknowledging them as `PUT /api/settings` takes `remake`.",
        },
      ],
      body: [
        {
          name: "file",
          type: "file",
          required: true,
          description: `The logo: a PNG, JPEG, WebP, or GIF, at most ${settingsRoutes.MAX_LOGO_BYTES / 1024} KB, square and at least 256 × 256 px, since every surface shows it as a square and an email stretches one that isn't.`,
        },
      ],
      errors: remakeRefusals,
      handler: settingsRoutes.uploadLogo,
    },
    {
      method: "DELETE",
      path: "/api/settings/logo",
      access: "admin",
      resource: "settings",
      title: "Remove the logo",
      summary: "Remove the publication logo.",
      description:
        "Under the same re-make rule as `PUT /api/settings` when the template renders the logo and sends are scheduled: acknowledged in `remake`. The image itself stays served, since emails already sent still show it; only what renders from then on loses it.",
      query: [
        {
          name: "remake",
          description:
            "The ids of the scheduled sends this would re-make, comma-separated, as for the upload.",
        },
      ],
      errors: remakeRefusals,
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
      title: "Test the email template",
      summary: "Send a sample post through the saved email template.",
      description: `Renders the stored template, never unsaved editor content; saving first is the client's job, and that save may need the re-make acknowledgement (see \`PUT /api/settings\`). The answer names the recipients the provider didn't accept in \`failed\`, so a client can offer exactly those again and no one gets a second copy, and says why for each in \`not_sent\`, in the same order (see \`POST /api/posts/:id/test\`).`,
      example: {
        request: { to: "you@example.com" },
        response: {
          sent: 1,
          total: 1,
          failed: [],
          not_sent: [],
          provider: "fake",
          subject: "Template test — …",
        },
      },
      body: [
        {
          name: "to",
          type: "string or string[]",
          description: `Where to send it, at most ${renderRoutes.MAX_TEMPLATE_TEST_RECIPIENTS} addresses. Omitted, the saved \`test_recipients\`.`,
        },
      ],
      errors: [notConnected],
      handler: renderRoutes.templateTest,
    },
    {
      method: "POST",
      path: "/api/settings/notifications/test",
      access: "admin",
      resource: "settings",
      title: "Test notifications",
      summary:
        "Send a sample notification to the saved notifications address, through the live channel.",
      description:
        "Takes no body and goes only to `settings.notifications.to`, so it cannot mail an arbitrary address.",
      example: { response: { to: "you@example.com", channel: "cloudflare" } },
      errors: [
        { code: "bad_request", when: "No notifications address is saved." },
        {
          code: "notify_failed",
          when: "The channel refused it, in its own words (an unverified Cloudflare destination, say).",
        },
        {
          ...notConnected,
          when: "Notifications go through the newsletter's provider, and none is connected.",
        },
      ],
      handler: settingsRoutes.notificationTest,
    },
    {
      method: "GET",
      path: "/api/reader-pages/:journey/:state",
      access: "admin",
      resource: "settings",
      title: "Preview a reader page",
      summary: "A page a reader can land on, as a standalone HTML page: Settings' preview of it.",
      description:
        "`journey` and its `state`: `subscribe` (`form`, `check-inbox`, `not-an-email`), `confirm` (`ready`, `confirmed`, `expired`, `invalid`), `unsubscribe` (`ask`, `done`, `invalid`), or `reading` (`landing`, `archive`, `post`, `landing-empty`, `archive-empty`, `not-found`). Rendered by the real page's code with the saved identity and sample posts and address, unmarked, since Settings frames it. Always 200; its forms submit nowhere.",
      errors: [{ code: "not_found", when: "The journey and state are not a pair listed here." }],
      handler: readerPageRoutes.readerPagePreview,
    },

    // --- posts + revisions (authed) ---
    {
      method: "POST",
      path: "/api/posts",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      title: "Create a post",
      summary:
        "Create a draft post. Its slug follows the subject (`slug_auto: true`) unless you send a `slug`. Every field is optional; an empty body makes a blank draft.",
      description:
        "The post is made with its unlisted link, which every test and send of it carries as view-in-browser and which never changes. A slug that follows the subject takes the subject's slug, or the first free number (`-2`) when another post holds it, and `subject_slug_held` names the slug it couldn't take: not a refusal, since the save succeeded.",
      example: {
        request: { subject: "Hello, world", markdown: "# Hello\n\nWelcome." },
        response: {
          post: {
            id: "p_abc123",
            status: "draft",
            slug: "hello-world",
            slug_auto: true,
            current_revision: "r_1",
          },
          subject_slug_held: null,
          revision_id: "r_1",
        },
      },
      body: postEditFields,
      errors: slugRefusals,
      returns: { object: "post", as: "post", fields: postSavedFields },
      handler: postRoutes.createPost,
    },
    {
      method: "GET",
      path: "/api/posts",
      access: "admin",
      resource: "posts",
      title: "List posts",
      summary: "List posts, filtered, sorted, and paged, each with its active send.",
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
            "`updated_at` (default: scheduled-first, then newest edit), `subject`, `status`, or `send.fire_at`, the fire time of the post's send.",
        },
        { name: "dir", description: "`asc` or `desc` (default `desc`)." },
        ...pageParams,
      ],
      returns: {
        object: "post",
        as: "posts",
        list: true,
        fields: [
          pageField,
          {
            ...cursorField,
            description:
              "Where this read stood among the changes to sends, to follow the listed posts' sends from.",
          },
        ],
      },
      handler: postRoutes.listPosts,
    },
    {
      method: "GET",
      path: "/api/posts/:id",
      access: "admin",
      resource: "posts",
      title: "Get a post",
      summary: "One post, with where its send stands, and its current markdown.",
      returns: {
        object: "post",
        as: "post",
        fields: [
          subjectSlugHeld,
          { name: "markdown", type: "string", description: "The current revision's body." },
        ],
      },
      example: {
        response: {
          post: {
            id: "p_abc123",
            status: "draft",
            subject: "Hello, world",
            current_revision: "r_1",
            author: "you@example.com",
            send: null,
          },
          subject_slug_held: null,
          markdown: "# Hello\n\nWelcome.",
        },
      },
      description:
        "The answer carries `ETag`, the current revision, to send back as `If-Match` on a save. To place a revision id in the history (for a merge after `stale_revision`), list the revisions: each carries its `id` and its number `n`.",
      handler: postRoutes.getPost,
    },
    {
      method: "PUT",
      path: "/api/posts/:id",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      title: "Update a post",
      summary:
        "Update a draft, against the revision you read as `base_revision` (or If-Match), so no one's edit is overwritten unseen.",
      description:
        "Only a draft is editable; a scheduled post is soft-locked until its schedule is canceled. While `slug_auto`, every save derives the slug from the subject again (taking `-2` when another post holds it, named by `subject_slug_held`), so take the slug from the answer.",
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
      body: [
        ...postEditFields,
        {
          name: "base_revision",
          type: "string",
          required: true,
          description:
            "The revision this edit is based on, the post's `current_revision` as you read it. An `If-Match` header may carry it instead, and wins.",
        },
      ],
      errors: [
        { code: "base_required", details: ["post"] },
        {
          code: "stale_revision",
          details: ["current_revision", "updated_at", "author", "post", "markdown"],
        },
        notDraft,
        ...slugRefusals,
      ],
      returns: { object: "post", as: "post", fields: postSavedFields },
      handler: postRoutes.updatePost,
    },
    {
      method: "DELETE",
      path: "/api/posts/:id",
      access: "admin",
      resource: "posts",
      title: "Delete a post",
      summary: "Delete a draft and its revisions.",
      description:
        "Its images go with it. Answers `{ deleted: true }`; a repeat, with the post gone, is a 404.",
      errors: [notDraft],
      handler: postRoutes.deletePost,
    },
    {
      method: "PUT",
      path: "/api/posts/:id/settings",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      title: "Change a post's settings",
      summary:
        "Change a post's settings, the editor's \"Post settings\": where it is listed (`email_only`) and its archive address (`slug`, `slug_auto`).",
      description:
        "Any subset of the three, in any state, a sent post's included: none is part of the frozen email, so a change never re-makes or alters a send, though each of the post's sends takes a new `rev` and the feed reports it. Once the post's send has started its address is fixed. A body naming none of the three is a 400.",
      example: {
        request: { email_only: false, slug: "hello-world" },
        response: {
          post: {
            id: "p_abc123",
            status: "sent",
            slug: "hello-world",
            email_only: false,
            archive_url: "https://newsletter.example.com/archive/hello-world",
            unlisted_url:
              "https://newsletter.example.com/email/9f2c41d0-7ab35e8c-6d1f04b2-a7e9c350",
            published_at: 1768467600000,
            archive_live: true,
          },
          subject_slug_held: null,
          changed: true,
        },
      },
      body: postSettingsFields,
      errors: [
        ...slugRefusals,
        {
          code: "slug_permanent",
          when: "A change to the address once the post's send has started, or while its scheduled email (frozen before unlisted links) links it. Naming the address it has is fine.",
          details: ["post"],
        },
      ],
      returns: {
        object: "post",
        as: "post",
        fields: [
          subjectSlugHeld,
          { ...changedField, description: "False when the post already stood as asked." },
        ],
      },
      handler: postRoutes.setSettings,
    },
    {
      method: "GET",
      path: "/api/posts/:id/revisions",
      access: "admin",
      resource: "posts",
      title: "List a post's revisions",
      summary: "The post's revision history.",
      returns: { object: "revision", as: "revisions", list: true },
      handler: postRoutes.listRevisions,
    },
    {
      method: "GET",
      path: "/api/posts/:id/revisions/:n",
      access: "admin",
      resource: "posts",
      title: "Get a revision",
      summary: "One revision by its number.",
      returns: { object: "revision" },
      handler: postRoutes.getRevision,
    },

    // --- images (authed upload/list/delete) ---
    {
      method: "POST",
      path: "/api/posts/:id/images",
      access: "admin",
      accepts: [...FORM_UPLOAD, ...RASTER_IMAGE_TYPES],
      resource: "posts",
      title: "Upload an image",
      summary: "Upload an image to a draft, as a form or the raw bytes.",
      description:
        "The post's Markdown references the image by the `filename` the response gives, `![a short description](cover.jpg)`, and the render resolves that name to the stored image.",
      query: [
        {
          name: "filename",
          description:
            "For a raw upload (the image's own type as `Content-Type`, the bytes as the body), the name to store it under; required then.",
        },
      ],
      body: [
        {
          name: "file",
          type: "file",
          required: true,
          description: `The image: a PNG, JPEG, WebP, or GIF, at most ${imageRoutes.MAX_POST_IMAGE_BYTES / (1024 * 1024)} MB.`,
        },
        {
          name: "filename",
          type: "string",
          description: "The name to store it under, in place of the file's own.",
        },
      ],
      errors: [notDraft],
      returns: {
        fields: [
          {
            name: "image",
            type: "object",
            description:
              "`{ filename, content_type, width, height, url }`: `filename` is the name the post's Markdown references it by, `![a short description](filename)`.",
          },
        ],
      },
      handler: imageRoutes.uploadImage,
    },
    {
      method: "GET",
      path: "/api/posts/:id/images",
      access: "admin",
      resource: "posts",
      title: "List a post's images",
      summary: "List a post's images.",
      returns: {
        fields: [
          {
            name: "images",
            type: "object[]",
            description:
              "Each `{ filename, content_type, width, height, url }`, as an upload answers it.",
          },
        ],
      },
      handler: imageRoutes.listImages,
    },
    {
      method: "DELETE",
      path: "/api/posts/:id/images/:filename",
      access: "admin",
      resource: "posts",
      title: "Delete an image",
      summary: "Delete one image from a draft.",
      description:
        "`filename` is the name the upload answered. The Markdown is left as it is, so a reference to the image no longer resolves and its render warns. Answers `{ deleted: true }`; a repeat, with the image gone, is a 404.",
      errors: [notDraft],
      handler: imageRoutes.deleteImage,
    },

    // --- render: preview + test (authed); all go through the one render path ---
    {
      method: "POST",
      path: "/api/posts/:id/preview",
      access: "admin",
      resource: "posts",
      title: "Render a post's email",
      summary:
        "Render the post to its email (returns the hosted URL, subject, warnings, and `frozen`).",
      description:
        "Once the post is scheduled this is its frozen copy, exactly as it will fire, and once sent the record's; a draft renders live. A frozen copy's `warnings` are the ones its render gave when it was frozen or last re-made.",
      returns: {
        fields: [
          {
            name: "url",
            type: "string",
            description:
              "The rendered email as a page behind the admin gate, `GET /api/posts/:id/preview`: not a public link.",
          },
          { name: "subject", type: "string", description: "The email's subject." },
          {
            name: "warnings",
            type: "string[]",
            description: "What the render found wrong (an image the post never uploaded, say).",
          },
          {
            name: "frozen",
            type: "boolean",
            description: "Whether it is a scheduled or sent send's frozen copy.",
          },
        ],
      },
      handler: renderRoutes.preview,
    },
    {
      method: "GET",
      path: "/api/posts/:id/preview",
      access: "admin",
      resource: "posts",
      title: "Preview a post's email",
      summary: "The rendered email as a standalone HTML page (the editor's preview).",
      description:
        "Once the post is scheduled this is its frozen copy, exactly as it will fire, and once sent the record's; a draft renders live.",
      handler: renderRoutes.previewPage,
    },
    {
      method: "GET",
      path: "/api/posts/:id/web",
      access: "admin",
      resource: "posts",
      title: "Preview a post's web version",
      summary:
        "The post's web version as a standalone HTML page: what its public post page will show.",
      description:
        "Built from the same copy as the preview (a draft's live render, the frozen copy once scheduled, the record once sent) by the post page's own code: the email-only regions left out, the masthead and display font added. Once the send starts it matches the public post page, less the local-dev dashboard link.",
      handler: renderRoutes.webPage,
    },
    {
      method: "POST",
      path: "/api/posts/:id/test",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      title: "Send a test",
      summary: "Send a test to one address through the same per-recipient path as a real send.",
      description:
        "Once scheduled, it sends the frozen copy exactly as it will fire, and once sent the record's; a draft's is a live render, as `frozen` says, and `warnings` are that copy's (a frozen copy's from when it was frozen or last re-made). A test of the frozen copy is recorded as the send's `tested_at`, clearing `remade` and `untested`. `sent` is true only when the provider took it; otherwise `not_sent` gives its words as `error`, a `message` with the fix where known, and `may_have_arrived` when the provider never answered. Always a 200.",
      example: {
        request: { to: "you@example.com" },
        response: {
          sent: true,
          not_sent: null,
          provider: "ses",
          to: "you@example.com",
          subject: "Hello, world",
          warnings: [],
          frozen: true,
        },
      },
      body: [
        {
          name: "to",
          type: "string",
          required: true,
          description: "The one address to send it to.",
        },
      ],
      errors: [notConnected],
      handler: renderRoutes.test,
    },
    ...devOnly(
      {
        method: "GET",
        path: "/api/dev/outbox",
        access: "admin",
        resource: "dev",
        title: "Read the fake outbox",
        summary: "Inspect the fake transport's outbox (local dev only).",
        description:
          "Answers `messages`, each email the fake transport took since the server started (`to`, `subject`, `html`, `text`, `providerId`, `sentAt`), and the `notifications` it would have sent. Held in memory, so a restart empties it.",
        handler: renderRoutes.devOutbox,
      },
      {
        method: "POST",
        path: "/api/dev/seed",
        access: "admin",
        accepts: FORM_UPLOAD,
        resource: "dev",
        title: "Load the demo dataset",
        summary: "Load the local demo dataset (local dev only).",
        description:
          "Resets the database first, as `POST /api/dev/reset` does, then loads the demo publication. Answers what it loaded: `subscribers` by status, `suppressions`, `audience`, `posts` by status, `deliveries`, `images_written`, `logo_written`, and `urls`.",
        query: [
          {
            name: "size",
            description:
              "`100`, `1k`, `10k`, or `100k`: a generated list of about that many subscribers in place of the curated one.",
          },
          {
            name: "seed",
            description: "Pins the generated list, so a `size` and `seed` repeat exactly.",
          },
        ],
        body: [
          {
            name: "image",
            type: "file[]",
            description: "The demo posts' images, each named `<post folder>/<file>`.",
          },
          { name: "logo", type: "file", description: "The demo publication's logo." },
        ],
        handler: devRoutes.seed,
      },
      {
        method: "POST",
        path: "/api/dev/reset",
        access: "admin",
        resource: "dev",
        title: "Reset the database",
        summary: "Reset the local database to a fresh install (local dev only).",
        description:
          "Clears every table, the settings included, and the uploaded logo. Answers `{ reset: true, url }`, `url` the editor's.",
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
      title: "Schedule a post",
      summary: `Freeze the render and schedule the send for a future time (at least ${formatLead(minLeadMs)} out).`,
      description:
        "Freezes the current draft, with the template and identity as they stand, and soft-locks the post until the send is canceled or fires; a later template or identity change re-makes the frozen email once the publisher confirms it. The minimum lead is " +
        lead +
        "; it is checked on the time as requested, which is then rounded up to the next whole minute. `email_only`, `slug`, and `slug_auto` set the post's settings as it is scheduled, checked before anything is frozen; none is part of the email.",
      example: {
        request: { fire_at: "2026-01-16T09:00:00Z" },
        response: { send: scheduledBrief, cursor: "57.1768467610000", warnings: [] },
      },
      body: [fireAtField, ...postSettingsFields],
      errors: [{ code: "fire_at_too_soon" }, activeSendExists, ...freezeRefusals],
      returns: { object: "send", as: "send", fields: [cursorField, freezeWarningsField] },
      handler: scheduleRoutes.schedule,
    },
    {
      method: "POST",
      path: "/api/posts/:id/send",
      access: "admin",
      accepts: JSON_BODY,
      resource: "posts",
      title: "Send a post now",
      summary:
        "Send now: freeze and schedule one minimum lead out, on the minute, cancelable until then. Idempotent per post.",
      description: `The same freeze as scheduling, \`fire_at\` now plus the minimum lead (${formatLead(minLeadMs)}, as Schedule a post describes), rounded up to the next whole minute. For nearly all that window the send is inside the lead, so a template or identity save that would re-make it is refused until it fires. The body is optional. A second call for a post already in its window answers with that send and changes nothing, its settings included.`,
      example: {
        request: { email_only: true },
        response: { send: scheduledBrief, cursor: "57.1768467610000", warnings: [] },
      },
      body: postSettingsFields,
      errors: [
        {
          ...activeSendExists,
          when: "The post already has its one active send and the body names settings it doesn't have, so a caller that asked for email only never reads success for a post going out listed.",
        },
        ...freezeRefusals,
      ],
      returns: {
        object: "send",
        as: "send",
        fields: [
          cursorField,
          freezeWarningsField,
          {
            name: "idempotent",
            type: "true",
            description:
              "Present on a repeat for a post already in its window, which changed nothing.",
          },
        ],
      },
      handler: scheduleRoutes.sendNow,
    },
    {
      method: "GET",
      path: "/api/sends",
      access: "admin",
      resource: "sends",
      title: "List sends",
      summary: "List sends, filtered, sorted, and paged, each its view.",
      description:
        "A row reads exactly as `GET /api/sends/:id` and the feed read the send, at the same moment. Pass the answer's `cursor` to `GET /api/sends/feed` as `since` to follow them.",
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
          description: "`fire_at` (default), `status`, `audience.count`, or `subject`.",
        },
        { name: "dir", description: "`asc` or `desc` (default `desc`)." },
        ...pageParams,
      ],
      returns: { object: "send", as: "sends", list: true, fields: [pageField, cursorField] },
      handler: sendRoutes.list,
    },
    {
      // Before /api/sends/:id, which would otherwise take "feed" as an id.
      method: "GET",
      path: "/api/sends/feed",
      access: "admin",
      resource: "sends",
      title: "Follow changes to sends",
      summary:
        "What changed among sends since a cursor, every open condition, and when to read again: how a client keeps up with sends without polling each one.",
      description:
        "Following changes, above, says what it reports and how to pace it. Each send is its view, read off its counters, never its delivery rows, so a send reads the same here as on its page; soonest fire first. Reading it changes nothing.",
      query: [
        {
          name: "since",
          description:
            "The `cursor` of an earlier read of sends. Omit it for the sends that can change on their own. A value this API did not issue is a 400 naming the field.",
        },
        {
          name: "limit",
          description: `The most changes after \`since\` one read reports: a whole number from 1 to ${sendRoutes.FEED_MAX_LIMIT} (default ${sendRoutes.FEED_DEFAULT_LIMIT}). Anything else is a 400 naming the field.`,
        },
      ],
      example: {
        response: {
          now: 1768467610000,
          sends: [sendBrief({ status: "scheduled", phase: "due", fire_at: 1768467600000 })],
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
      errors: [{ code: "cursor_ahead" }],
      returns: {
        object: "send",
        as: "sends",
        list: true,
        fields: [
          { name: "now", type: "number", description: "The server's clock at the read." },
          {
            name: "removed",
            type: "object[]",
            description:
              "Each send removed after `since` (a canceled send deleted with its post), `{ id, rev }`; empty without `since`.",
          },
          { ...cursorField, description: "Where this read stood, to pass as `since` next time." },
          {
            name: "more",
            type: "boolean",
            description: "True when more changes wait after `cursor`: read again at once.",
          },
          {
            name: "conditions",
            type: "object[]",
            description:
              "Every open condition across the sends that can have one (scheduled, sending, and recently sent), each with its `send_id` and `subject`, whether or not the send changed; most severe first.",
          },
          {
            name: "read_again_at",
            type: "number",
            description: "When to read again, by the server's clock. Advisory.",
          },
        ],
      },
      handler: sendRoutes.feed,
    },
    {
      method: "GET",
      path: "/api/sends/:id",
      access: "admin",
      resource: "sends",
      title: "Get a send",
      summary: "One send: its view, and the outcome breakdown of its record.",
      description:
        "The answer carries `ETag`: the send's `rev` and a tag of what the clock derives from it, so a request with `If-None-Match` answers 304 while nothing about the send has changed, written or derived. It carries no pace: to follow the send, read the feed at once from `cursor`.",
      example: {
        response: {
          send: sendBrief(),
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
      returns: {
        object: "send",
        as: "send",
        fields: [
          {
            name: "outcomes",
            type: "object",
            description:
              "The record's recipients by outcome, from its rows, summing to the audience at fire: `recipients`, `delivered`, `bounced`, `complained`, `unsent`, `skipped`, `accepted`, `in_flight`.",
          },
          cursorField,
        ],
      },
      handler: sendRoutes.get,
    },
    {
      method: "GET",
      path: "/api/sends/:id/email",
      access: "admin",
      resource: "sends",
      title: "Get a send's email",
      summary:
        "The send's frozen email, exactly as it will fire or went out, with the per-recipient placeholders unfilled: HTML, or its plain-text part.",
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
      title: "List a send's deliveries",
      summary:
        "The send's per-recipient delivery rows, filtered by outcome and paged. Read from the rows, the source of truth, so heavier than the send's view and not a poll target.",
      query: [
        {
          name: "view",
          description:
            "`failures` (default: bounced/complained/unsent), `delivered`, `all`, or a single bucket (`bounced`, `complained`, `unsent`, `skipped`, `accepted`, `in_flight`). Anything else is a 400 naming the field.",
        },
        { name: "search", description: "Email contains-search." },
        { name: "sort", description: "`email` (default), `status`, `event`, or `event_at`." },
        { name: "dir", description: "`asc` (default) or `desc`." },
        ...pageParams,
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
      returns: {
        fields: [
          {
            name: "deliveries",
            type: "object[]",
            description:
              "One row a recipient, as the record holds it: `email`; `status`, the hand-off (`pending`, `dispatched` awaiting the provider's answer, `accepted`, `unsent`, `skipped`); `event`, what the provider reported after (`delivered`, `bounced`, `complained`, or null), which a row counts under in place of `accepted`; `event_detail` and `event_at`; `error`, the last failed hand-off's words; `attempts`, its hand-offs tried; and `bounce_kind` (`hard` or `soft`) on a bounce.",
          },
          {
            name: "view",
            type: "string",
            description: "The view read, `failures` when none was asked.",
          },
        ],
      },
      handler: sendRoutes.deliveries,
    },
    {
      method: "GET",
      path: "/api/sends/:id/deliveries.csv",
      access: "admin",
      resource: "sends",
      title: "Export a send's deliveries",
      summary:
        "The send's per-recipient delivery record as CSV (`email`, `status`, `event`, `event_at` as ISO-8601, `error`), every row, unpaged.",
      handler: sendRoutes.deliveriesCsv,
    },
    {
      method: "POST",
      path: "/api/sends/:id/cancel",
      access: "admin",
      resource: "sends",
      title: "Cancel a send",
      summary: "Cancel a scheduled send during its review window; unlocks the post.",
      description:
        "The review window closes at the fire time. A send canceled already answers `changed: false`, so a retried cancel is safe.",
      example: {
        response: {
          send: sendBrief({ status: "canceled", phase: "canceled", rev: 58 }),
          cursor: "58.1768467620000",
          changed: true,
        },
      },
      errors: [
        {
          code: "window_closed",
          when: "The fire time has passed, whether or not the sweep has started the send.",
          details: ["send", "cursor"],
        },
      ],
      returns: { object: "send", as: "send", fields: [cursorField, changedField] },
      handler: sendRoutes.cancel,
    },
    {
      method: "POST",
      path: "/api/sends/:id/reschedule",
      access: "admin",
      accepts: JSON_BODY,
      resource: "sends",
      title: "Reschedule a send",
      summary: "Move a scheduled send's fire time without re-freezing the render.",
      description: `Moves only \`fire_at\`, within the review window: the frozen email is untouched and a re-made send keeps its \`remade_at\`. For a content change, cancel, edit, and schedule again. The same minimum lead as scheduling (${formatLead(minLeadMs)}, as Schedule a post describes), and the time is rounded up to the next whole minute as when scheduling. A move to the time it already has answers \`changed: false\` before the lead is checked. \`email_only\`, \`slug\`, or \`slug_auto\` is a 400: those are the post's, at \`PUT /api/posts/:id/settings\`. The editor's "Edit schedule" is this route and that one together, so a publisher who asks to edit the schedule may mean the time, the post's settings, or both.`,
      example: {
        request: { fire_at: "2026-01-16T09:00:00Z" },
        response: {
          send: { ...scheduledBrief, rev: 58 },
          cursor: "58.1768467620000",
          changed: true,
        },
      },
      body: [fireAtField],
      errors: [
        { code: "fire_at_too_soon" },
        { code: "window_closed", details: ["send", "cursor"] },
        { code: "send_canceled", details: ["send", "cursor"] },
      ],
      returns: { object: "send", as: "send", fields: [cursorField, changedField] },
      handler: sendRoutes.reschedule,
    },
    {
      method: "POST",
      path: "/api/sends/:id/resolve",
      access: "admin",
      accepts: JSON_BODY,
      resource: "sends",
      title: "Resolve a wedged send",
      summary: "Resolve a send wedged on ambiguous (dispatched) deliveries.",
      description:
        "A request that got no answer leaves its recipients `dispatched`, which the loop never re-sends, so the send can't finish. This settles them as `resolution` says and completes the send, never re-mailing an accepted recipient. Offered in `actions` while the send is wedged; no run touches a wedged send, so it settles the recipients the send showed.",
      example: {
        request: { resolution: "unsent" },
        response: {
          send: sendBrief({ status: "sent", phase: "settling", rev: 58 }),
          cursor: "58.1768467620000",
          resolved: 12,
          completed: true,
        },
      },
      body: [
        {
          name: "resolution",
          type: '"unsent" | "accepted"',
          required: true,
          description:
            'The publisher\'s choice, after you relay the `wedged` condition\'s message; never choose it yourself. `unsent`, the editor\'s "Assume not sent": assume they were not sent, so the address is picked up by the next post. `accepted`, its "Assume sent": assume they were sent.',
        },
      ],
      errors: [
        {
          code: "run_in_progress",
          when: "A run holds the send, and its in-flight rows may still get the provider's answer: try again a moment later.",
          details: ["send", "cursor"],
        },
        {
          code: "not_wedged",
          when: "The send is not wedged (nothing ambiguous, recipients still to hand off, or a run yet to look at them), as when another Resolve has settled it.",
          details: ["send", "cursor"],
        },
      ],
      returns: {
        object: "send",
        as: "send",
        fields: [
          cursorField,
          { name: "resolved", type: "number", description: "How many recipients it settled." },
          { name: "completed", type: "boolean", description: "Whether the send then finished." },
        ],
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
      title: "Add a subscriber",
      summary: "Add a subscriber via the normal double opt-in (never an auto-confirm).",
      description:
        "An address that was erased is added only once the publisher confirms the person asked to join again. The confirmation then goes as usual, and the person's own confirming lifts the marker. The public form never asks.",
      example: { request: { email: "reader@example.com" } },
      body: [
        { name: "email", type: "string", required: true, description: "The address to add." },
        {
          name: "acknowledge_erasure",
          type: "boolean",
          description:
            "`true` once the publisher confirms that a person whose address was erased asked to join again.",
        },
      ],
      errors: [
        { code: "erasure_acknowledgement_required", details: ["erased_at"] },
        {
          ...notConnected,
          when: "No email provider is connected, so the confirmation could not go; nothing is stored.",
        },
        { code: "confirmation_not_sent" },
      ],
      returns: {
        object: "subscriber",
        as: "subscriber",
        fields: [
          {
            name: "action",
            type: "string",
            description:
              "What adding it did: `created`, `resubscribed`, or `pending_resent` sent a confirmation; `already_confirmed`, `suppressed` (when `subscriber` is null, an address never on the list), or `recently_sent` (inside the cooldown) sent none.",
          },
        ],
      },
      handler: subscriberRoutes.create,
    },
    {
      method: "GET",
      path: "/api/subscribers",
      access: "admin",
      resource: "subscribers",
      title: "List subscribers",
      summary: "List subscribers, filtered, sorted, and paged, with the list's counts.",
      description:
        "`status` filters the roster by consent, and `suppressed` is a facet over it. An address suppressed with no subscriber is listed only by `GET /api/suppressions`. Pass `email` instead to look up one subscriber.",
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
        {
          name: "sort",
          description: "`created_at` (default), `confirmed_at`, `email`, or `status`.",
        },
        { name: "dir", description: "`asc` or `desc` (default `desc`)." },
        ...pageParams,
        {
          name: "email",
          description:
            "An exact address: answers `{ subscriber }`, as `GET /api/subscribers/:id` does, in place of the list, or 404 when no one has it.",
        },
      ],
      returns: {
        object: "subscriber",
        as: "subscribers",
        list: true,
        fields: [
          {
            name: "counts",
            type: "object",
            description:
              "The whole list, whatever the filter: `pending`, `confirmed`, `unsubscribed`, and `suppressed`, subscribers whose address is suppressed whatever their status, so it overlaps the others and matches `suppressed=only`.",
          },
          {
            name: "workers_plan_advice",
            type: "string | null",
            description: `On the Workers Free plan's limits (\`SUBREQUEST_BUDGET\` unset), once \`counts.confirmed\` passes ${FREE_PLAN_LIST.toLocaleString("en-US")}: the server's words advising Workers Paid, to show or relay as they stand; else null. Kestrel judges the plan from its config, so the words also cover an account already on Paid whose budget was never raised.`,
          },
          pageField,
        ],
      },
      handler: subscriberRoutes.list,
    },
    {
      // Before `/api/subscribers/:id`, which would otherwise take `export` as an id.
      method: "GET",
      path: "/api/subscribers/export",
      access: "admin",
      resource: "subscribers",
      title: "Export the list",
      summary: "The whole list in the import format (`kestrel-subscribers/1`), a page at a time.",
      description:
        "Every subscriber (`confirmed` written as `subscribed`) with how they joined, their evidence, and their suppression, plus every address suppressed with no subscriber (`status: none`). Importing it into another instance carries the list over. Pages run in address order: following `next` until `null` reads every address once, the server setting the page size (1,000 on the Workers Free plan's limits, 10,000 otherwise). For a CSV, write the rows under the format's header once, a value starting `=`, `+`, `-`, or `@` led by a `'` so a spreadsheet won't run it.",
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
      title: "Get a subscriber",
      summary: "One subscriber.",
      returns: { object: "subscriber", as: "subscriber" },
      handler: subscriberRoutes.get,
    },
    {
      method: "POST",
      path: "/api/subscribers/:id/unsubscribe",
      access: "admin",
      resource: "subscribers",
      title: "Unsubscribe a subscriber",
      summary: "Unsubscribe a subscriber at their request.",
      description: `${SUBSCRIBER_ACTIONS.unsubscribe.when} Immediate and idempotent, as their own unsubscribe link is: it removes consent and never confirms anyone. To stop mailing an address on your own judgment, block it instead (\`POST /api/suppressions\`), which records that the decision was yours.`,
      returns: { object: "subscriber", as: "subscriber" },
      handler: subscriberRoutes.unsubscribe,
    },
    {
      method: "POST",
      path: "/api/subscribers/:id/erase",
      access: "admin",
      resource: "subscribers",
      title: "Erase a subscriber",
      summary:
        "Erase a subscriber: remove their data and keep only a do-not-contact marker. Can't be undone.",
      description:
        `${SUBSCRIBER_ACTIONS.erase.when} Unsubscribing stops the mail and keeps everything; erasing removes what the list knows about them. ` +
        "One batch: deletes the subscriber's row and evidence, replaces their address on every past delivery row with one placeholder (`erased:` and random hex, so each record still sums to its audience), and suppresses the address as `erased`, unless it already has a bounce, complaint, or block, which it keeps. Answers `erased`: the `email`, how many `deliveries` show the placeholder, and the `suppression` left. Only their own confirmation lifts the marker, never an import, and `POST /api/subscribers` asks for `acknowledge_erasure` first. Nothing of the id is kept, so a repeat answers 404. A later receipt on an erased row keeps its outcome without the provider's words; a bounce or complaint suppresses its address, replacing the marker.",
      example: {
        response: {
          erased: { email: "reader@example.com", deliveries: 12, suppression: "erased" },
        },
      },
      errors: [
        {
          code: "run_in_progress",
          when: "A send run is handing the subscriber to the provider: nothing changes, try again a moment later.",
          details: ["subscriber"],
        },
      ],
      handler: subscriberRoutes.erase,
    },

    // --- imports (authed admin) ---
    {
      method: "GET",
      path: "/api/imports/format",
      access: "admin",
      resource: "imports",
      title: "Get the import format",
      summary:
        "Everything about the import format, from the definition the importer reads with: the files it takes, the columns, the rules, this deployment's limits, the outcomes, and the attestation.",
      description:
        "Read it before converting a list. The full CSV (`kestrel-subscribers/1`, what the export writes) is preferred, since it carries unsubscribes, bounces, and how each person joined; a plain `.txt` of addresses is the fallback. Another service's export is converted first; nothing is guessed. Split a list larger than `limits` into several imports, each its own plan and commit.",
      returns: {
        fields: [
          {
            name: "format",
            type: "string",
            description: "The format's name, `kestrel-subscribers/1`.",
          },
          {
            name: "versions",
            type: "string[]",
            description: "The format versions an import reads.",
          },
          {
            name: "preferred",
            type: "{ kind, why }",
            description: "The file to prefer (`csv`), and why, in words to relay.",
          },
          {
            name: "files",
            type: "object[]",
            description:
              "Each file an import takes: `kind` (`csv` or `txt`), `name`, `when` to use it, `loses` (what a list loses in it, each a sentence to relay; empty for the CSV), and its `template` route.",
          },
          {
            name: "columns",
            type: "object[]",
            description:
              "The CSV's columns, in order: `name`, `required`, `values` (a fixed set, or null), `takes` (what it takes otherwise), and `meaning`.",
          },
          {
            name: "plain_list",
            type: "{ statuses, default, rules }",
            description:
              "A plain list's declared `statuses` (each `{ value, means }`, the `plain_list_status` a plan takes), the `default`, and its `rules` in words.",
          },
          {
            name: "limits.max_rows",
            type: "number",
            description: `The most rows this deployment takes in one import: ${IMPORT_LIMITS.maxRows.toLocaleString("en-US")}, or ${IMPORT_LIMITS.maxRowsFree.toLocaleString("en-US")} on the Workers Free plan's limits. More is refused as \`too_many_rows\`.`,
          },
          {
            name: "limits.max_rows_reason",
            type: "string | null",
            description:
              "Why `max_rows` is below the format's own, in words to relay to the publisher; null when it isn't.",
          },
          {
            name: "limits.max_body_bytes",
            type: "number",
            description: `The most bytes the request, and the file's text, may hold: ${IMPORT_LIMITS.maxBodyBytes / (1024 * 1024)} MB. More is refused as \`body_too_large\`.`,
          },
          {
            name: "limits.max_evidence_bytes",
            type: "number",
            description: `The most bytes one row's \`evidence\` may hold, as JSON: ${IMPORT_LIMITS.maxEvidenceBytes}. More is refused as \`invalid_field\`, naming the row.`,
          },
          {
            name: "outcomes",
            type: "object[]",
            description:
              "Every outcome a plan counts a row under (its `counts` keys), each `{ outcome, when }`.",
          },
          {
            name: "attestation",
            type: "{ version, text }",
            description:
              "What the publisher attests when an import confirms anyone; a plan answers it with the publication named.",
          },
        ],
      },
      handler: importRoutes.format,
    },
    {
      method: "GET",
      path: "/api/imports/template.csv",
      access: "admin",
      resource: "imports",
      title: "Get the CSV template",
      summary:
        "A CSV template in the import format, showing its cases; uploaded unchanged it plans cleanly.",
      handler: importRoutes.templateCsv,
    },
    {
      method: "GET",
      path: "/api/imports/template.txt",
      access: "admin",
      resource: "imports",
      title: "Get the plain-list template",
      summary: "A plain-list template: one address per line.",
      handler: importRoutes.templateTxt,
    },
    {
      method: "POST",
      path: "/api/imports/plan",
      access: "admin",
      accepts: JSON_BODY,
      resource: "imports",
      title: "Plan an import",
      summary:
        "Plan an import: what it would do to every row against the list as it stands. Writes nothing, so call it as often as a file needs.",
      description: "The outcomes and when each applies are in `GET /api/imports/format`.",
      example: {
        request: {
          file: {
            name: "subscribers.csv",
            text: "email,status,opt_in,origin\r\nada@example.com,subscribed,double,sendy\r\nedsger@example.com,unsubscribed,unknown,sendy\r\n",
          },
        },
      },
      body: importFileFields,
      errors: importRefusals,
      returns: { object: "import_plan" },
      handler: importRoutes.planRoute,
    },
    {
      method: "POST",
      path: "/api/imports",
      access: "admin",
      accepts: JSON_BODY,
      resource: "imports",
      title: "Commit an import",
      summary:
        "Commit a plan: apply it all, or nothing, in one batch, and keep the import's record. Never sends an email.",
      description:
        "Send the plan's body with what it asked for. It plans again and applies only the plan whose hash it names. Every write re-checks the list as it stands, so a reader who unsubscribed meanwhile stays unsubscribed, and `differed` lists each row whose result changed. A service token may attest; the record says so, and the publisher is emailed the counts. Answers 201 with the `import` record (never an address), `counts`, `suppressions_added`, `rows`, `differed`, and `replayed: false`; a repeat of the same plan and file answers 200 with the stored record and `replayed: true`.",
      example: {
        request: {
          file: { name: "subscribers.csv", text: "email,status,opt_in,origin\r\n…" },
          plan_hash: "9f2c…",
          attestation: { version: 1, accepted: true },
          acknowledge_sends: ["s_xyz789"],
        },
      },
      body: [
        ...importFileFields,
        {
          name: "plan_hash",
          type: "string",
          required: true,
          description: "The `plan_hash` the plan returned.",
        },
        {
          name: "attestation.version",
          type: "number",
          description: "The `attestation.version` the plan returned, when it returned one.",
        },
        {
          name: "attestation.accepted",
          type: "true",
          description: "The publisher's acceptance of the attestation's words.",
        },
        {
          name: "acknowledge_sends",
          type: "string[]",
          description:
            "The id of every send in the plan's `sends_growing`. Only a person can give it: a service token is refused `sends_acknowledgement_required` whatever it sends, and the publisher finishes that import in the dashboard.",
        },
      ],
      errors: [
        {
          code: "plan_stale",
          when: "The plan differs from `plan_hash`: the file, its declared meaning, whether an attestation is needed, or the growing sends changed, or another import was committed since. Plan again.",
        },
        { code: "attestation_required", details: ["attestation"] },
        { code: "sends_acknowledgement_required", details: ["sends"] },
        ...importRefusals,
      ],
      handler: importRoutes.commit,
    },

    // --- suppressions (authed admin) ---
    {
      method: "GET",
      path: "/api/suppressions",
      access: "admin",
      resource: "suppressions",
      title: "List suppressions",
      summary: "List suppressed addresses, with why.",
      description: "Newest first, up to 1,000, whether or not the address is on the list.",
      returns: { object: "suppression", as: "suppressions", list: true },
      handler: suppressionRoutes.list,
    },
    {
      method: "POST",
      path: "/api/suppressions",
      access: "admin",
      accepts: JSON_BODY,
      resource: "suppressions",
      title: "Block an address",
      summary: "Block an address: the publisher's own decision to stop mailing it.",
      description: `${SUBSCRIBER_ACTIONS.block.when} Stores a suppression with \`reason\` \`manual\`, and changes no consent status. If they asked to leave, unsubscribe them instead (\`POST /api/subscribers/:id/unsubscribe\`). An address already suppressed keeps what it has, its \`detail\` included.`,
      example: {
        request: { email: "reader@example.com", detail: "Our own test address" },
        response: {
          suppression: {
            email: "reader@example.com",
            reason: "manual",
            detail: "Our own test address",
            created_at: 1760400000000,
          },
          added: true,
        },
      },
      body: [
        { name: "email", type: "string", required: true, description: "The address to block." },
        {
          name: "reason",
          type: '"manual"',
          description:
            "May be omitted. Any other is a 400: a bounce or complaint is the provider's to report, an erasure's marker Erase's to leave.",
        },
        { name: "detail", type: "string", description: "Why, in the publisher's words." },
      ],
      returns: {
        object: "suppression",
        as: "suppression",
        fields: [
          {
            name: "added",
            type: "boolean",
            description:
              "False when the address was already suppressed: the suppression that stands, answered 200 rather than 201.",
          },
        ],
      },
      handler: suppressionRoutes.add,
    },
    {
      method: "DELETE",
      path: "/api/suppressions/:email",
      access: "admin",
      resource: "suppressions",
      title: "Unblock or clear an address",
      summary: "Lift an address's suppression, so it may be mailed again.",
      description: `Both of the editor's acts that lift a suppression: "Unblock" for the publisher's own block, when they decide to mail the address again, and "Clear" for a bounce or a complaint. ${SUBSCRIBER_ACTIONS.clear.when} Either is a deliberate, rare act, on the publisher's word. An erasure's marker is never cleared here; an erasure that found a block keeps the block, and clearing it clears the address. Answers \`cleared: false\` when there was no suppression.`,
      example: { response: { email: "reader@example.com", cleared: true } },
      errors: [{ code: "erasure_marker", details: ["suppression"] }],
      handler: suppressionRoutes.clear,
    },

    // --- provider webhooks (public; signature-verified inside the adapter) ---
    {
      method: "POST",
      path: "/webhooks/ses",
      access: "webhook",
      resource: "sends",
      title: "Receive SES notifications",
      summary:
        "Amazon SNS's subscription handshake and SES's delivery, bounce, and complaint events, each request SNS-signature-verified.",
      description:
        "The provider's to call, never a client's. An event lands on its send's delivery rows; a hard bounce or a complaint also suppresses the address.",
      handler: webhookRoutes.ses,
    },

    // --- public reader routes (token-scoped; no login) ---
    // The front door: a self-contained home page, never a bounce to the
    // Access-gated admin SPA at /dashboard (SPEC §11). Kept public here — the one
    // explicit non-admin surface.
    {
      method: "GET",
      path: "/",
      access: "public",
      resource: "archive",
      title: "Show the home page",
      summary:
        "The newsletter's public home page: identity, the latest post, and a subscribe call to action.",
      handler: archiveRoutes.landing,
    },
    {
      // What an agent arriving at the instance reads first: the publication, the public
      // pages, and the Markdown behind Access, generated from these routes. Plain text, so
      // naming a gated path for an agent never links a reader into the login.
      method: "GET",
      path: "/llms.txt",
      access: "public",
      resource: "system",
      title: "Describe the instance to agents",
      summary:
        "The instance described for an agent in the llms.txt convention (text/plain): the publication's name, its public archive and subscribe page, and the API reference and docs behind Access.",
      description:
        "Public, so an agent with no credential learns where to start. Every path it names is generated from the registered routes, each listed under the access its route has.",
      handler: (c) =>
        llmsRoutes.llmsTxt(
          c,
          r.routes.map((route) => route.def),
        ),
    },
    {
      method: "GET",
      path: "/subscribe",
      access: "public",
      resource: "subscriptions",
      title: "Show the subscribe form",
      summary:
        "The public subscribe form (HTML); while no email provider is connected, a page saying signups aren't open yet.",
      handler: publicRoutes.subscribeForm,
    },
    {
      method: "POST",
      path: "/subscribe",
      access: "public",
      resource: "subscriptions",
      title: "Request a subscription",
      summary: "Request a subscription; starts the double opt-in (confirmation email).",
      description:
        "Answers alike whatever the address's state, before any confirmation is sent, so neither the reply nor its timing reveals list membership. A confirmation goes out only when due: never to a confirmed or suppressed address, at most one per cooldown. One the provider refuses is logged and changes nothing.",
      example: {
        request: { email: "you@example.com" },
        response: { status: "check_inbox" },
      },
      errors: [
        {
          ...notConnected,
          when: "No email provider is connected: every request alike, as JSON or the page saying signups aren't open yet, and nothing is stored.",
        },
      ],
      handler: publicRoutes.subscribe,
    },
    {
      method: "GET",
      path: "/confirm",
      access: "public",
      resource: "subscriptions",
      title: "Show the confirmation page",
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
      title: "Confirm a subscription",
      summary: "Confirm a subscription: the landing page's button (form field `token`).",
      handler: publicRoutes.confirm,
    },
    {
      method: "GET",
      path: "/unsubscribe",
      access: "public",
      resource: "subscriptions",
      title: "Show the unsubscribe page",
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
      title: "Process an unsubscribe",
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

    // --- unlisted links (public; the "view in browser" every email carries, SPEC §5) ---
    // On the app's own origin and independent of ARCHIVE_BASE_PATH, so moving the archive
    // breaks no email already sent.
    {
      method: "GET",
      path: `${UNLISTED_PATH}/:token`,
      access: "public",
      resource: "archive",
      title: "Open an unlisted link",
      summary: "A post's unlisted link, the view-in-browser link every test and send carries.",
      description:
        "Before the post's send starts, the `Nothing here yet` page (404). Then, while the post is listed, a 302 to its archive address (`no-store`, `noindex`), and while it is email only, the post's page itself (`noindex`). Never listed or linked from any page, and a GET only reads, so a link scanner changes nothing.",
      handler: archiveRoutes.unlistedPage,
    },

    // --- archive (public; serves the frozen record, I3) ---
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
      title: "Show the archive",
      summary:
        "The public archive index: every published post (its send has started), newest first.",
      handler: archiveRoutes.archiveIndex,
    },
    {
      method: "GET",
      path: `${archiveBasePath}/:slug`,
      access: "public",
      resource: "archive",
      title: "Show an archived post",
      summary:
        "A published post's archive page, from the moment a listed post's send starts, while it stays listed.",
      description:
        "An email-only post's address answers `Nothing here yet` (404) but stays the post's. A post whose email links this address (one sent before unlisted links) answers whatever its listing, `noindex` while email only. Sent `no-cache`, so a listing change shows at once.",
      handler: archiveRoutes.archivePage,
    },

    // --- media bytes (public; readers + archive load these unauthenticated) ---
    {
      method: "GET",
      path: "/media/:key(.*)",
      access: "public",
      resource: "archive",
      title: "Serve an image",
      summary:
        "An image's bytes from storage: a post's images and the logo, as emails and reader pages load them.",
      description:
        "`key` is the image's storage key, the end of its `url`. Cached an hour. A key that names nothing is a 404.",
      handler: imageRoutes.serveMedia,
    },
  ];

  for (const def of manifest) {
    r.register(def);
  }

  return r;
}
