import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS_GUIDE, accessNotConfigured, showAccessLocked } from "./access_locked";
import { api } from "./api";
import { probeSession, setToken } from "./auth";
import { renderDrafts } from "./posts/drafts";
import { sendServer } from "./test/send_server";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
} from "./test/support";

const LOCKED = { error: "unauthorized", reason: "access_not_configured" };

describe("the locked editor, before Access is set up (SPEC §11)", () => {
  let fake: FakeApi | undefined;
  afterEach(() => {
    fake?.restore();
    fake = undefined;
    setToken("");
    resetShell();
    document.body.classList.remove("signed-out");
  });

  it("is what the boot probe shows on a deployment with no Access, not a session that expired", async () => {
    fake = fakeApi([
      // Deployed: the dev token route is absent.
      { path: "/api/dev/token", reply: () => jsonResponse({ error: "not_found" }, 404) },
      { path: "/api/whoami", reply: () => jsonResponse(LOCKED, 401) },
    ]);
    expect(await probeSession()).toBeNull();
    expect(document.body.classList.contains("signed-out")).toBe(true);
    const wall = $("#app .access-wall");
    expect($("h2", wall).textContent).toBe("The editor is locked until you set up Access");
    expect(wall.textContent).toContain("can’t tell who is asking, so it lets no one in");
    // The editor's Docs tab is behind the same 401, so the guide is the published one.
    const link = $("a", wall);
    expect(link.getAttribute("href")).toBe(ACCESS_GUIDE);
    expect(link.textContent).toContain("Lock the dashboard with Access");
    expect(link.getAttribute("target")).toBe("_blank");
    expect($(".visually-hidden", link).textContent).toBe(" (opens in a new tab)");
    expect(wall.textContent).not.toContain("Session expired");
    expect(document.querySelector("#app #reauth")).toBeNull();
    expect(document.activeElement).toBe($("h2", wall));
    expect(fake.unhandled).toEqual([]);
  });

  it("keeps the session-expired wall for any other 401", async () => {
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => jsonResponse({ error: "not_found" }, 404) },
      { path: "/api/whoami", reply: () => jsonResponse({ error: "unauthorized" }, 401) },
    ]);
    expect(await probeSession()).toBeNull();
    expect($("#app .auth-wall h2").textContent).toBe("Session expired");
    expect($("#app #reauth").textContent).toBe("Sign in");
    expect(document.querySelector("#app .access-wall")).toBeNull();
    expect(document.activeElement).toBe($("#app .auth-wall h2"));
  });

  it("draws the session-expired wall once, however many calls fail", async () => {
    fake = fakeApi([
      { path: "/api/posts", reply: () => jsonResponse({ error: "unauthorized" }, 401) },
    ]);
    await api("/api/posts").catch(() => {});
    const wall = $("#app .auth-wall");
    $<HTMLButtonElement>("#reauth", wall).focus();
    await api("/api/posts").catch(() => {});
    expect($("#app .auth-wall")).toBe(wall);
    expect(document.activeElement).toBe($("#reauth", wall));
  });

  it("takes over from a mounted view whose call finds no Access, once however many calls fail", async () => {
    fake = fakeApi([
      ...sendServer().routes,
      {
        path: "/api/posts",
        reply: () => ({
          posts: [],
          page: { total: 0, limit: 50, offset: 0, sort: "", dir: "desc" },
          cursor: "0.0",
        }),
      },
      { method: "POST", path: "/api/posts", reply: () => jsonResponse(LOCKED, 401) },
    ]);
    location.hash = "#/drafts";
    await mount(renderDrafts);
    await settle();
    const view = $("h1").closest("#app > *");
    $("#newPost").click();
    await settle();
    expect(view?.isConnected).toBe(false);
    const wall = $("#app .access-wall");
    const err = await api("/api/posts", { method: "POST", json: {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, data: LOCKED });
    expect($$("#app .access-wall")).toHaveLength(1);
    expect($("#app .access-wall")).toBe(wall);
    expect(fake.unhandled).toEqual([]);
  });

  it("reads only an unauthorized body that says access_not_configured", () => {
    expect(accessNotConfigured(LOCKED)).toBe(true);
    expect(accessNotConfigured({ error: "unauthorized" })).toBe(false);
    expect(accessNotConfigured({ error: "forbidden", reason: "access_not_configured" })).toBe(
      false,
    );
    expect(accessNotConfigured(null)).toBe(false);
  });

  it("reloads from its one button", () => {
    const reload = vi.fn();
    vi.spyOn(window, "location", "get").mockReturnValue({ ...location, reload } as Location);
    try {
      showAccessLocked();
      const buttons = $$("#app .access-wall button");
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.textContent).toBe("Reload");
      buttons[0]!.click();
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
