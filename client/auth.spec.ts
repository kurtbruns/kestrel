import { afterEach, describe, expect, it } from "vitest";
import { probeSession, setToken } from "./auth";
import { appState } from "./state";
import { $, type FakeApi, fakeApi, jsonResponse, resetShell } from "./test/support";

const REFUSED = {
  error: "invalid_config",
  message: "APP_ORIGIN is not set; it is the origin the app is served from",
  variable: "APP_ORIGIN",
};

const SESSION = { principal: { kind: "human", email: "you@example.com" }, auth: { mode: "dev" } };

describe("the boot probe", () => {
  let fake: FakeApi;
  afterEach(() => {
    fake?.restore();
    setToken("");
    resetShell();
    document.body.classList.remove("signed-out");
  });

  const calls = () => fake.calls.map((c) => `${c.method} ${c.url.pathname}`);

  it("answers the session a probe finds, minting the dev token first", async () => {
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => ({ token: "t0k", kind: "human" }) },
      { path: "/api/whoami", reply: () => SESSION },
    ]);
    expect(await probeSession()).toEqual(SESSION);
    expect(fake.calls[1]?.headers.get("authorization")).toBe("Bearer t0k");
    expect(fake.unhandled).toEqual([]);
  });

  it("shows the refused configuration, not the sign-in wall, when deployed (SPEC §9)", async () => {
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => jsonResponse(REFUSED, 500) },
      { path: "/api/whoami", reply: () => jsonResponse(REFUSED, 500) },
    ]);
    expect(await probeSession()).toBeNull();
    expect($("#app .config-wall .config-wall-problem").textContent).toBe(REFUSED.message);
    expect(document.querySelector("#app #reauth")).toBeNull();
    expect(calls()).toEqual(["GET /api/dev/token", "GET /api/whoami"]);
  });

  it("shows it too after local development clears a stored token and mints again", async () => {
    setToken("stale");
    let minted = 0;
    fake = fakeApi([
      {
        path: "/api/dev/token",
        reply: () => {
          minted += 1;
          return { token: "fresh", kind: "human" };
        },
      },
      { path: "/api/whoami", reply: () => jsonResponse(REFUSED, 500) },
    ]);
    expect(await probeSession()).toBeNull();
    expect(minted).toBe(1);
    expect(calls()).toEqual(["GET /api/whoami", "GET /api/dev/token", "GET /api/whoami"]);
    expect(fake.calls[2]?.headers.get("authorization")).toBe("Bearer fresh");
    expect(document.querySelector("#app .config-wall")).not.toBeNull();
    expect(document.querySelector("#app #reauth")).toBeNull();
  });

  it("shows it when the re-mint is refused as well, leaving no stale token behind", async () => {
    setToken("stale");
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => jsonResponse(REFUSED, 500) },
      { path: "/api/whoami", reply: () => jsonResponse(REFUSED, 500) },
    ]);
    expect(await probeSession()).toBeNull();
    expect(appState.token).toBe("");
    expect(document.querySelector("#app .config-wall")).not.toBeNull();
    expect(document.querySelector("#app #reauth")).toBeNull();
  });

  it("sends anything else that fails to the sign-in wall", async () => {
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => jsonResponse({ error: "not_found" }, 404) },
      { path: "/api/whoami", reply: () => jsonResponse({ error: "unauthorized" }, 401) },
    ]);
    expect(await probeSession()).toBeNull();
    expect($("#app #reauth").textContent).toBe("Sign in");
    expect(document.querySelector("#app .config-wall")).toBeNull();
  });
});
