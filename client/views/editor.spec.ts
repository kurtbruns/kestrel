import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../state";
import {
  $,
  type FakeApi,
  type FakeRequest,
  type FakeRoute,
  fakeApi,
  jsonResponse,
  resetShell,
  typeInto,
} from "../test_support";
import { renderEditor } from "./editor";

type Draft = { post: Record<string, unknown>; markdown: string; author: string | null };

const draft = (over: Record<string, unknown> = {}): Draft => ({
  post: {
    id: "p1",
    subject: "Owls",
    slug: "owls",
    status: "draft",
    current_revision: "r1",
    updated_at: "2026-09-20T10:00:00Z",
    ...over,
  },
  markdown: "# Owls\n\nHoot.",
  author: "a@b.c",
});

/**
 * A draft on a stateful fake server: GET answers the current state, PUT applies the save
 * and advances the revision. Consistent the way the real server is, which matters because
 * the editor's freshness poll compares what GET says against what its own saves produced.
 */
function draftServer(initial = draft()) {
  let state = initial;
  let n = 1;
  const server = {
    get: () => state,
    /** Apply a save, unless `intercept` answers instead (a 409, or a promise to answer later). */
    put(
      req: FakeRequest,
      intercept?: (req: FakeRequest) => Response | Promise<unknown> | undefined,
    ) {
      return intercept?.(req) ?? server.apply(req);
    },
    apply(req: FakeRequest) {
      const body = req.json() as Record<string, unknown>;
      n += 1;
      state = { ...state, post: { ...state.post, ...body, current_revision: `r${n}` } };
      return { post: state.post };
    },
    /** Another writer saved: the server moves on to a new revision. */
    elsewhere(author: string): string {
      n += 1;
      state = { ...state, post: { ...state.post, current_revision: `r${n}` }, author };
      return `r${n}`;
    },
  };
  return server;
}

describe("editor view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    location.hash = "#/edit/p1";
  });
  afterEach(() => {
    fake?.restore();
    appState.editorLeaveFlush = null;
    vi.useRealTimers();
  });

  async function mount(routes: FakeRoute[]) {
    fake = fakeApi(routes);
    await renderEditor("p1");
    await vi.advanceTimersByTimeAsync(0);
  }
  const puts = () => fake.calls.filter((c) => c.method === "PUT");
  const body = () => $<HTMLTextAreaElement>("#f-markdown");

  it("mounts a draft into its fields and reads as saved", async () => {
    await mount([{ path: "/posts/p1", reply: () => draft() }]);
    expect($<HTMLInputElement>("#f-subject").value).toBe("Owls");
    expect($<HTMLInputElement>("#f-slug").value).toBe("owls");
    expect(body().value).toBe("# Owls\n\nHoot.");
    expect($("#saveStatus").textContent).toBe("Saved");
    expect(appState.isEditorDirty).toBe(false);
  });

  it("marks an edit dirty, then autosaves it after the idle pause with the base revision", async () => {
    const server = draftServer();
    await mount([
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
    ]);
    typeInto(body(), "# Owls\n\nHoot hoot.");
    expect($("#saveStatus").textContent).toBe("Unsaved changes");
    expect(appState.isEditorDirty).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts()[0]?.json()).toMatchObject({
      markdown: "# Owls\n\nHoot hoot.",
      base_revision: "r1",
    });
    expect($("#saveStatus").textContent).toBe("Saved");
    expect(fake.unhandled).toEqual([]);
  });

  it("saves at the hard cap while the typing never pauses", async () => {
    const server = draftServer();
    await mount([
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
    ]);
    for (let ms = 0; ms < 30000; ms += 1000) {
      typeInto(body(), `${body().value}.`);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(puts()).toHaveLength(1);
  });

  it("keeps an edit typed during an in-flight save dirty, and sends it with the next save", async () => {
    const server = draftServer();
    let release: () => void = () => {};
    let held = false;
    await mount([
      { path: "/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/posts/p1",
        reply: (req) =>
          server.put(req, (r) => {
            if (held) {
              return undefined;
            }
            held = true; // the first save is held open until the spec releases it
            return new Promise((resolve) => {
              release = () => resolve(server.apply(r));
            });
          }),
      },
    ]);
    typeInto(body(), "one");
    await vi.advanceTimersByTimeAsync(5000); // the first save is in flight, holding "one"
    expect($("#saveStatus").textContent).toBe("Saving…");
    typeInto(body(), "one two"); // typed while it is in flight
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect($("#saveStatus").textContent).toBe("Unsaved changes"); // "two" was not in that save
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts().map((p) => (p.json() as { markdown: string }).markdown)).toEqual([
      "one",
      "one two",
    ]);
    expect($("#saveStatus").textContent).toBe("Saved");
  });

  it("shows the out-of-date banner on a stale save, pauses autosave, and keep-editing adopts the newer base", async () => {
    const server = draftServer();
    let theirs: string | null = null;
    await mount([
      { path: "/posts/p1", reply: server.get },
      {
        method: "PUT",
        path: "/posts/p1",
        reply: (req) =>
          server.put(req, (r) => {
            // Our first save loses a race: Claude saved first, so the server refuses ours,
            // and keeps refusing until we save against that revision.
            if (theirs === null) {
              theirs = server.elsewhere("service");
            }
            if ((r.json() as { base_revision: string }).base_revision === theirs) {
              return undefined;
            }
            return jsonResponse(
              {
                error: "stale_revision",
                message: "changed",
                current_revision: theirs,
                author: "service",
              },
              409,
            );
          }),
      },
    ]);
    typeInto(body(), "mine");
    await vi.advanceTimersByTimeAsync(5000);
    const banner = $("#freshnessBanner");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/changed elsewhere/);
    expect(banner.textContent).toMatch(/Claude/); // "service" reads as Claude
    expect(appState.editorConflict).toBe(true);
    typeInto(body(), "mine still");
    await vi.advanceTimersByTimeAsync(30000);
    expect(puts()).toHaveLength(1); // paused while the banner is up
    $("#freshKeep").click();
    expect(banner.hidden).toBe(true);
    expect(appState.editorConflict).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(puts()).toHaveLength(2);
    expect(puts()[1]?.json()).toMatchObject({ base_revision: theirs, markdown: "mine still" });
    expect($("#saveStatus").textContent).toBe("Saved");
  });

  it("warns when the freshness poll finds a newer revision, and locks when the post left draft", async () => {
    const server = draftServer();
    await mount([{ path: "/posts/p1", reply: server.get }]);
    server.elsewhere("x@y.z");
    await vi.advanceTimersByTimeAsync(10000);
    const banner = $("#freshnessBanner");
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/x@y\.z/);
    $("#freshKeep").click();
    server.apply({ json: () => ({ status: "scheduled" }) } as FakeRequest);
    await vi.advanceTimersByTimeAsync(10000);
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/scheduled elsewhere/);
    expect(document.querySelector("#freshKeep")).toBeNull(); // nothing to keep editing
  });

  it("flushes a dirty draft on navigation and marks it saved as sent", async () => {
    const server = draftServer();
    await mount([
      { path: "/posts/p1", reply: server.get },
      { method: "PUT", path: "/posts/p1", reply: (req) => server.put(req) },
    ]);
    typeInto(body(), "leaving");
    appState.editorLeaveFlush?.();
    expect(appState.isEditorDirty).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()[0]?.json()).toMatchObject({ markdown: "leaving", base_revision: "r1" });
  });

  it("mounts a scheduled post read-only, with no autosave", async () => {
    await mount([
      {
        path: "/posts/p1",
        reply: () => ({
          ...draft({ status: "scheduled" }),
          scheduled: { id: "s1", fire_at: "2026-09-25T15:00:00Z" },
        }),
      },
    ]);
    expect(body().readOnly).toBe(true);
    expect(document.querySelector("#saveBtn")).toBeNull(); // no save row at all
    typeInto(body(), "nope");
    await vi.advanceTimersByTimeAsync(30000);
    expect(puts()).toHaveLength(0);
  });
});
