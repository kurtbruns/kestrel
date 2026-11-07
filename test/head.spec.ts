import { createExecutionContext, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { type Handler, type RouteDef, Router } from "../src/router";
import { frozenSend, resetDatabase, seedConfirmed } from "./support/fixtures";
import { AUTH, base, readJson } from "./support/http";

// A HEAD is answered as the GET for its path, without the body (docs/API.md, Requests): what an
// uptime monitor, a link checker, or `curl -I` sends.

const IMAGE_KEY = "head-spec/cover.png";
const IMAGE_BYTES = new Uint8Array(1234);

/** Ask for a path both ways and hold the HEAD to the GET: its status and every header, with no
 *  body. Returns the HEAD. */
async function expectHeadLikeGet(path: string, headers: HeadersInit = {}): Promise<Response> {
  const get = await SELF.fetch(`${base}${path}`, { headers });
  const head = await SELF.fetch(`${base}${path}`, { method: "HEAD", headers });

  expect(head.status).toBe(get.status);
  expect(head.body).toBeNull();
  expect(Object.fromEntries(head.headers)).toEqual(Object.fromEntries(get.headers));
  return head;
}

const subscriberStatus = async (email: string): Promise<string | null> =>
  env.DB.prepare("SELECT status FROM subscribers WHERE email = ?").bind(email).first("status");

/** A router holding one route at `/x`, and a way to send it a request by method. */
function routerWith(
  method: RouteDef["method"],
  handler: Handler,
): { handle: (m: string) => Promise<Response> } {
  const router = new Router().register({
    method,
    path: "/x",
    access: "public",
    resource: "system",
    title: "A route",
    summary: "A route.",
    handler,
  });
  return {
    handle: (m) =>
      router.handle(
        new Request(`${base}/x`, { method: m }),
        env as unknown as AppEnv,
        createExecutionContext(),
      ),
  };
}

describe("HEAD", () => {
  beforeEach(async () => {
    await resetDatabase();
    await env.MEDIA.put(IMAGE_KEY, IMAGE_BYTES, { httpMetadata: { contentType: "image/png" } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers /health as GET does, so a monitor sees the instance up", async () => {
    const head = await expectHeadLikeGet("/health");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/json");
  });

  it("answers a reader page as GET does", async () => {
    const head = await expectHeadLikeGet("/subscribe");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("answers an image as GET does, stating its size", async () => {
    const head = await expectHeadLikeGet(`/media/${IMAGE_KEY}`);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(head.headers.get("content-length")).toBe(String(IMAGE_BYTES.byteLength));
  });

  it("answers an image that isn't there as GET does", async () => {
    const head = await expectHeadLikeGet("/media/head-spec/none.png");
    expect(head.status).toBe(404);
    expect(head.headers.get("content-length")).toBe(null);
  });

  it("is refused on an admin route without sign-in, showing nothing behind the gate", async () => {
    const head = await expectHeadLikeGet("/api/version");
    expect(head.status).toBe(401);
    expect(head.headers.get("www-authenticate")).toBe('Bearer realm="kestrel"');
    expect(head.headers.get("cache-control")).toBe("no-store");
  });

  it("answers an admin route with sign-in as GET does", async () => {
    const head = await expectHeadLikeGet("/api/version", AUTH);
    expect(head.status).toBe(200);
    expect(head.headers.get("cache-control")).toBe("no-store");
  });

  it("is held to what the route declares, as GET is", async () => {
    const head = await expectHeadLikeGet("/api/posts?nonsense=1", AUTH);
    expect(head.status).toBe(400);
  });

  it("answers 304 as GET does when the client's copy is current", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const send = await frozenSend(Date.now() + 2_000);
    const path = `/api/sends/${send.id}`;
    const etag = (await SELF.fetch(`${base}${path}`, { headers: AUTH })).headers.get("etag") ?? "";

    const head = await expectHeadLikeGet(path, { ...AUTH, "if-none-match": etag });

    expect(head.status).toBe(304);
    expect(head.headers.get("etag")).toBe(etag);
    expect(head.headers.get("content-length")).toBe(null);
  });

  it("answers a path with no route as GET does", async () => {
    const head = await expectHeadLikeGet("/nope");
    expect(head.status).toBe(404);
  });

  it("answers a page's address with a trailing slash as GET does", async () => {
    const head = await expectHeadLikeGet("/subscribe/", { accept: "text/html" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("answers a browser's path with no route as GET does, with the reader's page (SPEC §5)", async () => {
    const head = await expectHeadLikeGet("/nope", { accept: "text/html" });
    expect(head.status).toBe(404);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("answers a path under /api with no route as GET does, with JSON", async () => {
    const head = await expectHeadLikeGet("/api/nope", { accept: "text/html" });
    expect(head.status).toBe(404);
    expect(head.headers.get("content-type")).toBe("application/json");
  });

  it("doesn't run a route that only takes a POST", async () => {
    await seedConfirmed("reader@example.com");

    const head = await SELF.fetch(`${base}/api/subscribers/id-reader@example.com/unsubscribe`, {
      method: "HEAD",
      headers: AUTH,
    });

    expect(head.status).toBe(404);
    expect(await subscriberStatus("reader@example.com")).toBe("confirmed");
  });

  it("opens an unsubscribe link without unsubscribing anyone (SPEC §7)", async () => {
    await seedConfirmed("reader@example.com");

    const head = await expectHeadLikeGet("/unsubscribe?token=uns-reader@example.com");

    expect(head.status).toBe(200);
    expect(await subscriberStatus("reader@example.com")).toBe("confirmed");
  });

  it("opens a confirmation link without confirming anyone (I1, SPEC §7)", async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO subscribers (id, email, status, confirm_token, confirm_sent_at, unsub_token, created_at)
       VALUES ('id-p', 'pending@example.com', 'pending', 'cfm-p', ?, 'uns-p', ?)`,
    )
      .bind(now, now)
      .run();

    const head = await expectHeadLikeGet("/confirm?token=cfm-p");

    expect(head.status).toBe(200);
    expect(await subscriberStatus("pending@example.com")).toBe("pending");
  });

  it("reaches the handler as the HEAD it was, for whatever reads or logs it", async () => {
    let seen = "";
    const { handle } = routerWith("GET", (c) => {
      seen = c.req.method;
      return new Response("hello");
    });

    const head = await handle("HEAD");

    expect(seen).toBe("HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
  });

  it("never reads the GET's body, so a large or endless one costs it nothing", async () => {
    let pulled = 0;
    let canceled = false;
    // Finite only so that a HEAD reading it fails these assertions rather than hanging the run.
    const stream = new ReadableStream(
      {
        pull(controller) {
          pulled += 1;
          if (pulled === 3) {
            controller.close();
          } else {
            controller.enqueue(new Uint8Array(1024));
          }
        },
        cancel() {
          canceled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const { handle } = routerWith("GET", () => new Response(stream));

    const head = await handle("HEAD");

    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe(null);
    expect(pulled).toBe(0);
    expect(canceled).toBe(true);
  });

  it("keeps a redirect's address", async () => {
    const { handle } = routerWith("GET", () => Response.redirect(`${base}/elsewhere`, 302));

    const head = await handle("HEAD");

    expect(head.status).toBe(302);
    expect(head.headers.get("location")).toBe(`${base}/elsewhere`);
  });

  it("leaves another method's answer and body as they are", async () => {
    const { handle } = routerWith("POST", () => new Response("posted"));

    expect(await (await handle("POST")).text()).toBe("posted");
    expect((await handle("HEAD")).status).toBe(404);
    expect((await readJson(await handle("GET"))).error).toBe("not_found");
  });
});
