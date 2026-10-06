import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocFragment, DocsResponse } from "../../shared/docs";
import type { SettingsResponse } from "../../shared/settings";
import { appState } from "../state";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
  unmount,
} from "../test/support";
import { headingAnchor, renderDocs } from "./docs";

// The guide as the Worker serves it: sanitized fragments with no ids on the headings, three
// steps of the main path and one reference page after them.
const docs: DocFragment[] = [
  {
    slug: "overview",
    title: "Overview",
    section: "get-started",
    html: "<h1>Overview</h1><p>What a fresh instance needs, in order:</p><ul><li>an account</li></ul><h2>Before you start</h2><p>x</p><h2>What you get</h2><pre><code>npm run dev</code></pre>",
  },
  {
    slug: "provision",
    title: "Provision <the> Worker",
    section: "get-started",
    html: "<h1>Provision the Worker</h1><p>Create the Worker &amp; its database.</p><h2>Steps</h2>",
  },
  {
    slug: "verify",
    title: "Verify",
    section: "get-started",
    html: "<h1>Verify</h1><p>Send a test.</p>",
  },
  {
    slug: "configuration",
    title: "Configuration",
    section: "reference",
    html: "<h1>Configuration</h1><p>Every setting.</p>",
  },
];

// The landing as the Worker reads it from docs/README.md: the main path numbered, a
// section with no docs in this fixture, and the reference.
const guide: DocsResponse = {
  landing: {
    title: "Set up <and> run",
    intro: '<p>Start with the <a href="#/docs/overview">Overview</a>.</p>',
    sections: [
      { id: "get-started", title: "Get started", blurb: "<p>In order.</p>", numbered: true },
      { id: "guides", title: "More guides", blurb: "<p>Pick one.</p>", numbered: false },
      { id: "reference", title: "Reference", blurb: "", numbered: false },
    ],
  },
  docs,
};

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
  return (slug?: string) => mount((r, s) => mod.renderDocs(slug, r, s));
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

  it("renders the index the landing lays out: its title and intro, each section's cards in reading order with blurbs from each doc's first paragraph, the numbered section numbered, and the project links in the rail", async () => {
    fake = fakeApi([{ path: "/api/docs", reply: () => guide }]);
    await mount((r, s) => renderDocs(undefined, r, s));
    await settle();
    expect($(".room-switch [aria-current='page']").textContent).toBe("Docs");
    expect($(".docs-index h1").textContent).toBe("Set up <and> run"); // a title is text
    expect($(".docs-index-intro a").getAttribute("href")).toBe("#/docs/overview"); // markup
    expect($$(".doc-section-blurb").map((b) => b.textContent)).toEqual(["In order."]);
    const cards = $$<HTMLAnchorElement>(".doc-card");
    expect(cards.map((c) => c.getAttribute("href"))).toEqual([
      "#/docs/overview",
      "#/docs/provision",
      "#/docs/verify",
      "#/docs/configuration",
    ]);
    // A heading per section that has docs; one with none (More guides here) shows nothing.
    expect($$(".doc-section-t").map((h) => h.textContent)).toEqual(["Get started", "Reference"]);
    // Only the main path's steps carry numbers, and they sit in an ordered list.
    expect($$(".doc-card-n").map((n) => n.textContent)).toEqual(["01", "02", "03"]);
    expect($$("ol.doc-cards .doc-card")).toHaveLength(3);
    expect($$("ul.doc-cards .doc-card")).toHaveLength(1);
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
    await mount((r, s) => renderDocs(undefined, r, s));
    expect($$(".rail-link").map((a) => a.textContent?.trim())).toEqual(["Project siteProject ↗"]);
    expect(fake.calls).toEqual([]); // the guide is cached
  });

  it("opens a doc from the cache: the API's HTML as markup, ids on its headings, On this page in the rail, and the sequential pager", async () => {
    fake = fakeApi([]);
    await mount((r, s) => renderDocs("overview", r, s));
    expect(fake.calls).toEqual([]);
    const main = $("#docsMain");
    expect($("section.doc-part", main).id).toBe("doc-overview");
    expect($("ul li", main).textContent).toBe("an account"); // inserted as markup, not text
    // Each heading takes GitHub's anchor for it, so links written for GitHub land here.
    expect($("h1", main).id).toBe("doc-h-overview");
    expect($$("h2", main).map((h) => h.id)).toEqual([
      "doc-h-before-you-start",
      "doc-h-what-you-get",
    ]);
    expect($$<HTMLAnchorElement>("#tocOnPage .toc-sub").map((a) => a.getAttribute("href"))).toEqual(
      ["#/docs/overview", "#/docs/overview/before-you-start", "#/docs/overview/what-you-get"],
    );
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

  it("shows Previous and Next around a middle doc, and jumps within the doc from the rail, naming the section in the address", async () => {
    fake = fakeApi([]);
    await mount((r, s) => renderDocs("provision", r, s));
    expect($$(".doc-topnav a").map((a) => a.getAttribute("href"))).toEqual([
      "#/docs/overview",
      "#/docs/verify",
    ]);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    $("#tocOnPage .toc-sub[data-target='doc-h-steps']").click();
    expect($("#tocOnPage .toc-sub.on").textContent).toBe("Steps");
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    // The address names the section without a hashchange, so the page isn't rendered again.
    expect(location.hash).toBe("#/docs/provision/steps");
    scroll.mockRestore();
  });

  it("keeps Previous and Next within the doc's section: the last step has no Next into the reference", async () => {
    fake = fakeApi([]);
    await mount((r, s) => renderDocs("verify", r, s));
    expect($$(".doc-topnav a").map((a) => a.getAttribute("href"))).toEqual(["#/docs/provision"]);
    expect($(".doc-pager").lastElementChild?.tagName).toBe("SPAN"); // no Next
  });

  it("opens at the heading the route names", async () => {
    fake = fakeApi([]);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    await mount((r, s) => renderDocs("overview", r, s, "what-you-get"));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe($("#doc-h-what-you-get"));
    scroll.mockRestore();
  });

  it("derives a heading's anchor the way GitHub does", () => {
    expect(headingAnchor("7. Read the logs")).toBe("7-read-the-logs");
    expect(headingAnchor("3. Fill in wrangler.jsonc")).toBe("3-fill-in-wranglerjsonc");
    expect(headingAnchor("Before you begin")).toBe("before-you-begin");
  });

  it("copies a code block", async () => {
    fake = fakeApi([]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await mount((r, s) => renderDocs("overview", r, s));
    $("pre .code-copy").click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("npm run dev");
    expect($("pre .code-copy").textContent).toBe("Copied");
    vi.unstubAllGlobals();
  });

  it("heals an unknown slug to the index", async () => {
    fake = fakeApi([]);
    location.hash = "#/docs/nope";
    await mount((r, s) => renderDocs("nope", r, s));
    expect($("#toasts").textContent).toMatch(/No doc named “nope”/);
    expect($$(".doc-card")).toHaveLength(4);
    expect(location.hash).toBe("#/docs");
  });

  it("shows the error with a retry that fetches again", async () => {
    const render = await freshDocs();
    let failures = 1;
    fake = fakeApi([
      {
        path: "/api/docs",
        reply: () => (failures-- > 0 ? jsonResponse({ error: "down" }, 500) : guide),
      },
    ]);
    await render("verify");
    expect($(".room-main .error").textContent).toMatch(/down/);
    $("[data-retry]").click();
    await settle();
    expect($("#docsMain h1").textContent).toBe("Verify");
    expect(fake.calls).toHaveLength(2);
  });

  it("is cut off when the reader moves on while the guide is loading, and fetches again when they return", async () => {
    const render = await freshDocs();
    let release: (v: unknown) => void = () => {};
    let reads = 0;
    fake = fakeApi([
      {
        path: "/api/docs",
        // The first read is held open; the one after the return answers at once.
        reply: () => (++reads === 1 ? new Promise((r) => (release = r)).then(() => guide) : guide),
      },
    ]);
    const pending = render();
    await settle();
    unmount(); // what a tap on the API tab does mid-flight: the mount ends, the read with it
    release(null);
    await pending;
    expect($$(".doc-card")).toHaveLength(0); // nothing painted over what replaced it
    await render();
    expect($$(".doc-card")).toHaveLength(4);
    expect(fake.calls).toHaveLength(2); // the cut-off read filled no cache
  });
});
