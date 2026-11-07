import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { UNLISTED_PATH } from "../shared/archive_url";
import { createRouter } from "../src/app";
import * as posts from "../src/db/posts";
import type { AppEnv } from "../src/env";
import { getConfig } from "../src/env";
import { freeze } from "../src/send/schedule";
import { sweep } from "../src/send/sweep";
import { SES_DEPLOY } from "./support/deploy";
import { resetDatabase, seedConfirmed, sendingWorks } from "./support/fixtures";
import { base, readJson } from "./support/http";
import { allowErrorLogs } from "./support/log";
import { fetchWith } from "./support/worker_env";

// A public address that names no page, or a public page's address with a trailing slash, as a
// reader's browser reaches them (SPEC §5).

/** What a browser sends for a page it navigates to. */
const BROWSER = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
};

/** An archive address, where what's missing is a post that may be on its way. */
const NOTHING_HERE = "Nothing here yet";
/** Anywhere else, where nothing says what the reader was after. */
const NO_PAGE = "There’s no page at this address.";

const open = (path: string, headers: HeadersInit = BROWSER, init: RequestInit = {}) =>
  SELF.fetch(`${base}${path}`, { redirect: "manual", headers, ...init });

async function publish(subject: string): Promise<posts.PostRow> {
  await seedConfirmed("reader@example.com");
  const { post } = await posts.createPost(env.DB, { subject, markdown: `# ${subject}` }, "test");
  await freeze(env, getConfig(env), post, Date.now() - 1000);
  await sweep(env);
  return post;
}

beforeEach(async () => {
  await resetDatabase();
  await sendingWorks();
});

describe("a public page's address with a trailing slash (SPEC §5)", () => {
  it.each([
    ["the subscribe page", "/subscribe", ""],
    ["the unsubscribe page", "/unsubscribe", "?test=1"],
    ["the archive index", "/archive", ""],
    ["the description for agents", "/llms.txt", ""],
  ])("serves %s as its address without one", async (_name, path, query) => {
    const bare = await open(`${path}${query}`);
    const slashed = await open(`${path}/${query}`);

    expect(bare.status).toBe(200);
    expect(slashed.status).toBe(200);
    expect(await slashed.text()).toBe(await bare.text());
  });

  it("serves the confirm page as its address without one, its bad link included", async () => {
    const bare = await open("/confirm?token=none");
    const slashed = await open("/confirm/?token=none");

    expect(bare.status).toBe(400);
    expect(slashed.status).toBe(400);
    expect(await slashed.text()).toBe(await bare.text());
  });

  it("serves a post's page as its address without one", async () => {
    const post = await publish("A Post");

    const bare = await open(`/archive/${post.slug}`);
    const slashed = await open(`/archive/${post.slug}/`);

    expect(bare.status).toBe(200);
    expect(slashed.status).toBe(200);
    expect(await slashed.text()).toBe(await bare.text());
  });

  it("forwards a post's unlisted link as its address without one", async () => {
    const post = await publish("A Post");

    const bare = await open(`${UNLISTED_PATH}/${post.unlisted_token}`);
    const slashed = await open(`${UNLISTED_PATH}/${post.unlisted_token}/`);

    expect(bare.status).toBe(302);
    expect(slashed.status).toBe(302);
    expect(slashed.headers.get("location")).toBe(bare.headers.get("location"));
  });

  it.each([
    ["/subscribe/", "email=new@example.com", 200, "Check your inbox"],
    ["/confirm/", "token=none", 400, "This link is invalid"],
    ["/unsubscribe/?test=1", "", 200, "You’re unsubscribed"],
  ])("takes a form posted to %s", async (path, body, status, words) => {
    const res = await open(
      path,
      { ...BROWSER, "content-type": "application/x-www-form-urlencoded" },
      { method: "POST", body },
    );

    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain(words);
  });
});

describe("a public address that names no page, opened in a browser (SPEC §5)", () => {
  it.each([["/archive/nope"], ["/archive/nope/"], ["/email/nope"], ["/email/nope/"]])(
    "%s keeps the archive's page, with a 404",
    async (path) => {
      const res = await open(path);

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain(NOTHING_HERE);
    },
  );

  it.each([
    ["/email"],
    ["/email/"],
    ["/nope"],
    ["/nope/"],
    ["/p/x"],
    ["/p/x/"],
    ["/subscribe/nope"],
    ["/health/"],
    ["/dashboard/nope"],
  ])("%s answers the reader's page with a 404", async (path) => {
    const res = await open(path);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain(NO_PAGE);
  });

  it("promises a post only at an archive address, and offers the same way onward at both", async () => {
    const archive = await open("/archive/nope");
    const other = await open("/subscribe/nope");
    const archiveBody = await archive.text();
    const otherBody = await other.text();

    expect(archiveBody).toContain("A post appears here as soon as it’s sent.");
    expect(archiveBody).not.toContain(NO_PAGE);
    expect(otherBody).toContain(NO_PAGE);
    expect(otherBody).not.toContain(NOTHING_HERE);
    expect(otherBody).not.toContain("A post appears here");

    const links = (page: string) => page.match(/<a [^>]*href="[^"]*"/g) ?? [];
    expect(links(otherBody)).toEqual(links(archiveBody));
    expect(links(otherBody).length).toBeGreaterThan(0);
    expect(Object.fromEntries(other.headers)).toEqual(Object.fromEntries(archive.headers));
  });

  it("is never kept by a cache or offered to search engines", async () => {
    const res = await open("/nope");

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("wears the publication's own name", async () => {
    const res = await fetchWith({ FROM_ADDRESS: "Birds Weekly <news@birds.example>" }, "/nope", {
      headers: BROWSER,
    });

    expect(await res.text()).toContain("Birds Weekly");
  });

  it("sends no reader into a gated path, deployed (SPEC §11)", async () => {
    const res = await fetchWith(SES_DEPLOY, "/nope", { headers: BROWSER, redirect: "manual" });
    const body = await res.text();

    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBe(null);
    expect(body).toContain(NO_PAGE);
    expect(body).not.toContain("/dashboard");
    expect(body).not.toContain("/api");
  });

  it("answers an image's address that names nothing the same way", async () => {
    for (const path of ["/media/none.png", "/media/"]) {
      const res = await open(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain(NO_PAGE);
    }
  });

  it("answers an address that can't be read the same way, not a refusal", async () => {
    for (const path of ["/archive/%E0", `${UNLISTED_PATH}/%E0`]) {
      const res = await open(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain(NO_PAGE);
    }
  });

  it("shows the plain error page when the page itself fails, never the JSON (SPEC §5)", async () => {
    allowErrorLogs("request.error");
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw new Error("D1_ERROR: database unavailable");
        },
      },
    } as unknown as AppEnv;

    const res = await createRouter(getConfig(env as AppEnv)).handle(
      new Request(`${base}/nope`, { headers: BROWSER }),
      broken,
      createExecutionContext(),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("Something went wrong");
  });
});

describe("what keeps its JSON (docs/API.md)", () => {
  it.each([["/api/nope"], ["/api/nope/"], ["/api/"], ["/api"], ["/webhooks/nope"]])(
    "%s, even asked for by a browser",
    async (path) => {
      const res = await open(path);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    },
  );

  it.each([
    ["no Accept", {}],
    ["anything", { accept: "*/*" }],
    ["JSON", { accept: "application/json" }],
  ])("a public address asked for with %s", async (_name, headers) => {
    for (const path of ["/nope", "/nope/", "/p/x", "/email/"]) {
      const res = await open(path, headers);

      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "not_found" });
    }
  });

  it("an image's address that names nothing, loaded as an image", async () => {
    const res = await open("/media/none.png", { accept: "image/avif,image/webp,*/*;q=0.8" });

    expect(res.status).toBe(404);
    expect((await readJson(res)).error).toBe("not_found");
  });

  it("an address that can't be read, unless it asks for a page", async () => {
    const res = await open("/archive/%E0", {});

    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("bad_request");
  });
});
