import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MIN_LEAD_MS } from "../shared/sends";
import { createRouter } from "../src/app";
import { updateSettings } from "../src/db/settings";
import { docMarkdown } from "../src/docs";
import { CONNECT_CLAUDE_URL, llmsText, SIGN_IN_URL } from "../src/routes/llms";
import { NOT_CONNECTED_DEPLOY } from "./support/deploy";
import { resetDatabase } from "./support/fixtures";
import { AUTH, base } from "./support/http";
import { fetchWith } from "./support/worker_env";

// `/llms.txt` tells an agent with no credential what the instance is and where to start
// (SPEC §11). It's generated from the registered routes, so these hold every path it names
// against them: a renamed route, or one moved across the access line, fails here.

const APP = "https://newsletter.example.com";

function defs(devMode: boolean) {
  return createRouter({
    archiveBasePath: "/notes",
    devMode,
    minLeadMs: DEFAULT_MIN_LEAD_MS,
  }).routes.map((r) => r.def);
}

function text(name: string, devMode = false): string {
  return llmsText({
    name,
    defs: defs(devMode),
    appOrigin: APP,
    archiveOrigin: "https://example.com",
    archiveBasePath: "/notes",
  });
}

/** Each link's URL under the `##` section that lists it. */
function linksBySection(body: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let section = "";
  for (const row of body.split("\n")) {
    if (row.startsWith("## ")) {
      section = row.slice(3);
      out.set(section, []);
    }
    for (const m of row.matchAll(/\]\((\S+?)\)/g)) {
      out.get(section)?.push(m[1]!);
    }
  }
  return out;
}

/** The registered GET route a URL's path reaches, as the router matches it. */
function routeAt(url: string, devMode: boolean) {
  const { pathname } = new URL(url);
  return defs(devMode).find(
    (d) => d.method === "GET" && new URLPattern({ pathname: d.path }).test({ pathname }),
  );
}

describe("/llms.txt from the route manifest", () => {
  it("lists under Public only public routes, and under Access only admin ones", () => {
    for (const devMode of [false, true]) {
      const sections = linksBySection(text("Marsh Lane", devMode));
      const pub = sections.get("Public")!;
      const gated = sections.get("Behind Cloudflare Access")!;
      expect(pub.length).toBeGreaterThan(0);
      expect(gated.length).toBeGreaterThan(0);
      for (const url of pub) {
        expect(routeAt(url, devMode)?.access, url).toBe("public");
      }
      for (const url of gated) {
        expect(routeAt(url, devMode)?.access, url).toBe("admin");
        expect(url.startsWith(`${APP}/api/`), url).toBe(true);
      }
    }
  });

  it("names the archive at its own origin and base path, and the rest at the app's", () => {
    const pub = linksBySection(text("Marsh Lane")).get("Public")!;
    expect(pub).toEqual(["https://example.com/notes", `${APP}/subscribe`]);
  });

  it("names a docs index only by a name the docs route serves", () => {
    const gated = linksBySection(text("Marsh Lane")).get("Behind Cloudflare Access")!;
    const docs = gated.filter((u) => u.includes("/api/docs/"));
    expect(docs.map((u) => new URL(u).pathname)).toEqual([
      "/api/docs/publishing.md",
      "/api/docs/self-hosting.md",
    ]);
    for (const url of docs) {
      const name = new URL(url).pathname.replace(/^\/api\/docs\/|\.md$/g, "");
      expect(docMarkdown(name), url).not.toBeNull();
    }
  });

  it("points an agent at signing in as a person first, and a service token for a script (SPEC §11)", () => {
    expect(linksBySection(text("Marsh Lane")).get("Signing in")).toEqual([
      SIGN_IN_URL,
      CONNECT_CLAUDE_URL,
    ]);
  });

  it("names the publication in its H1, and words itself whole without a name", () => {
    expect(text("Marsh Lane").split("\n")[0]).toBe("# Marsh Lane");
    expect(text("Marsh\nLane ").split("\n")[0]).toBe("# Marsh Lane");
    const nameless = text("");
    expect(nameless.split("\n")[0]).toBe("# Newsletter");
    expect(nameless).toMatch(/^> A newsletter published with Kestrel\./m);
  });
});

describe("GET /llms.txt", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("answers with no credential, as plain text naming the publication", async () => {
    await updateSettings(env.DB, { publication: { name: "Marsh Lane" } });
    const res = await SELF.fetch(`${base}/llms.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect((await res.text()).split("\n")[0]).toBe("# Marsh Lane");
  });

  it("falls back to the sender's display name, as every reader page does", async () => {
    // A sender named unlike the no-name heading ("Newsletter"), so the fallback is what's read.
    const res = await fetchWith(NOT_CONNECTED_DEPLOY, "/llms.txt");
    expect((await res.text()).split("\n")[0]).toBe("# Birds");
  });

  it("names paths that answer: public ones openly, gated ones only signed in", async () => {
    const sections = linksBySection(await (await SELF.fetch(`${base}/llms.txt`)).text());
    const path = (url: string) => {
      const u = new URL(url);
      return `${base}${u.pathname}`;
    };
    for (const url of sections.get("Public")!) {
      expect((await SELF.fetch(path(url))).status, url).toBe(200);
    }
    for (const url of sections.get("Behind Cloudflare Access")!) {
      expect((await SELF.fetch(path(url))).status, url).toBe(401);
      expect((await SELF.fetch(path(url), { headers: AUTH })).status, url).toBe(200);
    }
  });
});
