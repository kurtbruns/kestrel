// Self-contained-by-default config (SPEC §11): the archive origin and media base
// fall back to the app's own origin, and ARCHIVE_BASE_PATH drives both the emitted
// archive URL and the route registered to serve it.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createRouter } from "../src/app";
import * as posts from "../src/db/posts";
import { type AppEnv, getConfig } from "../src/env";
import { clearFakeOutbox } from "../src/providers/fake";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";

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
  it("is on in a dev-shaped env with the dev secret present", () => {
    const config = getConfig(envWith({ PROVIDER: "fake", DEV_AUTH_SECRET: "s" }));
    expect(config.devMode).toBe(true);
    expect(config.devAuthSecret).toBe("s");
  });

  it("is off without a dev secret — the auto-minted token, and so the link, can't work", () => {
    const config = getConfig(envWith({ PROVIDER: "fake" }));
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
  });

  it("is off once Access is configured, even on the fake transport", () => {
    const config = getConfig(
      envWith({
        PROVIDER: "fake",
        DEV_AUTH_SECRET: "s",
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
      }),
    );
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
  });

  it("is off on a real provider (a deployed env is never dev-shaped)", () => {
    const config = getConfig(envWith({ PROVIDER: "ses", DEV_AUTH_SECRET: "s" }));
    expect(config.devMode).toBe(false);
    expect(config.devAuthSecret).toBeUndefined();
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
    const router = createRouter("/archive");
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
