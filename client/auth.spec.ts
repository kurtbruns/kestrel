import { afterEach, describe, expect, it } from "vitest";
import { probeSession, setToken } from "./auth";
import { appState, TOKEN_KEY } from "./state";
import { $, type FakeApi, fakeApi, jsonResponse, resetShell } from "./test/support";

const REFUSED = {
  error: "invalid_config",
  message: "APP_ORIGIN is not set; it is the origin the app is served from",
  variable: "APP_ORIGIN",
};

// A local dev server's 401, the one answer a mint follows.
const DEV_401 = { error: "unauthorized", dev_token_available: true };

const SESSION = {
  principal: { kind: "human", email: "you@example.com", client: "editor" },
  auth: { mode: "dev" },
};

describe("the boot probe", () => {
  let fake: FakeApi;
  afterEach(() => {
    fake?.restore();
    setToken("");
    resetShell();
    document.body.classList.remove("signed-out");
  });

  const calls = () => fake.calls.map((c) => `${c.method} ${c.url.pathname}`);

  it("asks nothing of a dev route when the Access cookie already signs the operator in", async () => {
    const access = { ...SESSION, auth: { mode: "access" } };
    fake = fakeApi([{ path: "/api/whoami", reply: () => access }]);
    expect(await probeSession()).toEqual(access);
    expect(calls()).toEqual(["GET /api/whoami"]);
    expect(fake.calls[0]?.headers.get("authorization")).toBeNull();
    expect(appState.token).toBe("");
  });

  it("mints a dev token and probes again when local development has none yet", async () => {
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => ({ token: "t0k", kind: "human" }) },
      {
        path: "/api/whoami",
        reply: (req) => (req.headers.has("authorization") ? SESSION : jsonResponse(DEV_401, 401)),
      },
    ]);
    expect(await probeSession()).toEqual(SESSION);
    expect(calls()).toEqual(["GET /api/whoami", "GET /api/dev/token", "GET /api/whoami"]);
    expect(fake.calls[2]?.headers.get("authorization")).toBe("Bearer t0k");
    expect(appState.token).toBe("t0k");
    expect(document.querySelector("#app #reauth")).toBeNull();
  });

  it("keeps a stored dev token that still works, minting nothing", async () => {
    setToken("t0k");
    fake = fakeApi([{ path: "/api/whoami", reply: () => SESSION }]);
    expect(await probeSession()).toEqual(SESSION);
    expect(calls()).toEqual(["GET /api/whoami"]);
    expect(fake.calls[0]?.headers.get("authorization")).toBe("Bearer t0k");
    expect(appState.token).toBe("t0k");
  });

  it("replaces a stale dev token with one fresh mint and ends signed in", async () => {
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
      {
        path: "/api/whoami",
        reply: (req) =>
          req.headers.get("authorization") === "Bearer fresh"
            ? SESSION
            : jsonResponse(DEV_401, 401),
      },
    ]);
    expect(await probeSession()).toEqual(SESSION);
    expect(minted).toBe(1);
    expect(calls()).toEqual(["GET /api/whoami", "GET /api/dev/token", "GET /api/whoami"]);
    expect(fake.calls[0]?.headers.get("authorization")).toBe("Bearer stale");
    expect(fake.calls[2]?.headers.get("authorization")).toBe("Bearer fresh");
    expect(appState.token).toBe("fresh");
    expect(localStorage.getItem(TOKEN_KEY)).toBe("fresh");
    expect(document.querySelector("#app #reauth")).toBeNull();
  });

  it("shows the refused configuration, not the sign-in wall, and asks no dev route (SPEC §9)", async () => {
    fake = fakeApi([{ path: "/api/whoami", reply: () => jsonResponse(REFUSED, 500) }]);
    expect(await probeSession()).toBeNull();
    expect($("#app .config-wall .config-wall-problem").textContent).toBe(REFUSED.message);
    expect(document.querySelector("#app #reauth")).toBeNull();
    expect(calls()).toEqual(["GET /api/whoami"]);
  });

  it("keeps a stored token through a refused configuration, which a token can't fix", async () => {
    setToken("t0k");
    fake = fakeApi([{ path: "/api/whoami", reply: () => jsonResponse(REFUSED, 500) }]);
    expect(await probeSession()).toBeNull();
    expect(calls()).toEqual(["GET /api/whoami"]);
    expect(appState.token).toBe("t0k");
    expect(document.querySelector("#app .config-wall")).not.toBeNull();
  });

  it("lands on the sign-in wall with no stale token left when an offered mint fails", async () => {
    setToken("stale");
    fake = fakeApi([
      { path: "/api/dev/token", reply: () => jsonResponse({ error: "internal_error" }, 500) },
      { path: "/api/whoami", reply: () => jsonResponse(DEV_401, 401) },
    ]);
    expect(await probeSession()).toBeNull();
    expect(calls()).toEqual(["GET /api/whoami", "GET /api/dev/token"]);
    expect(appState.token).toBe("");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect($("#app #reauth").textContent).toBe("Sign in");
  });

  it("asks no dev route when the probe's fetch fails (SPEC §11)", async () => {
    fake = fakeApi([
      {
        path: "/api/whoami",
        reply: () => {
          throw new TypeError("Failed to fetch");
        },
      },
    ]);
    expect(await probeSession()).toBeNull();
    expect(calls()).toEqual(["GET /api/whoami"]);
    expect($("#app #reauth").textContent).toBe("Sign in");
  });

  it("lands on the sign-in wall, asking no dev route, when a 200 isn't the app's JSON", async () => {
    fake = fakeApi([{ path: "/api/whoami", reply: () => new Response("<html>", { status: 200 }) }]);
    expect(await probeSession()).toBeNull();
    expect(calls()).toEqual(["GET /api/whoami"]);
    expect($("#app #reauth").textContent).toBe("Sign in");
  });

  it("takes an offer only from a failed probe, so a 200 carrying one mints nothing", async () => {
    fake = fakeApi([{ path: "/api/whoami", reply: () => DEV_401 }]);
    expect(await probeSession()).toBeNull();
    expect(calls()).toEqual(["GET /api/whoami"]);
    expect($("#app #reauth").textContent).toBe("Sign in");
  });

  it("shows a database behind the release as the refusal wall, never the Access-locked or sign-in wall (SPEC §9)", async () => {
    const behind = {
      error: "schema_behind",
      missing: ["0003_post_slug_auto.sql"],
      message: "The database is missing a migration this release needs (0003_post_slug_auto.sql).",
    };
    fake = fakeApi([{ path: "/api/whoami", reply: () => jsonResponse(behind, 500) }]);
    expect(await probeSession()).toBeNull();
    expect($("#app .config-wall h2").textContent).toBe("The database needs updating");
    expect($("#app .config-wall .config-wall-problem").textContent).toBe(behind.message);
    expect(document.querySelector("#app .access-wall")).toBeNull();
    expect(document.querySelector("#app #reauth")).toBeNull();
  });

  it("sends anything else that fails to the sign-in wall, asking no dev route (SPEC §11)", async () => {
    fake = fakeApi([
      { path: "/api/whoami", reply: () => jsonResponse({ error: "unauthorized" }, 401) },
    ]);
    expect(await probeSession()).toBeNull();
    expect($("#app #reauth").textContent).toBe("Sign in");
    expect(document.querySelector("#app .config-wall")).toBeNull();
    expect(calls()).toEqual(["GET /api/whoami"]);
  });
});
