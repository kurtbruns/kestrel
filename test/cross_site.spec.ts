// A page on another site can't make the publisher's browser act on the admin API (SPEC §11):
// an admin write marked cross-site by the browser is refused (by Sec-Fetch-Site, or by
// Origin from a browser too old to send it), and so is a body whose type the route doesn't
// declare, which is all a plain HTML form can send. Reads, public routes, and webhooks are
// untouched, and so is a client that isn't a browser (neither header).
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createRouter } from "../src/app";
import { type AppEnv, getConfig } from "../src/env";
import { adminAuth } from "./support/auth";

const AUTH = await adminAuth();
const base = "https://kestrel.test";
const readJson = async (r: Response): Promise<any> => r.json();

const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (ch) => ch.charCodeAt(0),
);

function post(path: string, init: { headers?: Record<string, string>; body?: BodyInit }) {
  return SELF.fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...AUTH, ...init.headers },
    body: init.body,
  });
}

function addSubscriber(email: string, headers: Record<string, string> = {}) {
  return post("/subscribers", {
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email }),
  });
}

async function newDraft(): Promise<string> {
  const res = await post("/posts", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: "Cross-site" }),
  });
  return (await readJson(res)).post.id;
}

function uploadImage(id: string, headers: Record<string, string> = {}) {
  const fd = new FormData();
  fd.append("file", new File([PNG_1x1], "dot.png", { type: "image/png" }));
  return post(`/posts/${id}/images`, { headers, body: fd });
}

async function subscriberCount(): Promise<number> {
  const res = await SELF.fetch(`${base}/subscribers`, { headers: AUTH });
  return (await readJson(res)).total;
}

describe("Sec-Fetch-Site on an admin write", () => {
  it("refuses same-site and cross-site on a JSON route, and writes nothing", async () => {
    const before = await subscriberCount();
    for (const site of ["same-site", "cross-site"]) {
      const res = await addSubscriber(`xs-${site}@example.com`, { "sec-fetch-site": site });
      expect(res.status, site).toBe(403);
      expect((await readJson(res)).error).toBe("cross_site_request");
    }
    expect(await subscriberCount()).toBe(before);
  });

  it("refuses same-site and cross-site on an upload route", async () => {
    const id = await newDraft();
    for (const site of ["same-site", "cross-site"]) {
      const res = await uploadImage(id, { "sec-fetch-site": site });
      expect(res.status, site).toBe(403);
    }
    const list = await readJson(await SELF.fetch(`${base}/posts/${id}/images`, { headers: AUTH }));
    expect(list.images).toEqual([]);
  });

  it("allows same-origin, none, and an absent header", async () => {
    const id = await newDraft();
    for (const site of ["same-origin", "none", null]) {
      const headers: Record<string, string> = site ? { "sec-fetch-site": site } : {};
      const added = await addSubscriber(`ok-${site}@example.com`, headers);
      expect(added.status, String(site)).toBe(201);
      const fd = new FormData();
      fd.append("file", new File([PNG_1x1], `dot-${site}.png`, { type: "image/png" }));
      const up = await post(`/posts/${id}/images`, { headers, body: fd });
      expect(up.status, String(site)).toBe(201);
    }
  });

  it("falls back to Origin when a browser sends no Sec-Fetch-Site", async () => {
    const before = await subscriberCount();
    // An older browser's no-cors POST from a sibling subdomain: no body, no type, but an Origin.
    for (const origin of ["https://blog.kestrel.test", "https://evil.example", "null"]) {
      const send = await post("/posts/p_missing/send", { headers: { origin } });
      expect(send.status, origin).toBe(403);
      expect((await readJson(send)).error).toBe("cross_site_request");
      const added = await addSubscriber("origin@example.com", { origin });
      expect(added.status, origin).toBe(403);
    }
    expect(await subscriberCount()).toBe(before);
    // The request's own origin, and no Origin at all, pass.
    expect((await addSubscriber("own-origin@example.com", { origin: base })).status).toBe(201);
    expect((await addSubscriber("no-origin@example.com")).status).toBe(201);
  });

  it("lets Sec-Fetch-Site decide when a browser sends both", async () => {
    const res = await addSubscriber("both@example.com", {
      "sec-fetch-site": "same-origin",
      origin: base,
    });
    expect(res.status).toBe(201);
    const foreign = await addSubscriber("both-foreign@example.com", {
      "sec-fetch-site": "same-site",
      origin: base,
    });
    expect(foreign.status).toBe(403);
  });

  it("leaves reads alone: a cross-site GET is answered", async () => {
    const res = await SELF.fetch(`${base}/posts`, {
      headers: { ...AUTH, "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(200);
  });

  it("answers an unauthenticated cross-site write with the gate's 401", async () => {
    const res = await SELF.fetch(`${base}/subscribers`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ email: "anon@example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("guards every admin write in the manifest, so no route can forget it", async () => {
    const router = createRouter(getConfig(env as AppEnv));
    const writes = router.routes.filter((r) => r.def.access === "admin" && r.def.method !== "GET");
    expect(writes.length).toBeGreaterThan(10);
    for (const { def } of writes) {
      const path = def.path.replace(/:[A-Za-z_]+/g, "x");
      const res = await SELF.fetch(`${base}${path}`, {
        method: def.method,
        headers: { ...AUTH, "sec-fetch-site": "cross-site" },
      });
      expect(res.status, `${def.method} ${def.path}`).toBe(403);
    }
  });
});

describe("each admin route takes only the body types it declares", () => {
  it("refuses a text/plain form's JSON-shaped body and a form-encoded body to a JSON route", async () => {
    const before = await subscriberCount();
    // What `<form enctype="text/plain">` with a field named `{"email":"` makes of its value.
    const plain = await post("/subscribers", {
      headers: { "content-type": "text/plain" },
      body: '{"email":"=plain@example.com"}',
    });
    expect(plain.status).toBe(415);
    expect((await readJson(plain)).error).toBe("unsupported_media_type");
    const form = await post("/subscribers", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "form@example.com" }).toString(),
    });
    expect(form.status).toBe(415);
    // A client that declares no type can't have its body read as JSON either.
    const untyped = await post("/subscribers", { body: '{"email":"untyped@example.com"}' });
    expect(untyped.status).toBe(415);
    expect(await subscriberCount()).toBe(before);
  });

  it("refuses a form body on a route that takes none", async () => {
    const res = await post("/sends/s_missing/cancel", {
      headers: { "content-type": "text/plain" },
      body: "",
    });
    expect(res.status).toBe(415);
    // With no body type it reaches the route, which answers for the missing send.
    expect((await post("/sends/s_missing/cancel", {})).status).toBe(404);
  });

  it("refuses an upload whose type the route doesn't take", async () => {
    const id = await newDraft();
    const text = await post(`/posts/${id}/images?filename=a.png`, {
      headers: { "content-type": "text/plain" },
      body: PNG_1x1,
    });
    expect(text.status).toBe(415);
    // The logo takes a multipart form only, never a raw image.
    const logo = await post("/api/settings/logo", {
      headers: { "content-type": "image/png" },
      body: PNG_1x1,
    });
    expect(logo.status).toBe(415);
    // A multipart form to a JSON route is refused the same way.
    const fd = new FormData();
    fd.append("email", "multi@example.com");
    expect((await post("/subscribers", { body: fd })).status).toBe(415);
  });

  it("takes an empty body with no type on the routes whose body is optional", async () => {
    expect((await post("/posts", {})).status).toBe(201);
  });

  it("shows each route's accepted types in the API reference", async () => {
    const ref = await readJson(await SELF.fetch(`${base}/api/reference`, { headers: AUTH }));
    const routes = ref.groups.flatMap((g: any) => g.routes);
    const find = (method: string, path: string) =>
      routes.find((r: any) => r.method === method && r.path === path);
    expect(find("POST", "/subscribers").accepts).toEqual(["application/json"]);
    expect(find("POST", "/posts/:id/images").accepts).toContain("multipart/form-data");
    expect(find("POST", "/posts/:id/images").accepts).toContain("image/png");
    expect(find("POST", "/sends/:id/cancel").accepts).toBeUndefined();
  });
});

describe("public and webhook routes are outside these checks", () => {
  it("the public subscribe form still posts from an embed on another site", async () => {
    const res = await SELF.fetch(`${base}/subscribe`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "cross-site",
        origin: "https://example.com",
      },
      body: new URLSearchParams({ email: "embed@example.com" }).toString(),
    });
    expect(res.status).toBe(200);
  });

  it("a webhook is answered by its adapter, not refused as cross-site", async () => {
    const res = await SELF.fetch(`${base}/webhooks/resend`, {
      method: "POST",
      headers: { "content-type": "text/plain", "sec-fetch-site": "cross-site" },
      body: "{}",
    });
    expect([403, 415]).not.toContain(res.status);
  });
});
