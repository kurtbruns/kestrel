// Self-contained-by-default config (SPEC §11): the archive origin and media base
// fall back to the app's own origin, and ARCHIVE_BASE_PATH drives both the emitted
// archive URL and the route registered to serve it.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter } from "../src/app";
import * as posts from "../src/db/posts";
import { type AppEnv, ConfigError, getConfig } from "../src/env";
import worker from "../src/index";
import { clearFakeOutbox } from "../src/providers/fake";
import type { RequestContext } from "../src/router";
import * as devRoutes from "../src/routes/dev";
import * as renderRoutes from "../src/routes/render_actions";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { adminAuth } from "./support/auth";
import { RESEND_DEPLOY, SES_DEPLOY } from "./support/deploy";

/** Minimal binding bag for the pure getConfig tests (no D1/R2 needed). */
function envWith(overrides: Record<string, string | undefined>): AppEnv {
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
    const config = getConfig(envWith({}));
    expect(config.archiveOrigin).toBe("https://app.example");
    expect(config.mediaPublicBase).toBe("https://app.example/media");
    expect(config.archiveBasePath).toBe("/archive");
  });

  it("uses explicit overrides when set (the apex / media-domain opt-in)", () => {
    const config = getConfig(
      envWith({
        ARCHIVE_ORIGIN: "https://example.com",
        MEDIA_PUBLIC_BASE: "https://media.example.com",
        ARCHIVE_BASE_PATH: "/archive",
      }),
    );
    expect(config.archiveOrigin).toBe("https://example.com");
    expect(config.mediaPublicBase).toBe("https://media.example.com");
    expect(config.archiveBasePath).toBe("/archive");
  });

  it("normalizes the base path (leading slash, no trailing slash) and defaults when empty", () => {
    expect(getConfig(envWith({ ARCHIVE_BASE_PATH: "issues" })).archiveBasePath).toBe("/issues");
    expect(getConfig(envWith({ ARCHIVE_BASE_PATH: "/issues/" })).archiveBasePath).toBe("/issues");
    expect(getConfig(envWith({ ARCHIVE_BASE_PATH: "" })).archiveBasePath).toBe("/archive");
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
      envWith({ PROVIDER: "fake", DEV_AUTH_SECRET: "s", APP_ORIGIN: LOCAL }),
    );
    expect(config.devMode).toBe(true);
    expect(config.devAuthSecret).toBe("s");
  });

  it("is off without a dev secret — the auto-minted token, and so the link, can't work", () => {
    const config = getConfig(envWith({ PROVIDER: "fake", APP_ORIGIN: LOCAL }));
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
  });

  it("is off once Access is configured, even on the fake transport", () => {
    const config = getConfig(
      envWith({
        PROVIDER: "fake",
        DEV_AUTH_SECRET: "s",
        APP_ORIGIN: LOCAL,
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      }),
    );
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
  });

  it("is off on a real provider (a deployed env is never dev-shaped)", () => {
    const config = getConfig(envWith({ ...SES_DEPLOY, DEV_AUTH_SECRET: "s", APP_ORIGIN: LOCAL }));
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
  });

  it("is off on the fake transport served from anywhere but this machine", () => {
    const config = getConfig(envWith({ PROVIDER: "fake", DEV_AUTH_SECRET: "s" }));
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
      getConfig(envWith(overrides));
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

  it("defaults an unset PROVIDER to the fake", () => {
    expect(getConfig(envWith({ PROVIDER: undefined })).provider).toBe("fake");
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
      envWith({
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
    expect(getConfig(envWith({ ...SES_DEPLOY })).provider).toBe("ses");
    expect(getConfig(envWith({ ...RESEND_DEPLOY })).provider).toBe("resend");
  });

  it("refuses the template's example.com placeholders with a real provider", () => {
    refuses({ ...SES_DEPLOY, APP_ORIGIN: "https://newsletter.example.com" }, "APP_ORIGIN");
    refuses({ ...SES_DEPLOY, ARCHIVE_ORIGIN: "https://example.com" }, "ARCHIVE_ORIGIN");
    refuses(
      { ...RESEND_DEPLOY, MEDIA_PUBLIC_BASE: "https://media.example.com" },
      "MEDIA_PUBLIC_BASE",
    );
    refuses(
      { ...SES_DEPLOY, FROM_ADDRESS: "Newsletter <newsletter@send.example.com>" },
      "FROM_ADDRESS",
    );
    refuses({ ...SES_DEPLOY, SENDING_DOMAIN: "send.example.com" }, "SENDING_DOMAIN");
    refuses({ ...SES_DEPLOY, FROM_ADDRESS: "no address here" }, "FROM_ADDRESS");
    refuses({ ...SES_DEPLOY, SENDING_DOMAIN: " send.example.com " }, "SENDING_DOMAIN");
  });

  it("takes the From address from the last angle brackets, not a bracketed display name", () => {
    const from = '"Birds <weekly>" <news@send.birds.example>';
    expect(getConfig(envWith({ ...SES_DEPLOY, FROM_ADDRESS: from })).fromAddress).toBe(from);
  });

  it("never echoes a URL's credentials in the error, which is a public 500", () => {
    let message = "";
    try {
      getConfig(envWith({ MEDIA_PUBLIC_BASE: "https://user:s3cret@cdn.birds.example/media" }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^MEDIA_PUBLIC_BASE /);
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("user:");
  });

  it("leaves the placeholders alone on the fake transport, which mails no one", () => {
    const config = getConfig(
      envWith({
        PROVIDER: "fake",
        APP_ORIGIN: "https://newsletter.example.com",
        FROM_ADDRESS: "Newsletter <newsletter@send.example.com>",
      }),
    );
    expect(config.provider).toBe("fake");
  });

  it("answers every request with a 500 that names the variable", async () => {
    const broken = { ...env, PROVIDER: "SES" } as unknown as AppEnv;
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://k.test/health") as Request<unknown, IncomingRequestCfProperties>,
      broken,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "invalid_config", variable: "PROVIDER" });
  });
});

// The dev routes (token, seed, reset, outbox) exist only where `devMode` holds, so a
// deployed env has none: a 404 by absence, whoever asks, and no entry in the reference.
describe("the dev routes exist only in local development", () => {
  async function fetchWith(e: AppEnv, path: string, init?: RequestInit): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://k.test${path}`, init) as Request<unknown, IncomingRequestCfProperties>,
      e,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  const DEV_ROUTES: [string, string][] = [
    ["POST", "/api/dev/reset"],
    ["POST", "/api/dev/seed"],
    ["GET", "/api/dev/outbox"],
    ["GET", "/api/dev/token"],
  ];

  async function expectAbsent(e: AppEnv): Promise<void> {
    expect(getConfig(e).devMode).toBe(false);
    const headers = await adminAuth();
    for (const [method, path] of DEV_ROUTES) {
      const res = await fetchWith(e, path, { method, headers });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const listed = createRouter(getConfig(e)).routes.map((r) => r.def.path);
    expect(listed.some((p) => p.startsWith("/api/dev/"))).toBe(false);
  }

  it("404s with Access configured, even on the fake transport", async () => {
    await expectAbsent({
      ...env,
      PROVIDER: "fake",
      ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      ACCESS_AUD: "aud-tag",
    } as unknown as AppEnv);
  });

  it("404s on the fake transport served from a public origin", async () => {
    await expectAbsent({
      ...env,
      PROVIDER: "fake",
      APP_ORIGIN: "https://newsletter.birds.example",
    } as unknown as AppEnv);
  });

  it("404s on a real provider", async () => {
    await expectAbsent({ ...env, ...SES_DEPLOY } as unknown as AppEnv);
  });

  // Defense in depth: a handler reached through a router built for another config (the
  // router cache keyed wrong, say) still refuses outside local dev.
  it("each handler refuses on its own outside local dev", async () => {
    const e = {
      ...env,
      PROVIDER: "fake",
      APP_ORIGIN: "https://newsletter.birds.example",
    } as unknown as AppEnv;
    const context = (path: string, method: string): RequestContext => {
      const req = new Request(`https://k.test${path}`, { method });
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
    // The reset refused before touching anything: the suite's own database still answers.
    expect(await env.DB.prepare("SELECT 1 AS ok").first()).toEqual({ ok: 1 });
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
    await env.DB.batch([
      env.DB.prepare("DELETE FROM deliveries"),
      env.DB.prepare("DELETE FROM notifications"),
      env.DB.prepare("DELETE FROM sends"),
      env.DB.prepare("DELETE FROM post_revisions"),
      env.DB.prepare("DELETE FROM posts"),
      env.DB.prepare("DELETE FROM subscribers"),
    ]);
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

  it("serves the archive at the configured base path, and 404s the old one", async () => {
    await sendPost("routed");
    const post = (await posts.getBySlug(env.DB, "routed"))!;
    const router = createRouter({ archiveBasePath: "/archive", devMode: false });
    const ctx = createExecutionContext();

    const hit = await router.handle(
      new Request(`https://k.test/archive/${post.slug}`),
      env as AppEnv,
      ctx,
    );
    const miss = await router.handle(
      new Request(`https://k.test/newsletter/${post.slug}`),
      env as AppEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(hit.status).toBe(200);
    expect(miss.status).toBe(404); // the hardcoded /newsletter path is gone
  });
});
