// Self-contained-by-default config (SPEC §11): the archive origin and media base
// fall back to the app's own origin, and ARCHIVE_BASE_PATH drives both the emitted
// archive URL and the route registered to serve it.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MIN_LEAD_MS, MIN_LEAD_CEILING_MS, MIN_LEAD_FLOOR_MS } from "../shared/sends";
import { createRouter, isReaderPath } from "../src/app";
import * as posts from "../src/db/posts";
import { type AppEnv, ConfigError, getConfig } from "../src/env";
import { clearFakeOutbox } from "../src/providers/fake";
import type { RequestContext } from "../src/router";
import * as devRoutes from "../src/routes/dev";
import * as renderRoutes from "../src/routes/render_actions";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { NOT_CONNECTED_DEPLOY, RESEND_DEPLOY, SES_DEPLOY } from "./support/deploy";
import { resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, base } from "./support/http";
import { allowErrorLogs, logged } from "./support/log";
import { fetchWith, withVars } from "./support/worker_env";

/** Vars alone, no bindings, for the pure getConfig tests: unlike `withVars` it starts from
 *  a minimal set of vars, not the suite's env, so any other var left out is unset and one
 *  can be unset outright with `undefined` (no D1/R2 needed). */
function varsOnly(overrides: Record<string, string | undefined>): AppEnv {
  return {
    APP_ORIGIN: "https://app.example",
    SENDING_DOMAIN: "send.example",
    FROM_ADDRESS: "News <news@send.example>",
    AWS_REGION: "us-east-1",
    ...overrides,
  } as unknown as AppEnv;
}

describe("getConfig — self-contained defaults", () => {
  it("defaults the archive origin and media base to the app's own origin", () => {
    const config = getConfig(varsOnly({}));
    expect(config.archiveOrigin).toBe("https://app.example");
    expect(config.mediaPublicBase).toBe("https://app.example/media");
    expect(config.archiveBasePath).toBe("/archive");
  });

  it("uses explicit overrides when set (the apex / media-domain opt-in)", () => {
    const config = getConfig(
      varsOnly({
        ARCHIVE_ORIGIN: "https://birds.example",
        MEDIA_PUBLIC_BASE: "https://media.birds.example",
        ARCHIVE_BASE_PATH: "/archive",
      }),
    );
    expect(config.archiveOrigin).toBe("https://birds.example");
    expect(config.mediaPublicBase).toBe("https://media.birds.example");
    expect(config.archiveBasePath).toBe("/archive");
  });

  it("normalizes the base path (leading slash, no trailing slash) and defaults when empty", () => {
    expect(getConfig(varsOnly({ ARCHIVE_BASE_PATH: "issues" })).archiveBasePath).toBe("/issues");
    expect(getConfig(varsOnly({ ARCHIVE_BASE_PATH: "/issues/" })).archiveBasePath).toBe("/issues");
    expect(getConfig(varsOnly({ ARCHIVE_BASE_PATH: "" })).archiveBasePath).toBe("/archive");
  });
});

// `devMode` gates the dev-only "Open dashboard" link the reader surface injects
// (SPEC §5/§11). It must be on ONLY where the dev credential path is live — the one
// case `/dashboard` is reachable without an Access wall — and structurally off in
// any deployed env, so a public page never links toward the Access gate there.
describe("getConfig — the dev-mode reader-surface gate", () => {
  const LOCAL = "http://localhost:8787";

  it("is on in a dev-shaped env with the dev secret present", () => {
    const config = getConfig(
      varsOnly({ PROVIDER: "fake", DEV_AUTH_SECRET: "s", APP_ORIGIN: LOCAL }),
    );
    expect(config.devMode).toBe(true);
    expect(config.devAuthSecret).toBe("s");
  });

  it("is off without a dev secret — the auto-minted token, and so the link, can't work", () => {
    const config = getConfig(varsOnly({ PROVIDER: "fake", APP_ORIGIN: LOCAL }));
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
  });

  it("is off once Access is configured, even on the fake transport", () => {
    const config = getConfig(
      varsOnly({
        PROVIDER: "fake",
        DEV_AUTH_SECRET: "s",
        APP_ORIGIN: LOCAL,
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        ACCESS_AUD: "aud-tag",
      }),
    );
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
  });

  it("is off on a real provider (a deployed env is never dev-shaped)", () => {
    const config = getConfig(varsOnly({ ...SES_DEPLOY, DEV_AUTH_SECRET: "s", APP_ORIGIN: LOCAL }));
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
  });

  it("is off on the fake transport served from anywhere but this machine, a demo's included", () => {
    const config = getConfig(
      varsOnly({ PROVIDER: "fake", ALLOW_FAKE_PROVIDER: "true", DEV_AUTH_SECRET: "s" }),
    );
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
  });
});

// Deploy config that would run but do the wrong thing is refused, naming the variable
// (SPEC §9). Each case below used to run: as a quiet fake, or mailing example.com links.
describe("getConfig — deploy config is validated", () => {
  const refuses = (overrides: Record<string, string | undefined>, variable: string) => {
    let thrown: unknown;
    try {
      getConfig(varsOnly(overrides));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).variable).toBe(variable);
  };

  it("refuses an unknown or mis-cased PROVIDER instead of faking sends", () => {
    for (const p of ["SES", "Resend", "ses ", "sendgrid"]) {
      refuses({ ...SES_DEPLOY, PROVIDER: p }, "PROVIDER");
    }
  });

  it("reads an unset PROVIDER as no provider connected, never the fake (SPEC §9)", () => {
    expect(getConfig(varsOnly({ PROVIDER: undefined })).provider).toBe("none");
  });

  it("reads the production template's empty PROVIDER as not connected (SPEC §9)", () => {
    const config = getConfig(varsOnly({ PROVIDER: "" }));
    expect(config.provider).toBe("none");
    expect(config.devMode).toBe(false);
  });

  it("refuses the fake on an origin off this machine, naming PROVIDER (SPEC §9)", () => {
    let thrown: unknown;
    try {
      getConfig(varsOnly({ PROVIDER: "fake", APP_ORIGIN: "https://newsletter.birds.example" }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).variable).toBe("PROVIDER");
    expect((thrown as ConfigError).message).toBe(
      'PROVIDER is "fake", which delivers nothing, and runs only on a local APP_ORIGIN (localhost or 127.0.0.1), not https://newsletter.birds.example: set your email provider, or leave PROVIDER empty until you connect one',
    );
    // An empty opt-in is no opt-in.
    refuses({ PROVIDER: "fake", ALLOW_FAKE_PROVIDER: "" }, "PROVIDER");
  });

  it("runs the fake on a loopback origin with no opt-in", () => {
    for (const origin of ["http://localhost:8787", "http://127.0.0.1:8787"]) {
      expect(getConfig(varsOnly({ PROVIDER: "fake", APP_ORIGIN: origin })).provider).toBe("fake");
    }
  });

  it("runs the fake on a public origin when the deployment opts in, as a hosted demo does", () => {
    const config = getConfig(
      varsOnly({
        PROVIDER: "fake",
        ALLOW_FAKE_PROVIDER: "true",
        APP_ORIGIN: "https://demo.birds.example",
      }),
    );
    expect(config.provider).toBe("fake");
    expect(config.devMode).toBe(false);
  });

  it("leaves local development dev-shaped when the opt-in is set there too", () => {
    const config = getConfig(
      varsOnly({
        PROVIDER: "fake",
        ALLOW_FAKE_PROVIDER: "true",
        DEV_AUTH_SECRET: "s",
        APP_ORIGIN: "http://localhost:8787",
      }),
    );
    expect(config.devMode).toBe(true);
    expect(config.devAuthSecret).toBe("s");
  });

  it("refuses an ALLOW_FAKE_PROVIDER other than true, rather than reading it as off", () => {
    for (const v of ["1", "yes", "TRUE", "false"]) {
      refuses({ PROVIDER: "fake", ALLOW_FAKE_PROVIDER: v }, "ALLOW_FAKE_PROVIDER");
    }
  });

  it("ignores ALLOW_FAKE_PROVIDER on every other provider", () => {
    const allow = { ALLOW_FAKE_PROVIDER: "true", APP_ORIGIN: "https://newsletter.birds.example" };
    expect(getConfig(varsOnly({ ...allow, PROVIDER: "" })).provider).toBe("none");
    expect(getConfig(varsOnly({ ...allow, ...RESEND_DEPLOY })).provider).toBe("resend");
    expect(getConfig(varsOnly({ ...allow, ...SES_DEPLOY })).provider).toBe("ses");
    // It lifts nothing the fake's exemption covers: the placeholder is still refused.
    refuses(
      {
        ...RESEND_DEPLOY,
        ALLOW_FAKE_PROVIDER: "true",
        APP_ORIGIN: "https://newsletter.example.com",
      },
      "APP_ORIGIN",
    );
  });

  it("refuses a missing or malformed APP_ORIGIN", () => {
    refuses({ APP_ORIGIN: undefined }, "APP_ORIGIN");
    refuses({ APP_ORIGIN: "" }, "APP_ORIGIN");
    refuses({ APP_ORIGIN: "newsletter.birds.example" }, "APP_ORIGIN");
    refuses({ APP_ORIGIN: "ftp://newsletter.birds.example" }, "APP_ORIGIN");
    refuses({ APP_ORIGIN: "https://newsletter.birds.example/app" }, "APP_ORIGIN");
    refuses({ ARCHIVE_ORIGIN: "not a url" }, "ARCHIVE_ORIGIN");
    refuses({ MEDIA_PUBLIC_BASE: "https://media.birds.example/?x=1" }, "MEDIA_PUBLIC_BASE");
  });

  it("normalizes away trailing slashes, so emitted URLs never double one", () => {
    const config = getConfig(
      varsOnly({
        APP_ORIGIN: "https://app.example/",
        ARCHIVE_ORIGIN: "https://birds.example/",
        MEDIA_PUBLIC_BASE: "https://cdn.birds.example/media/",
      }),
    );
    expect(config.appOrigin).toBe("https://app.example");
    expect(config.archiveOrigin).toBe("https://birds.example");
    expect(config.mediaPublicBase).toBe("https://cdn.birds.example/media");
  });

  it("refuses a real provider missing any of its credentials", () => {
    for (const name of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_REGION",
      "SNS_TOPIC_ARN",
      "FROM_ADDRESS",
    ]) {
      refuses({ ...SES_DEPLOY, [name]: undefined }, name);
    }
    for (const name of ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "FROM_ADDRESS"]) {
      refuses({ ...RESEND_DEPLOY, [name]: "" }, name);
    }
    expect(getConfig(varsOnly({ ...SES_DEPLOY })).provider).toBe("ses");
    expect(getConfig(varsOnly({ ...RESEND_DEPLOY })).provider).toBe("resend");
  });

  // Each setting on its own placeholder, one at a time, the rest real.
  const PLACEHOLDERS: [string, string][] = [
    ["APP_ORIGIN", "https://newsletter.example.com"],
    ["ARCHIVE_ORIGIN", "https://example.com"],
    ["MEDIA_PUBLIC_BASE", "https://media.example.com"],
    ["SENDING_DOMAIN", "send.example.com"],
    ["SENDING_DOMAIN", " Send.Example.com. "],
    ["FROM_ADDRESS", "Newsletter <newsletter@send.example.com>"],
    ["FROM_ADDRESS", "newsletter@example.com"],
  ];

  it("refuses each setting still on the template's example.com placeholder while no provider is connected (SPEC §9)", () => {
    for (const [name, value] of PLACEHOLDERS) {
      refuses({ ...NOT_CONNECTED_DEPLOY, [name]: value }, name);
      refuses({ ...NOT_CONNECTED_DEPLOY, PROVIDER: "none", [name]: value }, name);
    }
    expect(getConfig(varsOnly({ ...NOT_CONNECTED_DEPLOY })).provider).toBe("none");
  });

  it("refuses each setting still on the template's example.com placeholder with a real provider (SPEC §9)", () => {
    for (const [name, value] of PLACEHOLDERS) {
      refuses({ ...SES_DEPLOY, [name]: value }, name);
      refuses({ ...RESEND_DEPLOY, [name]: value }, name);
    }
    refuses({ ...SES_DEPLOY, FROM_ADDRESS: "no address here" }, "FROM_ADDRESS");
    // The reason names the provider, which a not-connected deployment has none of.
    expect(() =>
      getConfig(varsOnly({ ...SES_DEPLOY, SENDING_DOMAIN: "send.example.com" })),
    ).toThrow(
      `SENDING_DOMAIN is still on the template's example.com placeholder; PROVIDER "ses" sends real email`,
    );
  });

  it("refuses the production template's vars as shipped, naming the app's origin first", () => {
    refuses(
      {
        PROVIDER: undefined,
        APP_ORIGIN: "https://newsletter.example.com",
        SENDING_DOMAIN: "send.example.com",
        FROM_ADDRESS: "Newsletter <newsletter@send.example.com>",
      },
      "APP_ORIGIN",
    );
  });

  it("leaves a From it can't read to the provider step while no provider is connected", () => {
    const config = getConfig(varsOnly({ ...NOT_CONNECTED_DEPLOY, FROM_ADDRESS: "no address" }));
    expect(config.provider).toBe("none");
  });

  it("leaves a domain that only ends in example.com alone", () => {
    const config = getConfig(
      varsOnly({
        ...NOT_CONNECTED_DEPLOY,
        APP_ORIGIN: "https://newsletter.myexample.com",
        FROM_ADDRESS: "News <news@send.notexample.com>",
      }),
    );
    expect(config.appOrigin).toBe("https://newsletter.myexample.com");
  });

  it("takes the From address from the last angle brackets, not a bracketed display name", () => {
    const from = '"Birds <weekly>" <news@send.birds.example>';
    expect(getConfig(varsOnly({ ...SES_DEPLOY, FROM_ADDRESS: from })).fromAddress).toBe(from);
  });

  it("never echoes a URL's credentials in the error, which is a public 500", () => {
    let message = "";
    try {
      getConfig(varsOnly({ MEDIA_PUBLIC_BASE: "https://user:s3cret@cdn.birds.example/media" }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^MEDIA_PUBLIC_BASE /);
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("user:");
  });

  it("leaves the placeholders alone on the fake transport, which mails no one", () => {
    const config = getConfig(
      varsOnly({
        PROVIDER: "fake",
        ALLOW_FAKE_PROVIDER: "true",
        APP_ORIGIN: "https://newsletter.example.com",
        ARCHIVE_ORIGIN: "https://example.com",
        MEDIA_PUBLIC_BASE: "https://media.example.com",
        SENDING_DOMAIN: "send.example.com",
        FROM_ADDRESS: "Newsletter <newsletter@send.example.com>",
      }),
    );
    expect(config.provider).toBe("fake");
    expect(config.appOrigin).toBe("https://newsletter.example.com");
  });

  it("resolves the minimum lead from MIN_LEAD_SECONDS, five minutes when unset (SPEC §6)", () => {
    expect(getConfig(varsOnly({})).minLeadMs).toBe(DEFAULT_MIN_LEAD_MS);
    expect(getConfig(varsOnly({ MIN_LEAD_SECONDS: "" })).minLeadMs).toBe(DEFAULT_MIN_LEAD_MS);
    expect(getConfig(varsOnly({ MIN_LEAD_SECONDS: "60" })).minLeadMs).toBe(MIN_LEAD_FLOOR_MS);
    expect(getConfig(varsOnly({ MIN_LEAD_SECONDS: " 900 " })).minLeadMs).toBe(15 * 60 * 1000);
    // The same floor on a real provider: there is no environment where it differs.
    expect(getConfig(varsOnly({ ...SES_DEPLOY, MIN_LEAD_SECONDS: "60" })).minLeadMs).toBe(60_000);
  });

  it("refuses a minimum lead under the one-minute floor instead of raising it, in every environment", () => {
    for (const value of ["59", "30", "1", "0", "-60", "1.5", "five", "5m"]) {
      refuses({ MIN_LEAD_SECONDS: value }, "MIN_LEAD_SECONDS");
      refuses({ ...RESEND_DEPLOY, MIN_LEAD_SECONDS: value }, "MIN_LEAD_SECONDS");
    }
    let message = "";
    try {
      getConfig(varsOnly({ MIN_LEAD_SECONDS: "30" }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/MIN_LEAD_SECONDS must be at least 60/);
    expect(message).toMatch(/once a minute/);
  });

  it("refuses a minimum lead over a day, the likeliest a value in milliseconds, instead of clamping it", () => {
    expect(getConfig(varsOnly({ MIN_LEAD_SECONDS: "86400" })).minLeadMs).toBe(MIN_LEAD_CEILING_MS);
    for (const value of ["86401", "300000", "9999999999999", "1e306"]) {
      refuses({ MIN_LEAD_SECONDS: value }, "MIN_LEAD_SECONDS");
      refuses({ ...RESEND_DEPLOY, MIN_LEAD_SECONDS: value }, "MIN_LEAD_SECONDS");
    }
    let message = "";
    try {
      getConfig(varsOnly({ MIN_LEAD_SECONDS: "300000" }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/MIN_LEAD_SECONDS must be at most 86400/);
    expect(message).toMatch(/in seconds/);
  });

  it("refuses half an Access config, naming the half that is missing", () => {
    refuses({ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }, "ACCESS_AUD");
    refuses({ ACCESS_AUD: "aud-tag" }, "ACCESS_TEAM_DOMAIN");
    refuses({ ...RESEND_DEPLOY, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }, "ACCESS_AUD");
    refuses(
      { ...RESEND_DEPLOY, ACCESS_AUD: "aud-tag", ACCESS_TEAM_DOMAIN: " " },
      "ACCESS_TEAM_DOMAIN",
    );
    // Both, or neither, runs.
    const both = getConfig(
      varsOnly({ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud-tag" }),
    );
    expect([both.accessTeamDomain, both.accessAud]).toEqual([
      "team.cloudflareaccess.com",
      "aud-tag",
    ]);
    const neither = getConfig(varsOnly({}));
    expect([neither.accessTeamDomain, neither.accessAud]).toEqual([undefined, undefined]);
  });

  it("reads the team domain as a bare host, with or without its scheme and trailing slash", () => {
    const teamDomain = (value: string) =>
      getConfig(varsOnly({ ACCESS_TEAM_DOMAIN: value, ACCESS_AUD: "aud-tag" })).accessTeamDomain;
    for (const value of [
      "team.cloudflareaccess.com",
      " team.cloudflareaccess.com ",
      "https://team.cloudflareaccess.com",
      "http://team.cloudflareaccess.com",
      "team.cloudflareaccess.com/",
      "https://team.cloudflareaccess.com/",
      "HTTPS://Team.CloudflareAccess.com/",
    ]) {
      expect(teamDomain(value), value).toBe("team.cloudflareaccess.com");
    }
  });

  it("refuses a team domain that is not a hostname, without repeating the secret", () => {
    for (const value of [
      "https://",
      "team",
      "team.cloudflareaccess.com/cdn-cgi/access",
      "team.cloudflareaccess.com:443",
      "ftp://team.cloudflareaccess.com",
      "https://https://team.cloudflareaccess.com",
      "team .cloudflareaccess.com",
      "-team.cloudflareaccess.com",
      "team..cloudflareaccess.com",
    ]) {
      refuses({ ACCESS_TEAM_DOMAIN: value, ACCESS_AUD: "aud-tag" }, "ACCESS_TEAM_DOMAIN");
    }
    let message = "";
    try {
      getConfig(varsOnly({ ACCESS_TEAM_DOMAIN: "team.secret-host.com/x", ACCESS_AUD: "aud-tag" }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/ACCESS_TEAM_DOMAIN must be your team's hostname/);
    expect(message).not.toContain("secret-host");
  });
});

// While a setting is refused, the admin surface names it and a reader is told only that the
// page is unavailable (SPEC §9).
describe("a refused config, on each surface", () => {
  const REFUSED = { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers the API and the machine paths with a 500 that names the variable", async () => {
    allowErrorLogs("config.invalid");
    for (const [method, path] of [
      ["GET", "/api/whoami"],
      ["GET", "/api/settings"],
      ["GET", "/api/docs"],
      ["GET", "/api/dev/token"],
      ["GET", "/health"],
      ["POST", "/webhooks/resend"],
    ] as const) {
      const res = await fetchWith(REFUSED, path, { method, headers: AUTH });
      expect(res.status, `${method} ${path}`).toBe(500);
      expect(await res.json(), `${method} ${path}`).toMatchObject({
        error: "invalid_config",
        variable: "ACCESS_AUD",
        message: expect.stringContaining("ACCESS_AUD"),
      });
    }
  });

  it("answers every reader page with a plain 503 that names no setting", async () => {
    allowErrorLogs("config.invalid");
    for (const [method, path, init] of [
      ["GET", "/", {}],
      ["GET", "/archive", {}],
      ["GET", "/archive/spring-migration", {}],
      ["GET", "/subscribe", {}],
      [
        "POST",
        "/subscribe",
        {
          body: "email=reader%40example.com",
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
      ],
      ["GET", "/confirm?token=abc", {}],
      ["GET", "/unsubscribe?token=abc", {}],
      ["GET", "/media/logo.png", {}],
      ["GET", "/no-such-page", {}],
    ] as const) {
      const res = await fetchWith(REFUSED, path, { method, ...init });
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("retry-after"), path).toBe("300");
      const body = await res.text();
      expect(body, path).toContain("This page is temporarily unavailable");
      // No way home: `/` is this same page until the configuration is fixed.
      expect(body, path).not.toContain('class="r-brand"');
      for (const detail of ["ACCESS", "invalid_config", "team.cloudflareaccess.com"]) {
        expect(body, `${path}: ${detail}`).not.toContain(detail);
      }
    }
  });

  // The line is drawn on the path as written: only `/api` itself and what is under it, the
  // probe exactly, and what is under `/webhooks/` keep the JSON. A look-alike, a doubled
  // slash, or an encoded letter is not one of those paths, so it gets the page.
  it.each([
    ["/api", "json"],
    ["/apifoo", "page"],
    ["/healthz", "page"],
    ["/health/", "page"],
    ["/webhooks", "page"],
    ["//api/x", "page"],
    ["/%61pi/whoami", "page"],
  ])("answers %s with the %s", async (path, answer) => {
    allowErrorLogs("config.invalid");
    const res = await fetchWith(REFUSED, path, { headers: AUTH });
    const body = await res.text();
    if (answer === "json") {
      expect(res.status).toBe(500);
      expect(JSON.parse(body)).toMatchObject({ error: "invalid_config", variable: "ACCESS_AUD" });
    } else {
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(body).toContain("This page is temporarily unavailable");
      expect(body).not.toContain("ACCESS_AUD");
    }
  });

  it("serves nothing while no provider is connected and the app's origin is the template's placeholder (SPEC §9)", async () => {
    allowErrorLogs("config.invalid");
    const shipped = { PROVIDER: "", APP_ORIGIN: "https://newsletter.example.com" };
    const page = await fetchWith(shipped, "/archive");
    expect(page.status).toBe(503);
    expect(await page.text()).not.toContain("example.com");
    const api = await fetchWith(shipped, "/api/whoami", { headers: AUTH });
    expect(api.status).toBe(500);
    expect(await api.json()).toMatchObject({
      error: "invalid_config",
      variable: "APP_ORIGIN",
      message:
        "APP_ORIGIN is still on the template's example.com placeholder; replace it with your own domain",
    });
  });

  it("serves nothing when the fake is copied into a deployment, so signups can't open (SPEC §9)", async () => {
    allowErrorLogs("config.invalid");
    const copied = { PROVIDER: "fake", APP_ORIGIN: "https://newsletter.birds.example" };
    const subscribe = await fetchWith(copied, "/subscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=reader%40birds.example",
    });
    expect(subscribe.status).toBe(503);
    const health = await fetchWith(copied, "/health");
    expect(health.status).toBe(500);
    expect(await health.json()).toMatchObject({ error: "invalid_config", variable: "PROVIDER" });
  });

  it("still logs the variable when a reader page is what found it", async () => {
    allowErrorLogs("config.invalid");
    const spy = vi.spyOn(console, "error");
    // A value of its own, since the cause is logged once per isolate.
    const provider = `sendgrid-${crypto.randomUUID()}`;
    expect((await fetchWith({ PROVIDER: provider }, "/")).status).toBe(503);
    expect(logged(spy).filter((l) => l.event === "config.invalid")).toEqual([
      expect.objectContaining({ variable: "PROVIDER", message: expect.stringContaining(provider) }),
    ]);
  });

  // The pre-route answer draws the reader line by path; it has to agree with the manifest's.
  it("counts every public route but the probe and the dev tooling as a reader page, and nothing else", () => {
    for (const route of createRouter({
      archiveBasePath: "/archive",
      devMode: true,
      minLeadMs: DEFAULT_MIN_LEAD_MS,
    }).routes) {
      const { access, path } = route.def;
      const reader = access === "public" && path !== "/health" && !path.startsWith("/api/");
      expect(isReaderPath(path.replace(/[{:(].*$/, "x")), `${route.def.method} ${path}`).toBe(
        reader,
      );
    }
  });
});

// The dev routes (token, seed, reset, outbox) exist only where `devMode` holds, so a
// deployed env has none: a 404 by absence, whoever asks, and no entry in the reference.
describe("the dev routes exist only in local development", () => {
  const DEV_ROUTES: [string, string][] = [
    ["POST", "/api/dev/reset"],
    ["POST", "/api/dev/seed"],
    ["GET", "/api/dev/outbox"],
    ["GET", "/api/dev/token"],
  ];

  async function expectAbsent(vars: Record<string, string>): Promise<void> {
    const e = withVars(vars);
    expect(getConfig(e).devMode).toBe(false);
    for (const [method, path] of DEV_ROUTES) {
      const res = await fetchWith(vars, path, { method, headers: AUTH });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const listed = createRouter(getConfig(e)).routes.map((r) => r.def.path);
    expect(listed.some((p) => p.startsWith("/api/dev/"))).toBe(false);
  }

  it("404s with Access configured, even on the fake transport", async () => {
    await expectAbsent({
      PROVIDER: "fake",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "aud-tag",
    });
  });

  it("404s on the fake transport served from a public origin, as a demo is", async () => {
    await expectAbsent({
      PROVIDER: "fake",
      ALLOW_FAKE_PROVIDER: "true",
      APP_ORIGIN: "https://newsletter.birds.example",
    });
  });

  it("404s on a real provider", async () => {
    await expectAbsent(SES_DEPLOY);
  });

  // Defense in depth: a handler reached through a router built for another config (the
  // router cache keyed wrong, say) still refuses outside local dev.
  it("each handler refuses on its own outside local dev", async () => {
    // A known reader, so a reset that ran despite the refusal would show as a missing row.
    await resetDatabase();
    await seedConfirmed("kept@example.com");
    const e = withVars({
      PROVIDER: "fake",
      ALLOW_FAKE_PROVIDER: "true",
      APP_ORIGIN: "https://newsletter.birds.example",
    });
    const context = (path: string, method: string): RequestContext => {
      const req = new Request(`${base}${path}`, { method });
      return {
        req,
        env: e,
        ctx: createExecutionContext(),
        url: new URL(req.url),
        params: {},
        config: getConfig(e),
      } as unknown as RequestContext;
    };
    const handlers: [string, string, (c: RequestContext) => Promise<Response>][] = [
      ["GET", "/api/dev/token", devRoutes.token],
      ["POST", "/api/dev/seed", devRoutes.seed],
      ["POST", "/api/dev/reset", devRoutes.reset],
      ["GET", "/api/dev/outbox", renderRoutes.devOutbox],
    ];
    for (const [method, path, handler] of handlers) {
      await expect(handler(context(path, method)), path).rejects.toMatchObject({ status: 404 });
    }
    // The reset refused before touching anything: the reader seeded above is still there.
    const kept = await env.DB.prepare("SELECT email FROM subscribers").all<{ email: string }>();
    expect(kept.results.map((r) => r.email)).toEqual(["kept@example.com"]);
  });

  // The CLI's seed and reset check this ID against the record `kestrel dev` left in their
  // directory before wiping a database (cli/dev-api.mjs).
  it("reports the run ID kestrel dev gave the server beside the token, and none without one", async () => {
    const withId = await fetchWith({ DEV_RUN_ID: "run-1234" }, "/api/dev/token?kind=service");
    expect(await withId.json()).toMatchObject({ kind: "service", runId: "run-1234" });
    const without = await fetchWith({}, "/api/dev/token");
    expect(await without.json()).not.toHaveProperty("runId");
  });

  it("never resolves a run ID outside local development", () => {
    const deployed = withVars({ ...SES_DEPLOY, DEV_RUN_ID: "run-1234" });
    expect(getConfig(deployed).devRunId).toBeUndefined();
  });

  it("is registered in local development (the suite's own env)", () => {
    expect(getConfig(env as AppEnv).devMode).toBe(true);
    const listed = createRouter(getConfig(env as AppEnv)).routes.map(
      (r) => `${r.def.method} ${r.def.path}`,
    );
    for (const [method, path] of DEV_ROUTES) {
      expect(listed).toContain(`${method} ${path}`);
    }
  });
});

describe("createRouter — archive route follows the base path", () => {
  beforeEach(async () => {
    await resetDatabase();
    clearFakeOutbox();
  });

  async function sendPost(slug: string): Promise<void> {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO subscribers (id, email, status, confirm_token, unsub_token, created_at, confirmed_at) VALUES ('a','a@example.com','confirmed','cfm-a','uns-a',?,?)",
    )
      .bind(now, now)
      .run();
    const { post } = await posts.createPost(env.DB, { subject: slug, markdown: "# hi" }, "test");
    await freeze(env as AppEnv, getConfig(env as AppEnv), post, Date.now() - 1000);
    await sweep(env as AppEnv);
  }

  it("serves the archive at the configured base path, and 404s the default one", async () => {
    await sendPost("routed");
    const post = (await posts.getBySlug(env.DB, "routed"))!;
    // A non-default base path, so a route hard-coded to /archive can't pass for this one.
    const router = createRouter({
      archiveBasePath: "/issues",
      devMode: false,
      minLeadMs: DEFAULT_MIN_LEAD_MS,
    });
    const ctx = createExecutionContext();
    const get = (path: string) => router.handle(new Request(`${base}${path}`), env as AppEnv, ctx);

    const hit = await get(`/issues/${post.slug}`);
    const index = await get("/issues");
    const atDefault = await get(`/archive/${post.slug}`);
    const legacy = await get(`/newsletter/${post.slug}`);
    await waitOnExecutionContext(ctx);

    expect(hit.status).toBe(200);
    expect(await hit.text()).toContain("routed");
    expect(index.status).toBe(200);
    expect(atDefault.status).toBe(404);
    expect(legacy.status).toBe(404); // the hardcoded /newsletter path is gone
  });
});
