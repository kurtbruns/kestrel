import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocFragment } from "../../shared/docs";
import type { SettingsResponse } from "../../shared/settings";
import { appState } from "../state";
import { $, $$, type FakeApi, fakeApi, jsonResponse, resetShell, settle } from "../test/support";
import { renderDocs } from "./docs";

// The guide as the Worker serves it: sanitized fragments with no ids on the headings.
const docs: DocFragment[] = [
  {
    slug: "overview",
    title: "Overview",
    html: "<h1>Overview</h1><p>What a fresh instance needs, in order:</p><ul><li>an account</li></ul><h2>Before you start</h2><p>x</p><h2>What you get</h2><pre><code>npm run dev</code></pre>",
  },
  {
    slug: "provision",
    title: "Provision <the> Worker",
    html: "<h1>Provision the Worker</h1><p>Create the Worker &amp; its database.</p><h2>Steps</h2>",
  },
  { slug: "verify", title: "Verify", html: "<h1>Verify</h1><p>Send a test.</p>" },
];

// Only what the room reads: the build stamp with (or without) a repository to link.
const config = (repoUrl: string): SettingsResponse =>
  ({
    deployment: {
      build: {
        version: "0.2.0",
        sha: "abc1234",
        tag: "",
        buildTime: "2026-09-21T10:00:00Z",
        repoUrl,
        commitUrl: repoUrl ? `${repoUrl}/commit/abc1234` : "",
        tagUrl: "",
      },
    },
  }) as unknown as SettingsResponse;

// The module caches the guide after its first fetch (the bundle never changes at runtime),
// so the tests below share one instance in order: the first fetches, the rest read the
// cache. The two that need a fetch of their own load a fresh instance.
async function freshDocs() {
  vi.resetModules();
  const mod = await import("./docs");
  return mod.renderDocs;
}

describe("docs room", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    location.hash = "#/docs";
    appState.appConfig = config("https://github.com/x/kestrel");
  });
  afterEach(() => {
    fake?.restore();
    document.onscroll = null;
  });

  it("renders the index: the cards in reading order with blurbs from each doc's first paragraph, and the project links in the rail", async () => {
    fake = fakeApi([{ path: "/api/docs", reply: () => ({ docs }) }]);
    await renderDocs();
    await settle();
    expect($(".room-switch [aria-current='page']").textContent).toBe("Docs");
    const cards = $$<HTMLAnchorElement>(".doc-card");
    expect(cards.map((c) => c.getAttribute("href"))).toEqual([
      "#/docs/overview",
      "#/docs/provision",
      "#/docs/verify",
    ]);
    expect($$(".doc-card-n").map((n) => n.textContent)).toEqual(["01", "02", "03"]);
    expect($(".doc-card-t", cards[1]).textContent).toMatch(/^Provision <the> Worker/); // a title is text
    // A first paragraph that leads into a list ends in an ellipsis, not a colon.
    expect($(".doc-card-d", cards[0]).textContent).toBe("What a fresh instance needs, in order…");
    expect($(".doc-card-d", cards[1]).textContent).toBe("Create the Worker & its database.");
    expect($$(".rail-link").map((a) => a.getAttribute("href"))).toEqual([
      "https://getkestrel.dev",
      "https://github.com/x/kestrel",
      "https://github.com/x/kestrel/blob/HEAD/LICENSE",
    ]);
    expect(fake.calls.map((c) => c.url.pathname)).toEqual(["/api/docs"]);
    expect(fake.unhandled).toEqual([]);
  });

  it("links only the project site when the build knows no repository", async () => {
    fake = fakeApi([]);
    appState.appConfig = config("");
    await renderDocs();
    expect($$(".rail-link").map((a) => a.textContent?.trim())).toEqual(["Project siteProject ↗"]);
    expect(fake.calls).toEqual([]); // the guide is cached
  });

  it("opens a doc from the cache: the API's HTML as markup, ids on its headings, On this page in the rail, and the sequential pager", async () => {
    fake = fakeApi([]);
    await renderDocs("overview");
    expect(fake.calls).toEqual([]);
    const main = $("#docsMain");
    expect($("section.doc-part", main).id).toBe("doc-overview");
    expect($("ul li", main).textContent).toBe("an account"); // inserted as markup, not text
    expect($("h1", main).id).toBe("part-overview");
    expect($$("h2", main).map((h) => h.id)).toEqual(["sec-overview-1", "sec-overview-2"]);
    // The H1 shares its row with the compact pager: first doc, so Next only.
    expect($(".doc-head h1", main)).toBeTruthy();
    expect($$(".doc-topnav a", main).map((a) => a.getAttribute("aria-label"))).toEqual([
      "Next: Provision <the> Worker",
    ]);
    expect($(".doc-pager .next .doc-pager-title").textContent).toBe("Provision <the> Worker");
    expect($(".doc-pager").firstElementChild?.tagName).toBe("SPAN"); // no Previous
    expect($$("#tocOnPage .toc-sub").map((a) => a.textContent)).toEqual([
      "Overview",
      "Before you start",
      "What you get",
    ]);
    // The spy ran once: a document with no layout reads as scrolled to the bottom, where
    // the last heading wins so a short final section still highlights.
    expect($("#tocOnPage .toc-sub.on").textContent).toBe("What you get");
    expect($$("pre.has-copy .code-copy", main)).toHaveLength(1);
  });

  it("shows Previous and Next around a middle doc, and jumps within the doc from the rail", async () => {
    fake = fakeApi([]);
    await renderDocs("provision");
    expect($$(".doc-topnav a").map((a) => a.getAttribute("href"))).toEqual([
      "#/docs/overview",
      "#/docs/verify",
    ]);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    $("#tocOnPage .toc-sub[data-target='sec-provision-1']").click();
    expect($("#tocOnPage .toc-sub.on").textContent).toBe("Steps");
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(location.hash).toBe("#/docs"); // the click never navigated
    scroll.mockRestore();
  });

  it("copies a code block", async () => {
    fake = fakeApi([]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await renderDocs("overview");
    $("pre .code-copy").click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("npm run dev");
    expect($("pre .code-copy").textContent).toBe("Copied");
    vi.unstubAllGlobals();
  });

  it("heals an unknown slug to the index", async () => {
    fake = fakeApi([]);
    location.hash = "#/docs/nope";
    await renderDocs("nope");
    expect($("#toasts").textContent).toMatch(/No doc named “nope”/);
    expect($$(".doc-card")).toHaveLength(3);
    expect(location.hash).toBe("#/docs");
  });

  it("shows the error with a retry that fetches again", async () => {
    const render = await freshDocs();
    let failures = 1;
    fake = fakeApi([
      {
        path: "/api/docs",
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : { docs }),
      },
    ]);
    await render("verify");
    expect($(".room-main .error").textContent).toMatch(/down/);
    $("[data-retry]").click();
    await settle();
    expect($("#docsMain h1").textContent).toBe("Verify");
    expect(fake.calls).toHaveLength(2);
  });

  it("does not paint over a view the reader moved on to while the guide was loading, but keeps what it fetched", async () => {
    const render = await freshDocs();
    let release: (v: unknown) => void = () => {};
    fake = fakeApi([
      { path: "/api/docs", reply: () => new Promise((r) => (release = r)).then(() => ({ docs })) },
    ]);
    const pending = render();
    await settle();
    location.hash = "#/reference"; // what a tap on the API tab does mid-flight
    release(null);
    await pending;
    expect($(".room-main").textContent).toMatch(/Loading…/); // untouched
    expect($$(".doc-card")).toHaveLength(0);
    location.hash = "#/docs";
    await render();
    expect($$(".doc-card")).toHaveLength(3);
    expect(fake.calls).toHaveLength(1); // the first fetch filled the cache
  });
});
