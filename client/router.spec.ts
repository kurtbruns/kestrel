import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { describeFormat } from "../shared/imports";
import type { ReferenceResponse } from "../shared/reference";
import type { ViewHandle } from "./lifecycle";
import { adoptLinkedRoute, installRouter, route } from "./router";
import { sendServer } from "./test/send_server";
import {
  $,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
  unmount,
} from "./test/support";

// The router's listeners are installed once by boot; here once per file (`beforeAll`),
// which is what a page gets. hashchange is dispatched by hand so the spec does not depend on whether the
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
  // Once for the file, as boot does once for a page, so every test runs with the router's
  // listeners whatever order the tests run in.
  beforeAll(() => {
    installRouter();
  });
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
  // Put the URL back first: happy-dom fires hashchange for a replaceState that moves the
  // hash, so its route has to land while the fake API still answers. Then leave no view or
  // stub behind, so nothing routes after the real fetch is back.
  afterEach(async () => {
    history.replaceState(null, "", "/dashboard/");
    await settle();
    unmount();
    fake.restore();
    vi.unstubAllGlobals();
  });

  it("mounts the view a hashchange names", async () => {
    expect(document.querySelector("#app h1")).toBeNull();
    await at("#/drafts");
    expect($("#app h1").textContent).toBe("Drafts");
    expect(fake.unhandled).toEqual([]);
  });

  it("opens the import under Subscribers, rather than reading `import` as a list filter", async () => {
    fake.restore();
    fake = fakeApi([{ path: "/api/imports/format", reply: () => describeFormat(10_000, null) }]);
    await at("#/subscribers/import");
    expect($("#app h1").textContent).toBe("Import subscribers");
    expect(
      document.querySelector(".sidebar a[data-view='subscribers']")?.getAttribute("aria-current"),
    ).toBe("page");
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
        reply: () =>
          jsonResponse({
            post: { slug: "herons", status: "draft", published_at: null },
            scheduled: null,
          }),
      },
    ]);
    await at("#/web/post/p1");
    expect(document.body.classList.contains("web-mode")).toBe(true);
    expect(document.querySelector(".web-frame")).not.toBeNull();
    await at("#/web/post/%E0");
    expect(document.body.classList.contains("web-mode")).toBe(false);
  });

  it("opens the dashboard home for a typed hash with a dot segment, reading only what the dashboard reads", async () => {
    // What a route reads, from a page elsewhere, so the route mounts its view afresh.
    const readsAt = async (hash: string) => {
      await at("#/drafts");
      fake.calls.length = 0;
      await at(hash);
      return fake.calls.map((c) => c.url.pathname + c.url.search);
    };
    const home = await readsAt("#/dashboard");
    expect(home).toContain("/api/sends?limit=200");
    for (const hash of ["#/sent/..", "#/sent/.", "#/sent/%2e%2E", "#/edit/..", "#/sent/x/../.."]) {
      expect(await readsAt(hash), hash).toEqual(home);
      const current = document.querySelector<HTMLElement>('.sidebar a[aria-current="page"]');
      expect(current?.dataset.view, hash).toBe("dashboard");
    }
  });

  it("opens an old #/reference link at the same place under #/api-reference, adding no history entry", async () => {
    fake.restore();
    const empty: ReferenceResponse = {
      concepts: [],
      statuses: [],
      refusals: [],
      objects: [],
      groups: [],
    };
    fake = fakeApi([{ path: "/api/reference", reply: () => empty }]);
    history.replaceState(null, "", "/dashboard/#/reference/cancel-send");
    const entries = history.length;
    await route();
    await settle();
    expect(location.hash).toBe("#/api-reference/cancel-send");
    expect(history.length).toBe(entries);
    expect($("#app .room-switch a[aria-current='page']").getAttribute("href")).toBe(
      "#/api-reference",
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("adopts the route a link from an email names in its query, adding no history entry", async () => {
    history.replaceState(null, "", "/dashboard/?to=/drafts");
    const entries = history.length;
    adoptLinkedRoute();
    expect(location.pathname).toBe("/dashboard/");
    expect(location.search).toBe("");
    expect(location.hash).toBe("#/drafts");
    expect(history.length).toBe(entries);
    // The first route() after it, as boot runs them, mounts the linked page.
    await route();
    await settle();
    expect($("#app h1").textContent).toBe("Drafts");
    expect(fake.unhandled).toEqual([]);
  });

  it("leaves a normal load alone, and a query that names no route where it is", () => {
    history.replaceState(null, "", "/dashboard/#/subscribers");
    adoptLinkedRoute();
    expect(location.search).toBe("");
    expect(location.hash).toBe("#/subscribers");
    history.replaceState(null, "", "/dashboard/?to=//elsewhere#/drafts");
    adoptLinkedRoute();
    expect(location.search).toBe("?to=//elsewhere");
    expect(location.hash).toBe("#/drafts");
  });

  it("takes a linked route over a hash beside it", () => {
    history.replaceState(null, "", "/dashboard/?to=/settings#/drafts");
    adoptLinkedRoute();
    expect(location.search).toBe("");
    expect(location.hash).toBe("#/settings");
  });
});
