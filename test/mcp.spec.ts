import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTool } from "../shared/mcp";
import { createRouter } from "../src/app";
import { type AppEnv, getConfig } from "../src/env";
import { HttpError } from "../src/lib/errors";
import { MCP_INSTRUCTIONS } from "../src/mcp/instructions";
import { handle } from "../src/mcp/server";
import {
  curatedTools,
  markdown,
  operationOf,
  routeField,
  TOOL_DEFS,
  TOOL_PAGE,
  TOOL_TEXT_MAX,
  type ToolDef,
  type ToolRoute,
  undeclaredField,
} from "../src/mcp/tools";
import { buildReferenceResponse } from "../src/reference";
import { openApiDocument } from "../src/reference/openapi";
import { accessDeployment } from "./support/access";
import { frozenSend, resetDatabase, tpl, wedgedSend } from "./support/fixtures";
import { adminAuth, base, JSON_AUTH, readJson } from "./support/http";
import { allowErrorLogs, logged } from "./support/log";
import { fetchWith } from "./support/worker_env";

// The MCP server (SPEC §11): Claude Desktop and claude.ai reach the instance as a connector,
// through a curated set of tools, each calling the API's own routes as the person signed in,
// via Claude.

beforeEach(resetDatabase);
afterEach(() => {
  vi.restoreAllMocks();
});

const PERSON = { email: "you@example.com", client: "editor" };

/** The OpenAPI document this suite's manifest generates, as the server reads it. */
function manifestDocument() {
  const router = createRouter(getConfig(env as AppEnv));
  return openApiDocument(buildReferenceResponse(router.routes.map((r) => r.def)), "", "test");
}

let nextId = 1;

/** One JSON-RPC message to the server, with `headers` for the credential. */
async function rpc(
  method: string,
  params: unknown,
  headers: Record<string, string>,
  send: (init: RequestInit) => Promise<Response> = (init) => SELF.fetch(`${base}/api/mcp`, init),
): Promise<Response> {
  return send({
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
}

async function listTools(): Promise<McpTool[]> {
  const res = await rpc("tools/list", {}, await adminAuth(PERSON));
  expect(res.status).toBe(200);
  return (await readJson(res)).result.tools;
}

/** A tool call's result: whether it was an error, and its text. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<{ isError: boolean; text: string }> {
  const res = await rpc(
    "tools/call",
    { name, arguments: args },
    headers ?? (await adminAuth(PERSON)),
  );
  expect(res.status).toBe(200);
  const { result } = await readJson(res);
  return { isError: result.isError, text: result.content[0].text };
}

/** A tool call that must succeed, its JSON answer read. */
async function callOk(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await callTool(name, args);
  expect(r.isError, r.text).toBe(false);
  return JSON.parse(r.text);
}

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe("the tools are a curated set over the API's routes (SPEC §11)", () => {
  it("lists the publisher's tasks, and the read escape hatch, and nothing else", async () => {
    expect((await listTools()).map((t) => t.name)).toEqual([
      "search_posts",
      "get_post",
      "preview_post",
      "list_sends",
      "get_send",
      "search_subscribers",
      "get_subscriber",
      "get_publication",
      "save_draft",
      "change_post_settings",
      "delete_draft",
      "send_test",
      "schedule_send",
      "reschedule_send",
      "cancel_send",
      "resolve_send",
      "import_subscribers",
      "add_subscriber",
      "unsubscribe_subscriber",
      "block_address",
      "lift_suppression",
      "update_settings",
      "update_template",
      "test_notifications",
      "kestrel_api_read",
    ]);
  });

  it("gives every tool a title and says whether it only reads or what its change risks", async () => {
    const tools = await listTools();
    for (const t of tools) {
      expect(t.title, t.name).toMatch(/\S/);
      expect(t.annotations.title).toBe(t.title);
      expect(typeof t.annotations.readOnlyHint).toBe("boolean");
      expect(typeof t.annotations.openWorldHint).toBe("boolean");
      if (!t.annotations.readOnlyHint) {
        expect(typeof t.annotations.destructiveHint, t.name).toBe("boolean");
      }
    }
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get("send_test")).toMatchObject({ destructiveHint: false, openWorldHint: true });
    expect(byName.get("schedule_send")).toMatchObject({
      destructiveHint: true,
      openWorldHint: true,
    });
    expect(byName.get("save_draft")).toMatchObject({ destructiveHint: false });
    expect(byName.get("change_post_settings")).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(byName.get("delete_draft")).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(byName.get("add_subscriber")).toMatchObject({
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(byName.get("resolve_send")).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(byName.get("block_address")).toMatchObject({
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(byName.get("lift_suppression")).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(byName.get("update_settings")).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(byName.get("update_template")).toMatchObject({
      destructiveHint: true,
      openWorldHint: false,
    });
    expect(byName.get("test_notifications")).toMatchObject({
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it("wraps only routes the manifest registers on the authoring API, a read only GETs", () => {
    const doc = manifestDocument();
    for (const def of TOOL_DEFS) {
      expect(def.routes.length, def.name).toBeGreaterThan(0);
      for (const r of def.routes) {
        const op = operationOf(doc, r);
        expect(op, `${def.name}: ${r.method} ${r.path}`).not.toBeNull();
        expect(op?.["x-kestrel-access"]).toBe("admin");
        if (def.annotations.readOnlyHint) {
          expect(r.method, def.name).toBe("GET");
        }
      }
    }
  });

  it("sends every field only to routes that take it, each named on the pick or the tool", () => {
    const doc = manifestDocument();
    for (const def of TOOL_DEFS) {
      const fields = [
        ...Object.entries(def.args).flatMap(([name, p]) =>
          p.routes.map((route) => ({ name, route, f: p })),
        ),
        ...(def.fixed ?? []).map((f) => ({ name: f.field, route: f.route, f })),
      ];
      for (const { name, route, f } of fields) {
        const where = `${def.name}.${name} to ${route.method} ${route.path}`;
        expect(def.routes, where).toContainEqual(route);
        expect(routeField(doc, route, f), where).not.toBeNull();
      }
    }
  });

  it("refuses to build a tool when a route, or a field it sends any route, left the manifest", () => {
    const gone = manifestDocument();
    delete gone.paths["/api/sends/{id}/cancel"];
    expect(() => curatedTools(gone)).toThrow(
      "cancel_send calls POST /api/sends/:id/cancel, which the manifest doesn't register",
    );
    // A field sent to a second route counts as much as the one it was picked from.
    const field = manifestDocument();
    const put = operationOf(field, { method: "PUT", path: "/api/posts/:id" });
    delete put?.requestBody?.content["application/json"]?.schema.properties?.markdown;
    expect(() => curatedTools(field)).toThrow(
      "save_draft sends the body field markdown to PUT /api/posts/:id, which doesn't take it",
    );
    const fixed = manifestDocument();
    const list = operationOf(fixed, { method: "GET", path: "/api/subscribers" });
    if (list?.parameters) {
      list.parameters = list.parameters.filter((x) => x.name !== "limit");
    }
    // The first tool to send it is refused; get_publication sets it itself, and is held the same way.
    expect(() => curatedTools(fixed)).toThrow(
      /sends the query field limit to GET \/api\/subscribers/,
    );
  });

  it("stops a call that sends a route a field its tool doesn't declare for it", () => {
    const def = TOOL_DEFS.find((d) => d.name === "schedule_send") as ToolDef;
    const send = { method: "POST", path: "/api/posts/:id/send" } as const;
    expect(
      undeclaredField(def, send, { params: { id: "p" }, body: { email_only: true } }),
    ).toBeNull();
    expect(undeclaredField(def, send, { params: { id: "p" }, body: { fire_at: "x" } })).toBe(
      "body fire_at",
    );
  });

  it("reads each argument's schema and words from its route", async () => {
    const tools = await listTools();
    const schedule = tools.find((t) => t.name === "schedule_send");
    const props = schedule?.inputSchema.properties as Record<string, { description: string }>;
    expect(Object.keys(props)).toEqual(["id", "fire_at", "email_only"]);
    expect(schedule?.inputSchema.required).toEqual(["id"]);
    expect(schedule?.inputSchema.additionalProperties).toBe(false);
    const op = operationOf(manifestDocument(), {
      method: "POST",
      path: "/api/posts/:id/schedule",
    });
    const fireAt = op?.requestBody?.content["application/json"]?.schema.properties?.fire_at;
    expect(props.fire_at?.description).toBe(`${fireAt?.description} Omit it for the soonest.`);
    // Each schema stands alone: an object it names is under its own `$defs`.
    for (const t of tools) {
      const text = JSON.stringify(t.inputSchema);
      expect(text).not.toContain("#/components/");
      const defs = (t.inputSchema.$defs ?? {}) as Record<string, unknown>;
      for (const [, key] of text.matchAll(/"#\/\$defs\/(\w+)"/g)) {
        expect(Object.keys(defs)).toContain(key);
      }
    }
  });

  it("names, in what it tells Claude on connecting, only tools that exist", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18" }, await adminAuth(PERSON));
    const { result } = await readJson(res);
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });
    expect(result.instructions).toBe(MCP_INSTRUCTIONS);
    const names = (await listTools()).map((t) => t.name);
    for (const [named] of MCP_INSTRUCTIONS.matchAll(/\b[a-z]+_[a-z_]+\b/g)) {
      expect(names).toContain(named);
    }
  });
});

describe("a tool call runs its routes as the person, via Claude (SPEC §11, Who acted)", () => {
  it("records a draft saved through a tool as the signed-in person via Claude, whatever client the caller named", async () => {
    const { vars, assertion } = await accessDeployment();
    const headers = {
      ...(await assertion({ email: "you@example.com" })),
      "Kestrel-Client": "editor",
    };
    const send = (init: RequestInit) => fetchWith(vars, "/api/mcp", init);
    const res = await rpc(
      "tools/call",
      { name: "save_draft", arguments: { subject: "Via a tool" } },
      headers,
      send,
    );
    const { result } = await readJson(res);
    expect(result.isError).toBe(false);
    const saved = JSON.parse(result.content[0].text);
    expect(saved.post).toMatchObject({
      subject: "Via a tool",
      author: "you@example.com",
      author_client: "claude",
    });
  });

  it("saves a draft against the revision it read, and hands back the newer text when another save landed", async () => {
    const created = await callOk("save_draft", { subject: "One", markdown: "first" });
    const id = created.post.id;
    const saved = await callOk("save_draft", {
      id,
      markdown: "second",
      base_revision: created.revision_id,
    });
    expect((await callOk("get_post", { id })).markdown).toBe("second");
    const stale = await callTool("save_draft", {
      id,
      markdown: "third",
      base_revision: created.revision_id,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/^Refused: HTTP 409 stale_revision\. /);
    expect(stale.text).toContain("Next move: Read again, then decide.");
    expect(stale.text).toContain(
      `a newer revision, ${saved.revision_id}, by you@example.com via claude`,
    );
    expect(stale.text.endsWith("\n\nsecond")).toBe(true);
  });

  it("reads a page at a time, and the next page from its offset", async () => {
    for (let i = 0; i < TOOL_PAGE + 1; i++) {
      await SELF.fetch(`${base}/api/posts`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ subject: `Post ${i}` }),
      });
    }
    const first = await callOk("search_posts", {});
    expect(first.posts.length).toBe(TOOL_PAGE);
    expect(first).toMatchObject({ total: TOOL_PAGE + 1, next_offset: TOOL_PAGE });
    expect(Object.keys(first.posts[0])).toEqual([
      "id",
      "subject",
      "status",
      "email_only",
      "updated_at",
      "send",
    ]);
    const last = await callOk("search_posts", { offset: first.next_offset });
    expect(last.posts.length).toBe(1);
    expect(last.next_offset).toBeNull();
    expect((await callOk("search_posts", { search: "Post 13", status: "draft" })).total).toBe(1);
  });

  it("previews the email's text through the render path, and links the designed email", async () => {
    const created = await callOk("save_draft", {
      subject: "Hello",
      markdown: "Waxwings **arrived**.",
    });
    const preview = await callOk("preview_post", { id: created.post.id });
    expect(preview).toMatchObject({ subject: "Hello", frozen: false, warnings: [] });
    expect(preview.text).toContain("Waxwings arrived.");
    // Filled as the preview page fills it: a test's unsubscribe page, never a raw placeholder.
    expect(preview.text).toMatch(/Unsubscribe: \S+\/unsubscribe\?test=1/);
    expect(preview.text).not.toContain("%%");
    expect(preview.editor).toMatch(new RegExp(`/dashboard/\\?to=/edit/${created.post.id}$`));
  });

  it("schedules, tests, moves, and cancels a send, and Send now is scheduling for the soonest", async () => {
    const post = (await callOk("save_draft", { subject: "Soon", markdown: "x" })).post;
    const tooSoon = await callTool("schedule_send", {
      id: post.id,
      fire_at: new Date(Date.now() + 1000).toISOString(),
    });
    expect(tooSoon.isError).toBe(true);
    expect(tooSoon.text).toMatch(/^Refused: HTTP 400 fire_at_too_soon\. /);
    expect(tooSoon.text).toContain("Next move: Fix the request.");
    const scheduled = await callOk("schedule_send", { id: post.id, fire_at: inHours(2) });
    expect(scheduled.send).toMatchObject({ post_id: post.id, status: "scheduled" });
    const test = await callOk("send_test", { id: post.id, to: "you@example.com" });
    expect(test).toMatchObject({ sent: true, to: "you@example.com", frozen: true });
    const moved = await callOk("reschedule_send", { id: scheduled.send.id, fire_at: inHours(3) });
    expect(moved.changed).toBe(true);
    const send = await callOk("get_send", { id: scheduled.send.id });
    expect(send.send.rescheduled_by).toEqual({
      kind: "human",
      email: "you@example.com",
      client: "claude",
    });
    expect((await callOk("cancel_send", { id: scheduled.send.id })).send.status).toBe("canceled");
    const now = await callOk("schedule_send", { id: post.id });
    expect(now.send.status).toBe("scheduled");
    const listed = await callOk("list_sends", { status: "scheduled" });
    expect(listed.sends.map((s: { id: string }) => s.id)).toEqual([now.send.id]);
  });

  it("changes a post's listing and address, in any state, and says when an address is taken", async () => {
    const other = (await callOk("save_draft", { subject: "Taken" })).post;
    const post = (await callOk("save_draft", { subject: "Mine", markdown: "x" })).post;
    const listed = await callOk("change_post_settings", {
      id: post.id,
      email_only: true,
      slug: "my-own",
    });
    expect(listed).toMatchObject({ changed: true, post: { email_only: true, slug: "my-own" } });
    const taken = await callTool("change_post_settings", { id: post.id, slug: other.slug });
    expect(taken.isError).toBe(true);
    expect(taken.text).toMatch(/^Refused: HTTP 409 slug_taken\. /);
    expect(taken.text).toContain("Next move: Read again, then decide.");
    await callOk("schedule_send", { id: post.id, fire_at: inHours(2) });
    const scheduled = await callOk("change_post_settings", { id: post.id, email_only: false });
    expect(scheduled.post).toMatchObject({ status: "scheduled", email_only: false });
  });

  it("deletes a draft, and never a scheduled post", async () => {
    const draft = (await callOk("save_draft", { subject: "Gone" })).post;
    expect(await callOk("delete_draft", { id: draft.id })).toEqual({ deleted: true, id: draft.id });
    expect((await callTool("get_post", { id: draft.id })).text).toMatch(
      /^Refused: HTTP 404 not_found\./,
    );
    const kept = (await callOk("save_draft", { subject: "Kept", markdown: "x" })).post;
    await callOk("schedule_send", { id: kept.id, fire_at: inHours(2) });
    const refused = await callTool("delete_draft", { id: kept.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Refused: HTTP 409 post_not_draft\. /);
    expect((await callOk("get_post", { id: kept.id })).post.status).toBe("scheduled");
  });

  it("adds a subscriber by double opt-in, pending until they confirm (SPEC §7)", async () => {
    const added = await callOk("add_subscriber", { email: "new@x.io" });
    expect(added).toMatchObject({
      action: "created",
      subscriber: { email: "new@x.io", status: "pending", receives_posts: false },
    });
    expect((await callOk("add_subscriber", { email: "new@x.io" })).action).toBe("recently_sent");
  });

  it("blocks an address, and lifts only the suppression the publisher named, saying what stands when it changed", async () => {
    const blocked = await callOk("block_address", { email: "b@x.io", detail: "Our own test" });
    expect(blocked).toMatchObject({
      added: true,
      suppression: { email: "b@x.io", reason: "manual", detail: "Our own test" },
    });
    const wrong = await callTool("lift_suppression", { email: "b@x.io", reason: "bounce" });
    expect(wrong.isError).toBe(true);
    const lines = wrong.text.split("\n");
    expect(lines[0]).toMatch(/^Refused: HTTP 409 suppression_changed\. /);
    expect(lines[1]).toBe("Next move: Read again, then decide.");
    expect(lines[2]).toBe(
      `It stands now as \`manual\` ("Our own test"), since ${blocked.suppression.created_at}.`,
    );
    expect(lines[3]).toBe(
      "Tell the publisher what stands now, and lift it only if they ask again, naming that reason.",
    );
    expect(await callOk("lift_suppression", { email: "b@x.io", reason: "manual" })).toEqual({
      email: "b@x.io",
      lifted: true,
    });
  });

  it("resolves a stuck send only with the resolution the call names, never a default (SPEC §12)", async () => {
    const id = await wedgedSend();
    const tool = (await listTools()).find((t) => t.name === "resolve_send")!;
    expect(tool.inputSchema.required).toEqual(["id", "resolution"]);
    const resolution = (tool.inputSchema.properties as Record<string, Record<string, unknown>>)
      .resolution;
    expect(resolution).not.toHaveProperty("default");
    expect(resolution?.description).toContain("never choose it yourself");
    const none = await callTool("resolve_send", { id });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/^Refused: HTTP 400 bad_request\..*\nFix: `resolution`\.$/s);
    expect((await callOk("get_send", { id })).send.resolved_by).toBeNull();
    const done = await callOk("resolve_send", { id, resolution: "unsent" });
    expect(done).toMatchObject({ resolved: 1, completed: true });
    expect((await callOk("get_send", { id })).send.resolved_by).toEqual({
      kind: "human",
      email: "you@example.com",
      client: "claude",
    });
  });

  it("lists the sends a settings save would re-make, and re-makes none until a second call names them (SPEC §9)", async () => {
    const post = (await callOk("save_draft", { subject: "Waxwings", markdown: "x" })).post;
    const send = (await callOk("schedule_send", { id: post.id, fire_at: inHours(2) })).send;
    const refused = await callTool("update_settings", { publication: { name: "Renamed" } });
    expect(refused.isError).toBe(true);
    const lines = refused.text.split("\n");
    expect(lines[0]).toMatch(/^Refused: HTTP 409 remake_required\. /);
    expect(lines[1]).toBe("Next move: Confirm, then send again.");
    expect(lines[2]).toBe("Saving re-makes the email of these scheduled sends:");
    expect(lines[3]).toBe(`- "Waxwings", firing ${send.fire_at} (${send.id}).`);
    expect(lines[4]).toContain(
      `Only if they say yes in this chat, call again with the same change and remake ["${send.id}"].`,
    );
    expect((await callOk("get_publication", {})).publication.name).not.toBe("Renamed");
    const saved = await callOk("update_settings", {
      publication: { name: "Renamed" },
      remake: [send.id],
    });
    expect(saved.publication.name).toBe("Renamed");
    expect(saved.remade.map((s: { id: string }) => s.id)).toEqual([send.id]);
  });

  it("saves nothing while a send it would re-make is inside the minimum lead, and says when to try again", async () => {
    const send = await frozenSend(Date.now() + 30_000, { subject: "Correction" });
    const fireAt = new Date(send.fire_at).toISOString();
    const refused = await callTool("update_settings", {
      publication: { name: "Renamed" },
      remake: [send.id],
    });
    expect(refused.isError).toBe(true);
    const lines = refused.text.split("\n");
    expect(lines[0]).toMatch(/^Refused: HTTP 409 remake_too_close\. /);
    expect(lines.slice(2)).toEqual([
      "Nothing was saved. These fire inside the minimum lead, so they go out as they stand:",
      `- "Correction", firing ${fireAt} (${send.id}).`,
      `Tell the publisher, and offer to save again after ${fireAt}.`,
    ]);
    expect((await callOk("get_publication", {})).publication.name).not.toBe("Renamed");
  });

  it("answers where mail goes as saved, first, after any settings save, and tests the notifications there", async () => {
    const before = await callTool("test_notifications", {});
    expect(before.isError).toBe(true);
    expect(before.text).toMatch(/^Refused: HTTP 400 bad_request\./);
    const saved = await callOk("update_settings", {
      test_recipients: ["Me@Example.com", "you@example.com"],
      notifications: { to: "me@example.com" },
    });
    expect(Object.keys(saved).slice(0, 2)).toEqual(["test_recipients", "notifications_to"]);
    expect(saved).toMatchObject({
      test_recipients: ["me@example.com", "you@example.com"],
      notifications_to: "me@example.com",
      remade: [],
    });
    const wording = await callOk("update_settings", {
      confirmation_email: { subject: "Confirm, please" },
    });
    expect(wording).toMatchObject({
      test_recipients: ["me@example.com", "you@example.com"],
      notifications_to: "me@example.com",
      confirmation_email: { subject: "Confirm, please" },
    });
    expect(await callOk("test_notifications", {})).toEqual({
      to: "me@example.com",
      channel: "fake",
    });
    const tool = (await listTools()).find((t) => t.name === "update_settings");
    expect(tool?.description).toContain(
      "before saving name each new or changed address back to them and save only once they say yes in this chat",
    );
    expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain("email_template");
    const template = await callTool("update_settings", { email_template: "<p>x</p>" });
    expect(template.text).toBe(
      "`email_template` isn't an argument update_settings takes; it takes `publication`, `test_recipients`, `notifications`, `confirmation_email`, `remake`.",
    );
  });

  it("tells Claude to send `remake` only with the ids a refusal listed for the publisher, never ids read beforehand (SPEC §11)", async () => {
    const tools = await listTools();
    for (const name of ["update_settings", "update_template"]) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.description, name).toContain("Save without `remake`");
      expect(t.description, name).not.toContain("in_use");
      const remake = (t.inputSchema.properties as Record<string, { description: string }>).remake;
      expect(remake?.description, name).toMatch(
        /Leave it out of a first save\. Send it only on a call after a remake_required refusal, with the ids that refusal listed, once you have shown the publisher those sends and they said yes in this chat; never ids read beforehand\.$/,
      );
    }
    expect(MCP_INSTRUCTIONS).toContain(
      "send `remake` with the refusal's ids only after they say yes, never ids read beforehand",
    );
  });

  it("saves the template only through its own tool, re-making a scheduled send only on a second call that names it (SPEC §9, I5)", async () => {
    expect(await callOk("update_template", { email_template: tpl("v1") })).toMatchObject({
      saved: true,
      remade: [],
    });
    const post = (await callOk("save_draft", { subject: "Waxwings", markdown: "x" })).post;
    const send = (await callOk("schedule_send", { id: post.id, fire_at: inHours(2) })).send;
    const refused = await callTool("update_template", { email_template: tpl("v2") });
    expect(refused.isError).toBe(true);
    const lines = refused.text.split("\n");
    expect(lines[0]).toMatch(/^Refused: HTTP 409 remake_required\. /);
    expect(lines[3]).toBe(`- "Waxwings", firing ${send.fire_at} (${send.id}).`);
    const template = async () =>
      JSON.parse((await callTool("kestrel_api_read", { path: "/api/settings" })).text).settings
        .email_template;
    expect(await template()).toBe(tpl("v1"));
    const saved = await callOk("update_template", { email_template: tpl("v2"), remake: [send.id] });
    expect(saved.remade.map((s: { id: string }) => s.id)).toEqual([send.id]);
    expect(await template()).toBe(tpl("v2"));
    const broken = await callTool("update_template", { email_template: "<div>no body</div>" });
    expect(broken.isError).toBe(true);
    expect(broken.text).toMatch(/\nFix: `email_template`\.$/);
    const identity = await callTool("update_template", { publication: { name: "N" } });
    expect(identity.text).toBe(
      "`publication` isn't an argument update_template takes; it takes `email_template`, `remake`.",
    );
  });

  it("plans an import before committing, and never gives the attestation for the person", async () => {
    const file = { name: "l.txt", text: "a@x.io\n" };
    const plan = await callOk("import_subscribers", { file });
    expect(plan).toMatchObject({ planned: true, attestation: { version: 1 } });
    expect((await callOk("search_subscribers", {})).total).toBe(0);
    const refused = await callTool("import_subscribers", { file, plan_hash: plan.plan_hash });
    expect(refused.isError).toBe(true);
    const lines = refused.text.split("\n");
    expect(lines[0]).toMatch(/^Refused: HTTP 409 attestation_required\. /);
    expect(lines[1]).toBe("Next move: Confirm, then send again.");
    expect(lines[2]).toBe(`The words for the publisher to confirm: "${plan.attestation.text}"`);
    expect(lines[3]).toContain(
      "Only if they do, call again with attestation { version: 1, accepted: true }.",
    );
    expect((await callOk("search_subscribers", {})).total).toBe(0);
    const done = await callOk("import_subscribers", {
      file,
      plan_hash: plan.plan_hash,
      attestation: { version: 1, accepted: true },
    });
    expect(done.import.principal).toEqual({
      kind: "human",
      email: "you@example.com",
      client: "claude",
    });
  });

  it("sends the publisher to the dashboard for an import that would grow a scheduled send (SPEC §7)", async () => {
    const post = (await callOk("save_draft", { subject: "Soon", markdown: "x" })).post;
    await callOk("schedule_send", { id: post.id, fire_at: inHours(2) });
    const file = { name: "l.txt", text: "a@x.io\n" };
    const plan = await callOk("import_subscribers", { file });
    expect(plan.sends_growing.length).toBe(1);
    const refused = await callTool("import_subscribers", {
      file,
      plan_hash: plan.plan_hash,
      attestation: { version: 1, accepted: true },
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/^Refused: HTTP 409 sends_acknowledgement_required\. /);
    expect(refused.text).toContain('- "Soon", firing');
    expect(refused.text).toMatch(
      /Only the publisher can acknowledge that, in the dashboard, choosing the same file: \S+\/dashboard\/\?to=\/subscribers\/import$/,
    );
  });

  it("finds a subscriber by address, and unsubscribes them", async () => {
    const file = { name: "l.txt", text: "a@x.io\n" };
    const plan = await callOk("import_subscribers", { file });
    await callOk("import_subscribers", {
      file,
      plan_hash: plan.plan_hash,
      attestation: { version: 1, accepted: true },
    });
    const found = await callOk("get_subscriber", { email: "a@x.io" });
    expect(found.subscriber).toMatchObject({
      email: "a@x.io",
      status: "confirmed",
      receives_posts: true,
    });
    const left = await callOk("unsubscribe_subscriber", { id: found.subscriber.id });
    expect(left.subscriber).toMatchObject({
      status: "unsubscribed",
      unsubscribe_cause: "publisher",
    });
    expect((await callTool("get_subscriber", {})).text).toBe("Give one of `id` or `email`.");
  });

  it("reads the publication: who is signed in, and its identity, provider, and list", async () => {
    const pub = await callOk("get_publication", {});
    expect(pub.signed_in_as).toEqual({ kind: "human", email: "you@example.com", client: "claude" });
    expect(pub.subscribers).toEqual({ pending: 0, confirmed: 0, unsubscribed: 0, suppressed: 0 });
    expect(Object.keys(pub.deployment)).toEqual([
      "app_origin",
      "provider",
      "from_address",
      "min_lead_minutes",
      "free_plan_limits",
    ]);
    expect(pub.scheduled_sends).toEqual([]);
  });

  it("reads any other admin GET through the escape hatch, and never a write or a dev route", async () => {
    const ref = await callTool("kestrel_api_read", { path: "/api/reference.md" });
    expect(ref.isError).toBe(false);
    expect(ref.text).toMatch(/^# /);
    const post = (await callOk("save_draft", { subject: "R" })).post;
    const revs = await callTool("kestrel_api_read", { path: `/api/posts/${post.id}/revisions` });
    expect(JSON.parse(revs.text).revisions.length).toBe(1);
    for (const path of [
      "/api/dev/outbox",
      "/api/mcp",
      "/health",
      "https://evil.example/api/posts",
      "/api/nope",
    ]) {
      const r = await callTool("kestrel_api_read", { path });
      expect(r.isError, path).toBe(true);
      expect(r.text).toContain("isn't a route this reads");
    }
    // What is checked is what is asked: a climb out of a path is resolved before either.
    for (const path of [
      "/api/posts/../dev/outbox",
      "/api/posts/%2e%2e/dev/outbox",
      "/api/posts/%2E%2E/%2e%2e/api/dev/outbox",
      "/api/subscribers/export",
      `/api/sends/s_x/deliveries.csv`,
      "/api/imports/template.csv",
    ]) {
      const r = await callTool("kestrel_api_read", { path });
      expect(r.isError, path).toBe(true);
      expect(r.text, path).toContain("isn't a route this reads");
    }
    const parens = await callTool("kestrel_api_read", { path: "/api/posts/(.*)" });
    expect(parens.text).toMatch(/^Refused: HTTP 404 not_found\./);
    const page = await callTool("kestrel_api_read", { path: `/api/posts/${post.id}/preview` });
    expect(page.text).toBe(
      `/api/posts/${post.id}/preview answers text/html, which a chat can't read: open it in the dashboard instead.`,
    );
    const huge = await callTool("kestrel_api_read", { path: "/api/reference" });
    expect(huge.isError).toBe(true);
    expect(huge.text).toMatch(
      /^The answer is [\d,]+ characters, over the 60,000 a tool answers\. Ask for less/,
    );
    const bad = await callTool("kestrel_api_read", { path: "/api/posts?colour=red" });
    expect(bad.text).toContain(
      "Refused: HTTP 400 bad_request. colour isn’t a query parameter this takes",
    );
  });

  it("refuses an argument the tool doesn't take, naming it, and a missing post as the route does", async () => {
    const stray = await callTool("get_post", { id: "p_x", title: "T" });
    expect(stray).toEqual({
      isError: true,
      text: "`title` isn't an argument get_post takes; it takes `id`.",
    });
    const missing = await callTool("get_post", { id: "p_none" });
    expect(missing.text).toMatch(/^Refused: HTTP 404 not_found\./);
  });
});

describe("what a tool answers stays small and whole", () => {
  it("keeps the whole tool list under 25 KB, so growing it is a decision", async () => {
    const res = await rpc("tools/list", {}, await adminAuth(PERSON));
    const size = new TextEncoder().encode(await res.text()).length;
    expect(size).toBeLessThan(25 * 1024);
  });

  it("cuts a long Markdown answer at a line, or at the limit when no line ends before it", () => {
    const lines = `${"a".repeat(100)}\n`.repeat(1000);
    const atLine = markdown(lines).content[0]?.text ?? "";
    expect(
      atLine.startsWith(`${lines.slice(0, lines.lastIndexOf("\n", TOOL_TEXT_MAX))}\n\n[Cut here`),
    ).toBe(true);
    const oneParagraph = "b".repeat(TOOL_TEXT_MAX + 5000);
    const hard = markdown(oneParagraph).content[0]?.text ?? "";
    expect(
      hard.startsWith(`${"b".repeat(TOOL_TEXT_MAX)}\n\n[Cut here, at 60,000 of 65,000 characters`),
    ).toBe(true);
    expect(markdown("short").content[0]?.text).toBe("short");
  });

  it("marks every export and every CSV or text route as bulk, and never reads one", async () => {
    const routes = buildReferenceResponse(
      createRouter(getConfig(env as AppEnv)).routes.map((r) => r.def),
    ).groups.flatMap((g) => g.routes);
    const bulkShaped = routes.filter(
      (r) => r.access === "admin" && r.method === "GET" && /export|\.(csv|txt)$/.test(r.path),
    );
    expect(bulkShaped.map((r) => r.path)).toEqual(
      expect.arrayContaining(["/api/subscribers/export", "/api/sends/:id/deliveries.csv"]),
    );
    for (const r of bulkShaped) {
      expect(r.bulk, r.path).toBe(true);
    }
    const doc = manifestDocument();
    expect(
      operationOf(doc, { method: "GET", path: "/api/subscribers/export" })?.["x-kestrel-bulk"],
    ).toBe(true);
    for (const r of bulkShaped) {
      const path = r.path.replace(":id", "s_x");
      const read = await callTool("kestrel_api_read", { path });
      expect(read.text, path).toContain("isn't a route this reads");
    }
  });
});

describe("the publisher's docs are resources", () => {
  it("lists the publishing pages, and reads one as Markdown", async () => {
    const auth = await adminAuth(PERSON);
    const list = (await readJson(await rpc("resources/list", {}, auth))).result.resources;
    const page = list.find((r: { name: string }) => r.name === "connect-claude");
    expect(page).toEqual({
      uri: "kestrel://docs/connect-claude",
      name: "connect-claude",
      title: "Connect Claude",
      mimeType: "text/markdown",
    });
    expect(list.some((r: { name: string }) => r.name === "access")).toBe(false);
    const read = (await readJson(await rpc("resources/read", { uri: page.uri }, auth))).result;
    expect(read.contents[0].text).toMatch(/^# Connect Claude/);
    const none = await readJson(await rpc("resources/read", { uri: "kestrel://docs/nope" }, auth));
    expect(none.error.code).toBe(-32002);
  });
});

describe("the server's door (SPEC §11)", () => {
  it("refuses a request with no credential before any tool runs", async () => {
    const res = await rpc("tools/call", { name: "save_draft", arguments: { subject: "S" } }, {});
    expect(res.status).toBe(401);
    const { vars } = await accessDeployment();
    const access = await rpc("tools/list", {}, {}, (init) => fetchWith(vars, "/api/mcp", init));
    expect(access.status).toBe(401);
    expect((await callOk("search_posts", {})).posts).toEqual([]);
  });

  it("refuses a request another site's page sent, and takes Claude's servers naming their origin", async () => {
    const auth = await adminAuth(PERSON);
    const evil = await rpc("tools/list", {}, { ...auth, Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    for (const origin of ["https://claude.ai/", "https://claude.ai", "https://claude.com"]) {
      expect((await rpc("tools/list", {}, { ...auth, Origin: origin })).status, origin).toBe(200);
    }
    // A browser on claude.ai says so in Sec-Fetch-Site, and is a page elsewhere like any other.
    const page = await rpc(
      "tools/list",
      {},
      {
        ...auth,
        Origin: "https://claude.ai",
        "Sec-Fetch-Site": "cross-site",
      },
    );
    expect(page.status).toBe(403);
    // Only this route takes Claude's origin: every other write keeps the browser guard.
    const post = await SELF.fetch(`${base}/api/posts`, {
      method: "POST",
      headers: { ...JSON_AUTH, Origin: "https://claude.ai" },
      body: "{}",
    });
    expect(post.status).toBe(403);
  });

  it("answers malformed JSON, a batch, or a body that isn't a message as JSON-RPC errors", async () => {
    const send = (body: string) =>
      SELF.fetch(`${base}/api/mcp`, {
        method: "POST",
        headers: { ...JSON_AUTH },
        body,
      });
    const parse = await send("{not json");
    expect(parse.status).toBe(400);
    expect(await readJson(parse)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "the body is not valid JSON" },
    });
    const batch = await send(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    expect(batch.status).toBe(400);
    expect((await readJson(batch)).error.code).toBe(-32600);
    const bare = await send("42");
    expect((await readJson(bare)).error.code).toBe(-32600);
  });

  it("answers a server-side refusal inside the server as JSON-RPC's internal error, and keeps a request's own", async () => {
    allowErrorLogs("request.error");
    const failing = (err: Error): ToolRoute[] => [
      Object.defineProperty({ def: TOOL_DEFS[0] as ToolDef }, "tool", {
        get() {
          throw err;
        },
      }) as ToolRoute,
    ];
    const context = async () => {
      const req = new Request(`${base}/api/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      });
      const e = env as AppEnv;
      return {
        req,
        env: e,
        ctx: createExecutionContext(),
        url: new URL(req.url),
        params: {},
        config: getConfig(e),
      };
    };
    const router = createRouter(getConfig(env as AppEnv));
    for (const err of [new HttpError("settings_corrupt"), new Error("boom")]) {
      const res = await handle(await context(), router, failing(err));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32603, message: "Kestrel couldn't answer that: the server log says why." },
      });
    }
    await expect(
      handle(await context(), router, failing(new HttpError("bad_request"))),
    ).rejects.toThrow(HttpError);
  });

  it("turns an error inside a tool into the tool's error, never a 500", async () => {
    allowErrorLogs("request.error");
    const def = TOOL_DEFS.find((d) => d.name === "get_post") as ToolDef;
    vi.spyOn(def, "run").mockRejectedValue(new Error("boom"));
    const r = await callTool("get_post", { id: "p_x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^The tool stopped on an error inside Kestrel/);
  });

  it("takes a notification with no answer, and opens no stream", async () => {
    const res = await SELF.fetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { ...(await adminAuth(PERSON)), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
    const get = await SELF.fetch(`${base}/api/mcp`, { headers: await adminAuth(PERSON) });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("answers a protocol version it doesn't speak with a 400, so a newer client falls back to initialize", async () => {
    const headers = { ...(await adminAuth(PERSON)), "MCP-Protocol-Version": "2026-07-28" };
    const res = await rpc("tools/list", {}, headers);
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe(-32600);
    const init = await rpc("initialize", { protocolVersion: "2026-07-28" }, headers);
    expect((await readJson(init)).result.protocolVersion).toBe("2025-11-25");
    // 2025-03-26 takes batches, which this server doesn't, so it isn't one it speaks.
    const old = await rpc("initialize", { protocolVersion: "2025-03-26" }, await adminAuth(PERSON));
    expect((await readJson(old)).result.protocolVersion).toBe("2025-11-25");
    const oldHeader = { ...(await adminAuth(PERSON)), "MCP-Protocol-Version": "2025-03-26" };
    expect((await rpc("tools/list", {}, oldHeader)).status).toBe(400);
  });

  it("answers an unknown method or tool as JSON-RPC errors", async () => {
    const auth = await adminAuth(PERSON);
    expect((await readJson(await rpc("prompts/list", {}, auth))).error.code).toBe(-32601);
    expect((await readJson(await rpc("tools/call", { name: "nope" }, auth))).error.code).toBe(
      -32602,
    );
    expect((await readJson(await rpc("ping", {}, auth))).result).toEqual({});
  });
});

describe("each tool call is one line, a failed one with its refusal code (SPEC §12)", () => {
  it("logs a call its arguments refuse before it runs, as failed with no code", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    expect((await callTool("get_send", { id: "x", nope: 1 })).isError).toBe(true);
    expect(logged(...spies).filter((l) => l.event === "mcp.call")).toEqual([
      { event: "mcp.call", level: "info", run: expect.any(String), tool: "get_send", error: true },
    ]);
  });

  it("logs mcp.call at info, with the code of the refusal that failed it and never its message", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    const post = (await callOk("save_draft", { subject: "Soon", markdown: "x" })).post;
    const tooSoon = await callTool("schedule_send", {
      id: post.id,
      fire_at: new Date(Date.now() + 1000).toISOString(),
    });
    expect(tooSoon.isError).toBe(true);
    const calls = logged(...spies).filter((l) => l.event === "mcp.call");
    expect(calls).toEqual([
      {
        event: "mcp.call",
        level: "info",
        run: expect.any(String),
        tool: "save_draft",
        error: false,
      },
      {
        event: "mcp.call",
        level: "info",
        run: expect.any(String),
        tool: "schedule_send",
        error: true,
        code: "fire_at_too_soon",
      },
    ]);
  });
});
