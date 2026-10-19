import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPORT_LIMITS } from "../shared/imports";
import type { RouteError } from "../shared/reference";
import { createRouter } from "../src/app";
import * as sends from "../src/db/sends";
import { updateSettings } from "../src/db/settings";
import { type AppEnv, getConfig } from "../src/env";
import { clearFakeNotifications, failFakeNotify } from "../src/notify/fake";
import { clearFakeOutbox, failFakeSendBatch } from "../src/providers/fake";
import { buildReference } from "../src/reference";
import { REFUSAL_MOVE, REFUSAL_STATUS, type RefusalCode } from "../src/reference/refusals";
import {
  clearLogos,
  frozenSend,
  resetDatabase,
  seedConfirmed,
  setRow,
  tpl,
} from "./support/fixtures";
import { AUTH, base, JSON_AUTH, PNG_1x1, readJson } from "./support/http";
import { allowErrorLogs } from "./support/log";
import { fetchWith } from "./support/worker_env";

// A refusal carries what the reference says it does (docs/API.md, "Refusing"): each route's
// documented codes, driven through the real router, answer a body whose fields beside `error`
// and `message` are the route's `details`, no more and no fewer. `field` is the one field no
// route lists under Fix the request, since the Errors topic states it once for that group.

const router = createRouter(getConfig(env as AppEnv));
const listed = new Map<string, RouteError>(
  buildReference(router.routes.map((r) => r.def))
    .flatMap((g) => g.routes)
    .flatMap((r) => (r.errors ?? []).map((e) => [`${r.method} ${r.path} ${e.code}`, e] as const)),
);

const FIX_REQUEST = "Fix the request";
const HOUR = 3_600_000;
const PREVIEW_NOT_CONNECTED = { SIMULATE_SENDS: "not-connected" };

const call = (method: string, path: string, body?: unknown) =>
  SELF.fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? AUTH : JSON_AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The same request to a local instance previewing no provider (SPEC §10): sign-in stays on. */
const notConnected = (method: string, path: string, body?: unknown) =>
  fetchWith(PREVIEW_NOT_CONNECTED, path, {
    method,
    headers: body === undefined ? AUTH : JSON_AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A draft made through the API, its id. */
async function draft(body: Record<string, unknown> = {}): Promise<string> {
  const res = await call("POST", "/api/posts", { subject: "Owls", markdown: "# Hi", ...body });
  expect(res.status).toBe(201);
  return (await readJson(res)).post.id;
}

/** A draft's current revision, for a save to name. */
async function currentRevision(id: string): Promise<string> {
  return (await readJson(await call("GET", `/api/posts/${id}`))).post.current_revision;
}

/** A draft scheduled an hour out through the API: the post and its send. */
async function scheduled(body: Record<string, unknown> = {}) {
  const id = await draft(body);
  const res = await call("POST", `/api/posts/${id}/schedule`, { fire_at: Date.now() + HOUR });
  expect(res.status).toBe(201);
  return { id, send: (await readJson(res)).send as { id: string } };
}

/** A draft sent now through the API, its send moved a minute sooner, since a send-now's fire
 *  time is rounded up to the minute and so can sit just outside the lead: the send's id. */
async function insideLead(): Promise<string> {
  const res = await call("POST", `/api/posts/${await draft()}/send`, {});
  expect(res.status).toBe(201);
  const { send } = await readJson(res);
  await setRow(send.id, { fire_at: send.fire_at - 60_000 });
  return send.id;
}

/** A post whose send has gone out, so its address is fixed. */
async function sent(): Promise<string> {
  const send = await frozenSend(Date.now() - 60_000);
  await setRow(send.id, {
    status: "sent",
    started_at: Date.now() - 60_000,
    completed_at: Date.now(),
  });
  await env.DB.prepare("UPDATE posts SET status = 'sent' WHERE id = ?").bind(send.post_id).run();
  return send.post_id;
}

/** A scheduled post whose email, frozen before unlisted links, already links its address. */
async function linked(): Promise<string> {
  const s = await scheduled();
  await setRow(s.send.id, { web_link: "archive" });
  return s.id;
}

const imageForm = () => {
  const f = new FormData();
  f.append("file", new File([PNG_1x1], "logo.png", { type: "image/png" }));
  return f;
};
const upload = (path: string) =>
  SELF.fetch(`${base}${path}`, { method: "POST", headers: AUTH, body: imageForm() });

/** A template that renders the logo, so a logo change re-makes the scheduled sends. */
async function logoInTemplate(): Promise<void> {
  await updateSettings(env.DB, {
    email_template: `${tpl("v1")}<img src="{{ .Publication.LogoURL }}">`,
  });
}

const HEADER =
  "email,status,opt_in,origin,suppression,subscribed_at,confirmed_at,unsubscribed_at,suppressed_at,evidence";
const csv = (...lines: string[]) => ({
  name: "list.csv",
  text: `${[HEADER, ...lines].join("\r\n")}\r\n`,
});
const confirmedRow = "a@x.io,subscribed,double,sendy,,,,,,";

async function planHash(file: { name: string; text: string }): Promise<string> {
  const res = await call("POST", "/api/imports/plan", { file });
  expect(res.status).toBe(200);
  return (await readJson(res)).plan_hash;
}

/** A confirmed subscriber in no send, whom Erase takes at once: their id. */
async function erasable(email: string): Promise<string> {
  await seedConfirmed(email);
  return `id-${email}`;
}

/** An erased address: erased through the API, so its marker stands. */
async function erased(email: string): Promise<void> {
  expect((await call("POST", `/api/subscribers/${await erasable(email)}/erase`)).status).toBe(200);
}

/** A subscriber whose row a send run holds right now, its lease not yet run out: their id. */
async function handedOff(email: string): Promise<string> {
  await seedConfirmed(email);
  const send = await frozenSend(Date.now() - 1000);
  await sends.resolveAudience(env.DB, send.id, Date.now());
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE sends SET status = 'sending', locked_until = ?, lease_token = 'run' WHERE id = ?",
    ).bind(Date.now() + 60_000, send.id),
    env.DB.prepare(
      "UPDATE deliveries SET status = 'dispatched', dispatch_key = 'k' WHERE send_id = ?",
    ).bind(send.id),
  ]);
  return `id-${email}`;
}

/** One way to meet a refusal a route lists. */
interface Case {
  /** The route and the code, as `METHOD /path code`. */
  refusal: string;
  /** What brings it about, as the test's title says it. */
  when: string;
  run: () => Promise<Response>;
  /** The route's details this way of meeting it doesn't carry (an optional `column`, say). */
  omits?: string[];
  /** A Fix the request refusal no one field is at fault for (a body over the size). */
  noField?: boolean;
  /** Error log lines the refusal writes on purpose. */
  logs?: string[];
}

/** The import refusals, met the same ways on the plan and on the commit, which plans again. */
function importCases(route: "POST /api/imports/plan" | "POST /api/imports"): Case[] {
  const send = (file: unknown) =>
    call("POST", route.slice("POST ".length), {
      file,
      ...(route === "POST /api/imports" ? { plan_hash: "h" } : {}),
    });
  return [
    {
      refusal: `${route} unrecognized_format`,
      when: "a file of another kind",
      run: () => send({ name: "list.pdf", text: "a@x.io" }),
      omits: ["row", "column", "allowed"],
    },
    {
      refusal: `${route} unrecognized_format`,
      when: "a table sent as a plain list",
      run: () => send({ name: "list.txt", text: "a@x.io,b@x.io" }),
      omits: ["column", "allowed"],
    },
    {
      refusal: `${route} unrecognized_format`,
      when: "a row in a format version this release can't read",
      run: () =>
        send({ name: "list.csv", text: `${HEADER},format\r\n${confirmedRow},kestrel-v99\r\n` }),
    },
    {
      refusal: `${route} invalid_field`,
      when: "a value its column doesn't take",
      run: () => send(csv("a@x.io,active,double,sendy,,,,,,")),
    },
    {
      refusal: `${route} too_many_rows`,
      when: "a file over the limit",
      run: () =>
        send({
          name: "big.txt",
          text: Array.from({ length: IMPORT_LIMITS.maxRowsFree + 1 }, (_, i) => `r${i}@x.io`).join(
            "\n",
          ),
        }),
    },
    {
      refusal: `${route} body_too_large`,
      when: "a request over the fixed size",
      run: () => send({ name: "big.txt", text: "a".repeat(IMPORT_LIMITS.maxBodyBytes + 1) }),
      noField: true,
    },
  ];
}

const CASES: Case[] = [
  // --- posts ---
  {
    refusal: "POST /api/posts slug_invalid",
    when: "a malformed slug",
    run: () => call("POST", "/api/posts", { subject: "Owls", slug: "Not A Slug" }),
  },
  {
    refusal: "POST /api/posts slug_taken",
    when: "another post's slug",
    run: async () => {
      await draft({ slug: "taken" });
      return call("POST", "/api/posts", { subject: "Owls", slug: "taken" });
    },
  },
  {
    refusal: "PUT /api/posts/:id base_required",
    when: "a save naming no revision",
    run: async () => call("PUT", `/api/posts/${await draft()}`, { markdown: "v2" }),
  },
  {
    refusal: "PUT /api/posts/:id stale_revision",
    when: "a save on a revision that isn't the current one",
    run: async () =>
      call("PUT", `/api/posts/${await draft()}`, { markdown: "v2", base_revision: "r_old" }),
  },
  {
    refusal: "PUT /api/posts/:id post_not_draft",
    when: "a save of a scheduled post",
    run: async () =>
      call("PUT", `/api/posts/${(await scheduled()).id}`, { markdown: "v2", base_revision: "r" }),
  },
  {
    refusal: "PUT /api/posts/:id slug_invalid",
    when: "a save with a malformed slug",
    run: async () => {
      const id = await draft();
      return call("PUT", `/api/posts/${id}`, {
        slug: "Not A Slug",
        base_revision: await currentRevision(id),
      });
    },
  },
  {
    refusal: "PUT /api/posts/:id slug_taken",
    when: "a save with another post's slug",
    run: async () => {
      await draft({ slug: "taken" });
      const id = await draft();
      return call("PUT", `/api/posts/${id}`, {
        slug: "taken",
        base_revision: await currentRevision(id),
      });
    },
  },
  {
    refusal: "DELETE /api/posts/:id post_not_draft",
    when: "deleting a scheduled post",
    run: async () => call("DELETE", `/api/posts/${(await scheduled()).id}`),
  },
  {
    refusal: "PUT /api/posts/:id/settings slug_invalid",
    when: "a malformed slug",
    run: async () => call("PUT", `/api/posts/${await draft()}/settings`, { slug: "Not A Slug" }),
  },
  {
    refusal: "PUT /api/posts/:id/settings slug_taken",
    when: "another post's slug",
    run: async () => {
      await draft({ slug: "taken" });
      return call("PUT", `/api/posts/${await draft()}/settings`, { slug: "taken" });
    },
  },
  {
    refusal: "PUT /api/posts/:id/settings slug_permanent",
    when: "moving an address its scheduled email links",
    run: async () => call("PUT", `/api/posts/${await linked()}/settings`, { slug: "moved" }),
  },
  {
    refusal: "POST /api/posts/:id/images post_not_draft",
    when: "an image for a scheduled post",
    run: async () => upload(`/api/posts/${(await scheduled()).id}/images`),
  },
  {
    refusal: "DELETE /api/posts/:id/images/:filename post_not_draft",
    when: "removing an image from a scheduled post",
    run: async () => call("DELETE", `/api/posts/${(await scheduled()).id}/images/logo.png`),
  },
  {
    refusal: "POST /api/posts/:id/test provider_not_connected",
    when: "no provider",
    run: async () => notConnected("POST", `/api/posts/${await draft()}/test`, { to: "you@x.io" }),
  },

  // --- schedule and send now ---
  {
    refusal: "POST /api/posts/:id/schedule fire_at_too_soon",
    when: "a fire time inside the lead",
    run: async () =>
      call("POST", `/api/posts/${await draft()}/schedule`, { fire_at: Date.now() + 1000 }),
  },
  {
    refusal: "POST /api/posts/:id/schedule active_send_exists",
    when: "a draft that already has its active send",
    run: async () => {
      const send = await frozenSend(Date.now() + HOUR);
      return call("POST", `/api/posts/${send.post_id}/schedule`, {
        fire_at: Date.now() + 2 * HOUR,
      });
    },
  },
  {
    refusal: "POST /api/posts/:id/schedule post_not_draft",
    when: "scheduling a sent post",
    run: async () =>
      call("POST", `/api/posts/${await sent()}/schedule`, { fire_at: Date.now() + HOUR }),
  },
  {
    refusal: "POST /api/posts/:id/schedule subject_required",
    when: "an empty subject",
    run: async () =>
      call("POST", `/api/posts/${await draft({ subject: "" })}/schedule`, {
        fire_at: Date.now() + HOUR,
      }),
  },
  {
    refusal: "POST /api/posts/:id/schedule provider_not_connected",
    when: "no provider",
    run: async () =>
      notConnected("POST", `/api/posts/${await draft()}/schedule`, { fire_at: Date.now() + HOUR }),
  },
  {
    refusal: "POST /api/posts/:id/schedule slug_invalid",
    when: "a malformed slug in the same act",
    run: async () =>
      call("POST", `/api/posts/${await draft()}/schedule`, {
        fire_at: Date.now() + HOUR,
        slug: "Not A Slug",
      }),
  },
  {
    refusal: "POST /api/posts/:id/schedule slug_taken",
    when: "another post's slug in the same act",
    run: async () => {
      await draft({ slug: "taken" });
      return call("POST", `/api/posts/${await draft()}/schedule`, {
        fire_at: Date.now() + HOUR,
        slug: "taken",
      });
    },
  },
  {
    refusal: "POST /api/posts/:id/schedule slug_permanent",
    when: "moving the address of a post whose scheduled email links it",
    run: async () =>
      call("POST", `/api/posts/${await linked()}/schedule`, {
        fire_at: Date.now() + 2 * HOUR,
        slug: "moved",
      }),
  },
  {
    refusal: "POST /api/posts/:id/send active_send_exists",
    when: "a repeat asking for settings the post doesn't have",
    run: async () => {
      const id = await draft();
      expect((await call("POST", `/api/posts/${id}/send`, {})).status).toBe(201);
      return call("POST", `/api/posts/${id}/send`, { email_only: true });
    },
  },
  {
    refusal: "POST /api/posts/:id/send post_not_draft",
    when: "sending a sent post",
    run: async () => call("POST", `/api/posts/${await sent()}/send`, {}),
  },
  {
    refusal: "POST /api/posts/:id/send subject_required",
    when: "an empty subject",
    run: async () => call("POST", `/api/posts/${await draft({ subject: "" })}/send`, {}),
  },
  {
    refusal: "POST /api/posts/:id/send provider_not_connected",
    when: "no provider",
    run: async () => notConnected("POST", `/api/posts/${await draft()}/send`, {}),
  },
  {
    refusal: "POST /api/posts/:id/send slug_invalid",
    when: "a malformed slug in the same act",
    run: async () => call("POST", `/api/posts/${await draft()}/send`, { slug: "Not A Slug" }),
  },
  {
    refusal: "POST /api/posts/:id/send slug_taken",
    when: "another post's slug in the same act",
    run: async () => {
      await draft({ slug: "taken" });
      return call("POST", `/api/posts/${await draft()}/send`, { slug: "taken" });
    },
  },
  {
    refusal: "POST /api/posts/:id/send slug_permanent",
    when: "moving the address of a post already sent",
    run: async () => call("POST", `/api/posts/${await sent()}/send`, { slug: "moved" }),
  },

  // --- sends ---
  {
    refusal: "GET /api/sends/feed cursor_ahead",
    when: "a cursor ahead of the database",
    run: () => call("GET", `/api/sends/feed?since=999999.${Date.now()}`),
  },
  {
    refusal: "POST /api/sends/:id/cancel window_closed",
    when: "a send whose fire time has passed",
    run: async () => call("POST", `/api/sends/${(await frozenSend(Date.now() - 1000)).id}/cancel`),
  },
  {
    refusal: "POST /api/sends/:id/reschedule fire_at_too_soon",
    when: "a fire time inside the lead",
    run: async () =>
      call("POST", `/api/sends/${(await scheduled()).send.id}/reschedule`, {
        fire_at: Date.now() + 1000,
      }),
  },
  {
    refusal: "POST /api/sends/:id/reschedule window_closed",
    when: "a send whose fire time has passed",
    run: async () =>
      call("POST", `/api/sends/${(await frozenSend(Date.now() - 1000)).id}/reschedule`, {
        fire_at: Date.now() + HOUR,
      }),
  },
  {
    refusal: "POST /api/sends/:id/reschedule send_canceled",
    when: "a canceled send",
    run: async () => {
      const { send } = await scheduled();
      expect((await call("POST", `/api/sends/${send.id}/cancel`)).status).toBe(200);
      return call("POST", `/api/sends/${send.id}/reschedule`, { fire_at: Date.now() + HOUR });
    },
  },
  {
    refusal: "POST /api/sends/:id/resolve run_in_progress",
    when: "a send a run holds",
    run: async () => {
      const send = await frozenSend(Date.now() - 1000);
      await setRow(send.id, { status: "sending", locked_until: Date.now() + 60_000 });
      return call("POST", `/api/sends/${send.id}/resolve`, { resolution: "unsent" });
    },
  },
  {
    refusal: "POST /api/sends/:id/resolve not_wedged",
    when: "a send with nothing to resolve",
    run: async () =>
      call("POST", `/api/sends/${(await scheduled()).send.id}/resolve`, { resolution: "unsent" }),
  },

  // --- subscribers, suppressions ---
  {
    refusal: "POST /api/subscribers signup_required",
    when: "adding an erased address",
    run: async () => {
      await erased("e@x.io");
      return call("POST", "/api/subscribers", { email: "e@x.io" });
    },
  },
  {
    refusal: "POST /api/subscribers provider_not_connected",
    when: "no provider",
    run: () => notConnected("POST", "/api/subscribers", { email: "n@x.io" }),
  },
  {
    refusal: "POST /api/subscribers confirmation_not_sent",
    when: "the provider refusing the confirmation",
    run: () => {
      failFakeSendBatch(1);
      return call("POST", "/api/subscribers", { email: "c@x.io" });
    },
  },
  {
    refusal: "POST /api/subscribers/:id/erase run_in_progress",
    when: "a subscriber a send run is handing off",
    run: async () => call("POST", `/api/subscribers/${await handedOff("h@x.io")}/erase`),
  },
  {
    refusal: "POST /api/suppressions/lift suppression_changed",
    when: "lifting a reason that isn't the one standing",
    run: async () => {
      expect((await call("POST", "/api/suppressions", { email: "b@x.io" })).status).toBe(201);
      return call("POST", "/api/suppressions/lift", { email: "b@x.io", reason: "bounce" });
    },
  },

  // --- imports ---
  ...importCases("POST /api/imports/plan"),
  ...importCases("POST /api/imports"),
  {
    refusal: "POST /api/imports plan_stale",
    when: "a plan that no longer hashes the same",
    run: async () => {
      const file = csv("a@x.io,unsubscribed,unknown,sendy,,,,,,");
      return call("POST", "/api/imports", { file, plan_hash: `${await planHash(file)}x` });
    },
  },
  {
    refusal: "POST /api/imports attestation_required",
    when: "confirming subscribers without the attestation",
    run: async () => {
      const file = csv(confirmedRow);
      return call("POST", "/api/imports", { file, plan_hash: await planHash(file) });
    },
  },
  {
    refusal: "POST /api/imports run_in_progress",
    when: "erasing someone a send run is handing off",
    run: async () => {
      await handedOff("h2@x.io");
      const file = csv("h2@x.io,subscribed,unknown,sendy,erased,,,,,");
      return call("POST", "/api/imports", { file, plan_hash: await planHash(file) });
    },
  },
  {
    refusal: "POST /api/imports sends_acknowledgement_required",
    when: "growing a scheduled send unacknowledged",
    run: async () => {
      await frozenSend(Date.now() + HOUR);
      const file = csv(confirmedRow);
      return call("POST", "/api/imports", {
        file,
        plan_hash: await planHash(file),
        attestation: { version: 1, accepted: true },
      });
    },
  },

  // --- settings ---
  {
    refusal: "PUT /api/settings remake_required",
    when: "a template change with a send scheduled",
    run: async () => {
      await scheduled();
      return call("PUT", "/api/settings", { email_template: tpl("v2") });
    },
  },
  {
    refusal: "PUT /api/settings remake_too_close",
    when: "a template change with a send inside the lead",
    run: async () => {
      // Acknowledged, since re-making it is refused before being too close is.
      return call("PUT", "/api/settings", {
        email_template: tpl("v2"),
        remake: [await insideLead()],
      });
    },
  },
  {
    refusal: "POST /api/settings/logo remake_required",
    when: "a logo the scheduled send would show",
    run: async () => {
      await logoInTemplate();
      await scheduled();
      return upload("/api/settings/logo");
    },
  },
  {
    refusal: "POST /api/settings/logo remake_too_close",
    when: "a logo with a send inside the lead",
    run: async () => {
      await logoInTemplate();
      return upload(`/api/settings/logo?remake=${await insideLead()}`);
    },
  },
  {
    refusal: "DELETE /api/settings/logo remake_required",
    when: "removing a logo the scheduled send shows",
    run: async () => {
      await logoInTemplate();
      expect((await upload("/api/settings/logo")).status).toBe(200);
      await scheduled();
      return call("DELETE", "/api/settings/logo");
    },
  },
  {
    refusal: "DELETE /api/settings/logo remake_too_close",
    when: "removing a logo with a send inside the lead",
    run: async () => {
      await logoInTemplate();
      expect((await upload("/api/settings/logo")).status).toBe(200);
      return call("DELETE", `/api/settings/logo?remake=${await insideLead()}`);
    },
  },
  {
    refusal: "POST /api/settings/template/test provider_not_connected",
    when: "no provider",
    run: () => notConnected("POST", "/api/settings/template/test", { to: "you@x.io" }),
  },
  {
    refusal: "POST /api/settings/notifications/test bad_request",
    when: "no notifications address saved",
    run: async () => {
      await updateSettings(env.DB, { notifications: { to: "" } });
      return call("POST", "/api/settings/notifications/test");
    },
  },
  {
    refusal: "POST /api/settings/notifications/test notify_failed",
    when: "the channel refusing it",
    run: async () => {
      await updateSettings(env.DB, { notifications: { to: "you@x.io" } });
      failFakeNotify(1);
      return call("POST", "/api/settings/notifications/test");
    },
  },
  {
    refusal: "POST /api/settings/notifications/test provider_not_connected",
    when: "notifying through a provider that isn't there",
    run: async () => {
      await updateSettings(env.DB, { notifications: { to: "you@x.io" } });
      return notConnected("POST", "/api/settings/notifications/test");
    },
  },

  // --- reading, the public form, the deployment ---
  {
    refusal: "GET /api/reader-pages/:journey/:state not_found",
    when: "a journey and state that aren't a pair",
    run: () => call("GET", "/api/reader-pages/subscribe/done"),
  },
  {
    refusal: "GET /api/reference/:resource.md not_found",
    when: "a resource no route acts on",
    run: () => call("GET", "/api/reference/owls.md"),
  },
  {
    refusal: "POST /subscribe provider_not_connected",
    when: "no provider",
    run: () =>
      fetchWith(PREVIEW_NOT_CONNECTED, "/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "p@x.io" }),
      }),
  },
  {
    refusal: "GET /health invalid_config",
    when: "a configuration it refuses",
    run: () => fetchWith({ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }, "/health"),
    logs: ["config.invalid"],
  },
];

/** The refusals this spec leaves to the one that already builds what they need, and why. */
const DRIVEN_ELSEWHERE: Record<string, string> = {
  "POST /api/posts/:id/schedule settings_changed":
    "the settings must move under every try of one freeze: one_shape.spec drives it through carryingSettings",
  "POST /api/posts/:id/send settings_changed":
    "the settings must move under every try of one freeze: one_shape.spec drives it through carryingSettings",
  "PUT /api/settings conflict":
    "two writers in one moment: one_shape.spec drives it through carryingSettings",
  "POST /api/settings/logo conflict":
    "two writers in one moment: one_shape.spec drives it through carryingSettings",
  "DELETE /api/settings/logo conflict":
    "two writers in one moment: one_shape.spec drives it through carryingSettings",
  "GET /health schema_behind":
    "a database missing a migration, behind the gate's memo: schema_gate.spec answers it, whole body, with toEqual",
};

beforeEach(async () => {
  await resetDatabase();
  clearFakeOutbox();
  clearFakeNotifications();
  await clearLogos();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("each refusal a route lists carries the fields it documents (docs/API.md, Refusing)", () => {
  it("drives every refusal a route lists, or names the spec that does and why", () => {
    const driven = new Set(CASES.map((c) => c.refusal));
    const unaccounted = [...listed.keys()].filter(
      (k) => !driven.has(k) && !(k in DRIVEN_ELSEWHERE),
    );
    expect(unaccounted).toEqual([]);
    // And nothing here names a refusal no route lists any more.
    for (const k of [...driven, ...Object.keys(DRIVEN_ELSEWHERE)]) {
      expect(listed.has(k), k).toBe(true);
    }
  });

  it("lists `field` only outside Fix the request, where the Errors topic doesn't state it", () => {
    for (const [k, e] of listed) {
      if (REFUSAL_MOVE[e.code as RefusalCode] === FIX_REQUEST) {
        expect(e.details ?? [], k).not.toContain("field");
      }
    }
  });

  it("meets each detail a driven refusal lists in at least one of its ways", () => {
    for (const [k, e] of listed) {
      const ways = CASES.filter((c) => c.refusal === k);
      for (const d of ways.length > 0 ? (e.details ?? []) : []) {
        expect(
          ways.some((c) => !c.omits?.includes(d)),
          `${k} ${d}`,
        ).toBe(true);
      }
    }
  });

  it.each(CASES.map((c) => [`${c.refusal}: ${c.when}`, c] as const))("%s", async (_, c) => {
    if (c.logs) {
      allowErrorLogs(...c.logs);
    }
    const route = listed.get(c.refusal);
    expect(route).toBeDefined();
    const code = route!.code as RefusalCode;
    const res = await c.run();
    const body = await readJson(res);
    expect(body.error).toBe(code);
    expect(res.status).toBe(REFUSAL_STATUS[code]);
    const implied = REFUSAL_MOVE[code] === FIX_REQUEST && !c.noField ? ["field"] : [];
    const expected = [...(route!.details ?? []), ...implied].filter((d) => !c.omits?.includes(d));
    const carried = Object.keys(body).filter((k) => k !== "error" && k !== "message");
    expect(carried.sort()).toEqual(expected.sort());
  });
});

describe("a refusal to fix the request names the one field at fault (the Errors topic)", () => {
  const svg = () => {
    const f = new FormData();
    f.append("file", new File(["<svg/>"], "art.svg", { type: "image/svg+xml" }));
    return f;
  };

  it.each([
    [
      "an image of a type email can't show",
      async () =>
        SELF.fetch(`${base}/api/posts/${await draft()}/images`, {
          method: "POST",
          headers: AUTH,
          body: svg(),
        }),
      "file",
    ],
    [
      "a raw image upload with no name",
      async () =>
        SELF.fetch(`${base}/api/posts/${await draft()}/images`, {
          method: "POST",
          headers: { ...AUTH, "content-type": "image/png" },
          body: PNG_1x1,
        }),
      "filename",
    ],
    [
      "a logo of a type email can't show",
      async () =>
        SELF.fetch(`${base}/api/settings/logo`, { method: "POST", headers: AUTH, body: svg() }),
      "file",
    ],
    [
      "a template with no unsubscribe link",
      async () => call("PUT", "/api/settings", { email_template: "<p>{{ .Post.Body }}</p>" }),
      "email_template",
    ],
    [
      "a subscriber's deliveries cursor this server didn't issue",
      async () => {
        await seedConfirmed("reader@example.com");
        return call("GET", "/api/subscribers/id-reader@example.com/deliveries?after=nope");
      },
      "after",
    ],
  ] as const)("%s", async (_, run, field) => {
    const res = await run();
    expect(res.status).toBe(400);
    expect(await readJson(res)).toMatchObject({ error: "bad_request", field });
  });
});
