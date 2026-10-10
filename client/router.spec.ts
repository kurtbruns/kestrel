import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewHandle } from "./lifecycle";
import { adoptLinkedRoute, installRouter } from "./router";
import {
  $,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  sendServer,
  settle,
} from "./test/support";

// The router's listeners are installed once by boot; here once per file, which is what a
// page gets. hashchange is dispatched by hand so the spec does not depend on whether the
// DOM fires it for a scripted `location.hash = …` (happy-dom does, later; that echo lands
// on the hash already mounted and is nothing to do, the same as a revert's echo).
const hashchange = () => window.dispatchEvent(new Event("hashchange"));
/** Navigate the way a click does, and let the router mount. */
async function at(hash: string) {
  location.hash = hash;
  hashchange();
  await settle();
}

/** A stand-in for the view at the routed hash: whatever handle the test needs, nothing painted. */
const editorLike = (h: ViewHandle) => mount(() => h);

describe("router", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    fake = fakeApi([
      ...sendServer().routes, // Drafts follows its posts' sends
      {
        path: "/api/posts",
        reply: () => ({ posts: [], page: { total: 0, limit: 50, offset: 0 } }),
      },
      {
        path: "/api/subscribers",
        reply: () => ({
          subscribers: [],
          counts: { pending: 0, confirmed: 0, unsubscribed: 0, suppressed: 0 },
          page: { total: 0, limit: 50, offset: 0 },
        }),
      },
    ]);
  });
  afterEach(() => {
    fake.restore();
    vi.unstubAllGlobals();
  });

  it("installs once, then a hashchange mounts the view the hash names", async () => {
    expect(document.querySelector("#app h1")).toBeNull();
    installRouter();
    await at("#/drafts");
    expect($("#app h1").textContent).toBe("Drafts");
    expect(fake.unhandled).toEqual([]);
  });

  it("asks the mounted view before leaving, and goes when it answers leave", async () => {
    await at("#/subscribers");
    const beforeLeave = vi.fn(() => "leave" as const);
    await editorLike({ beforeLeave });
    await at("#/drafts");
    expect(beforeLeave).toHaveBeenCalledTimes(1);
    expect($("#app h1").textContent).toBe("Drafts");
  });

  it("prompts when the view answers confirm, and a declined prompt restores the hash and the view", async () => {
    // happy-dom has no confirm(); the router calls the global, so stand one in.
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await at("#/subscribers");
    await editorLike({ beforeLeave: () => "confirm" });
    await at("#/drafts");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(location.hash).toBe("#/subscribers");
    expect(document.querySelector("#app h1")).toBeNull(); // nothing was mounted over the stand-in
  });

  it("⌘S saves through the mounted view, and is inert when it offers no save", async () => {
    const press = () => {
      const e = new KeyboardEvent("keydown", { key: "s", metaKey: true, cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    await mount(() => undefined);
    expect(press()).toBe(false);
    const manualSave = vi.fn();
    await editorLike({ manualSave });
    expect(press()).toBe(true);
    expect(manualSave).toHaveBeenCalledTimes(1);
  });

  it("asks the browser to prompt before unload only while the mounted view is dirty", async () => {
    const leave = () => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    await editorLike({ dirty: () => false });
    expect(leave()).toBe(false);
    await editorLike({ dirty: () => true });
    expect(leave()).toBe(true);
  });

  it("adopts the route a link from an email names in its query, adding no history entry", () => {
    history.replaceState(null, "", "/dashboard/?to=/sent/s1");
    const entries = history.length;
    adoptLinkedRoute();
    expect(location.pathname).toBe("/dashboard/");
    expect(location.search).toBe("");
    expect(location.hash).toBe("#/sent/s1");
    expect(history.length).toBe(entries);
    // No query, or one that names no route: nothing changes.
    history.replaceState(null, "", "/dashboard/?to=//elsewhere#/drafts");
    adoptLinkedRoute();
    expect(location.search).toBe("?to=//elsewhere");
    expect(location.hash).toBe("#/drafts");
    history.replaceState(null, "", "/dashboard/");
  });

  it("gives a web-version route the whole window, and a mangled one keeps the navigation", async () => {
    fake.restore();
    fake = fakeApi([
      ...sendServer().routes,
      {
        path: "/api/posts/p1/web",
        reply: () => new Response("<html><head><title>Herons</title></head></html>"),
      },
      {
        path: "/api/posts/p1",
        reply: () => jsonResponse({ post: { slug: "herons", status: "draft" } }),
      },
    ]);
    await at("#/web/post/p1");
    expect(document.body.classList.contains("web-mode")).toBe(true);
    expect(document.querySelector(".web-frame")).not.toBeNull();
    await at("#/web/post/%E0");
    expect(document.body.classList.contains("web-mode")).toBe(false);
  });
});
