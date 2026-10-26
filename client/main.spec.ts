import { afterEach, describe, expect, it, vi } from "vitest";
import { setToken } from "./auth";
import { appState } from "./state";
import {
  $,
  type FakeApi,
  fakeApi,
  jsonResponse,
  resetShell,
  settingsResponse,
  settle,
} from "./test/support";

const LOCKED = { error: "unauthorized", reason: "access_not_configured" };
const SESSION = {
  principal: { kind: "human", email: "kurt@example.com" },
  auth: { mode: "access" },
};

// boot() runs when main.ts is imported, so each test imports a fresh copy of it.
async function boot(): Promise<void> {
  // The build defines it; a spec runs the production path, with no live reload.
  vi.stubGlobal("__DEV__", false);
  vi.resetModules();
  await import("./main");
}

// A reply held open until the test lets it go, so a spec can look at the page mid-probe.
function held(): { reply: () => Promise<Response>; answer: (r: Response) => void } {
  let answer: (r: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  return { reply: () => pending, answer };
}

// The body's class as public/dashboard/index.html ships it, which every test starts from.
const SHIPPED = document.body.className;
const signedOut = () => document.body.classList.contains("signed-out");

describe("boot, before the probe answers", () => {
  let fake: FakeApi | undefined;
  afterEach(async () => {
    // The view a session routed to belongs to the copy boot() imported, so it is that
    // copy's lifecycle that tears it down.
    (await import("./lifecycle")).unmount();
    vi.unstubAllGlobals();
    fake?.restore();
    fake = undefined;
    setToken("");
    appState.session = null;
    appState.appConfig = null;
    resetShell();
    document.body.className = SHIPPED;
  });

  it("starts with the publication's chrome hidden, as the page ships", () => {
    expect(signedOut()).toBe(true);
  });

  it("keeps the chrome hidden on a locked editor, from the first paint to the wall", async () => {
    const whoami = held();
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => jsonResponse({ error: "not_found" }, 404) },
      { path: "/api/whoami", reply: whoami.reply },
    ]);
    await boot();
    await settle();
    expect(signedOut()).toBe(true);
    whoami.answer(jsonResponse(LOCKED, 401));
    await settle();
    expect(signedOut()).toBe(true);
    expect($("#app .access-wall h2").textContent).toBe(
      "The editor is locked until you set up Access",
    );
  });

  it("puts up the sign-in wall when whoami's 200 isn't the app's answer, never a blank page", async () => {
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => jsonResponse({ error: "not_found" }, 404) },
      // A proxy or an edge page in front of the app, answering for it.
      {
        path: "/api/whoami",
        reply: () =>
          new Response("<html>Sign in</html>", { headers: { "content-type": "text/html" } }),
      },
    ]);
    await boot();
    await vi.waitFor(() => expect($("#app .reauth-wall h2").textContent).toBe("Session expired"));
    expect(signedOut()).toBe(true);
  });

  it("puts up the sign-in wall when boot fails before the chrome shows, never a blank page", async () => {
    // happy-dom has no reportError, so the spec stands in for the browser's.
    const reportError = vi.fn();
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => jsonResponse({ error: "not_found" }, 404) },
      { path: "/api/whoami", reply: () => SESSION },
      // Read as settings, a body without them throws while the sidebar's brand is drawn.
      { path: "/api/settings", reply: () => ({}) },
    ]);
    vi.stubGlobal("reportError", reportError);
    await boot();
    await vi.waitFor(() => expect($("#app .reauth-wall h2").textContent).toBe("Session expired"));
    expect(signedOut()).toBe(true);
    // The failure still reaches the console as uncaught.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
  });

  it("shows the chrome, with its brand, once there is a session", async () => {
    const whoami = held();
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => jsonResponse({ error: "not_found" }, 404) },
      { path: "/api/whoami", reply: whoami.reply },
      { path: "/api/settings", reply: () => settingsResponse() },
    ]);
    await boot();
    await settle();
    expect(signedOut()).toBe(true);
    whoami.answer(jsonResponse(SESSION));
    await vi.waitFor(() => expect(signedOut()).toBe(false));
    expect($("#brandName").textContent).toBe("Birds Weekly");
    expect($("#identity").textContent).toContain("kurt@example.com");
  });
});
