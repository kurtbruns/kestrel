import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  stubClipboard,
  unmount,
} from "../test/support";
import { renderDocs } from "./docs";

// The docs as the Worker serves them: sanitized fragments with no ids on the headings. One
// Publishing page, then Self-hosting's three steps of the main path and one reference page.
const docs: DocFragment[] = [
  {
    slug: "your-list",
    title: "Your list",
    set: "publishing",
    section: "before-your-first-send",
    html: "<h1>Your list</h1><p>Bring your list.</p>",
  },
  {
    slug: "overview",
    title: "Overview",
    set: "self-hosting",
    section: "get-started",
    html: "<h1>Overview</h1><p>What a fresh instance needs, in order:</p><ul><li>an account</li></ul><h2>Before you start</h2><p>x</p><h2>What you get</h2><pre><code class='language-bash'>npx kestrel dev --port $PORT # &lt;local&gt;\n</code></pre><pre><code>10 inbound-smtp.us-east-1.amazonaws.com\n</code></pre>",
  },
  {
    slug: "provision",
    title: "Provision <the> Worker",
    set: "self-hosting",
    section: "get-started",
    html: "<h1>Provision the Worker</h1><p>Create the Worker &amp; its database.</p><h2>Steps</h2>",
  },
  {
    slug: "verify",
    title: "Verify",
    set: "self-hosting",
    section: "get-started",
    html: "<h1>Verify</h1><p>Send a test.</p>",
  },
  {
    slug: "configuration",
    title: "Configuration",
    set: "self-hosting",
    section: "reference",
    html: "<h1>Configuration</h1><p>Every setting.</p>",
  },
];

// The sets as the Worker reads them from their index files: Publishing first, then
// Self-hosting, with its main path numbered, a section with no docs in this fixture, and the
// reference.
const guide: DocsResponse = {
  sets: [
    {
      id: "publishing",
      name: "Publishing",
      title: "Publishing",
      intro: "<p>Write and send.</p>",
      sections: [
        {
          id: "before-your-first-send",
          title: "Before your first send",
          blurb: "",
          numbered: false,
        },
      ],
    },
    {
      id: "self-hosting",
      name: "Self-hosting",
      title: "Set up <and> run",
      intro: '<p>Start with the <a href="#/docs/overview">Overview</a>.</p>',
      sections: [
        { id: "get-started", title: "Get started", blurb: "<p>In order.</p>", numbered: true },
        { id: "guides", title: "Guides", blurb: "<p>Pick one.</p>", numbered: false },
        { id: "reference", title: "Reference", blurb: "", numbered: false },
      ],
    },
  ],
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
        build_time: "2026-09-21T10:00:00Z",
        repo_url: repoUrl,
        commit_url: repoUrl ? `${repoUrl}/commit/abc1234` : "",
        tag_url: "",
      },
    },
  }) as unknown as SettingsResponse;

// The module caches the guide after its first fetch (the bundle never changes at runtime).
// `beforeAll` fills this instance's cache once, so every test that reads it does so in any
// order; a test that needs a fetch of its own loads a fresh instance. A fresh instance
// comes with its own app state, so it is handed the same config the shared one reads. It
// also has its own lifecycle, so a view it mounts itself (a link it follows) is not torn down
// by resetShell's unmount; the room's DOM is still cleared with the shell.
async function freshDocs(repoUrl = "https://github.com/x/kestrel") {
  vi.resetModules();
  const fresh = await import("../state");
  fresh.appState.appConfig = config(repoUrl);
  const mod = await import("./docs");
  return (slug?: string) => mount((r, s) => mod.renderDocs(slug, r, s));
}

describe("docs room", () => {
  let fake: FakeApi;
  beforeAll(async () => {
    resetShell();
    appState.appConfig = config("https://github.com/x/kestrel");
    const filling = fakeApi([{ path: "/api/docs", reply: () => guide }]);
    await mount((r, s) => renderDocs(undefined, r, s));
    await settle();
    unmount();
    filling.restore();
  });
  beforeEach(() => {
    resetShell();
    location.hash = "#/docs";
    appState.appConfig = config("https://github.com/x/kestrel");
  });
  afterEach(() => {
    fake?.restore();
    document.onscroll = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens on the first set, Publishing, under one header with a tab per set", async () => {
    fake = fakeApi([]);
    await mount((r, s) => renderDocs(undefined, r, s));
    expect($(".docs-index h1").textContent).toBe("Kestrel docs");
    expect(
      $$<HTMLAnchorElement>(".docs-tabs a").map((a) => [a.getAttribute("href"), a.textContent]),
    ).toEqual([
      ["#/docs/publishing", "Publishing"],
      ["#/docs/self-hosting", "Self-hosting"],
    ]);
    expect($(".docs-tabs [aria-current='page']").textContent).toBe("Publishing");
    // One intro covers both sets; a set's own intro, written for its index file, isn't repeated.
    expect($(".docs-index-intro").textContent).toMatch(
      /^Publishing covers writing and sending your newsletter/,
    );
    expect($(".docs-index").textContent).not.toContain("Write and send.");
    // Only the set's own pages: the Self-hosting steps stay on its index.
    expect($$(".doc-card").map((c) => c.getAttribute("href"))).toEqual(["#/docs/your-list"]);
  });

  it("renders a set's index the way its index file lays it out: its title and intro, each section's cards in reading order with blurbs from each doc's first paragraph, the numbered section numbered, and the project links in the rail", async () => {
    const render = await freshDocs();
    fake = fakeApi([{ path: "/api/docs", reply: () => guide }]);
    await render("self-hosting");
    await settle();
    expect($(".room-switch [aria-current='page']").textContent).toBe("Docs");
    expect($(".docs-tabs [aria-current='page']").getAttribute("title")).toBe("Set up <and> run"); // a title is text
    expect($$(".doc-section-blurb").map((b) => b.textContent)).toEqual(["In order."]);
    const cards = $$<HTMLAnchorElement>(".doc-card");
    expect(cards.map((c) => c.getAttribute("href"))).toEqual([
      "#/docs/overview",
      "#/docs/provision",
      "#/docs/verify",
      "#/docs/configuration",
    ]);
    // A heading per section that has docs; one with none (Guides here) shows nothing.
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

  it("names the tab for the set's index, then for the doc open", async () => {
    fake = fakeApi([]);
    await mount((r, s) => renderDocs("self-hosting", r, s));
    expect(document.title).toBe("Self-hosting docs - Kestrel");
    await mount((r, s) => renderDocs("verify", r, s));
    expect(document.title).toBe("Verify - Kestrel");
    // A stale link heals to the index, and the tab says so.
    vi.spyOn(history, "replaceState").mockImplementation(() => {});
    await mount((r, s) => renderDocs("gone", r, s));
    expect(document.title).toBe("Publishing docs - Kestrel");
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
    // Its set over the title, as the way back to that set's index.
    expect($(".doc-set a", main).getAttribute("href")).toBe("#/docs/self-hosting");
    expect($(".doc-set a", main).textContent).toBe("Self-hosting");
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
    expect($$(".code-bare", main)).toHaveLength(2);
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
  });

  it("opens a doc at its top when the route's anchor is a malformed escape", async () => {
    fake = fakeApi([]);
    const top = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    await mount((r, s) => renderDocs("overview", r, s, "check%2"));
    expect($("#doc-h-what-you-get")).toBeTruthy();
    expect(top).toHaveBeenCalledWith(0, 0);
  });

  it("shows a fenced block bare, highlighted by its language, with Copy of its plain text beside it", async () => {
    fake = fakeApi([]);
    const writeText = stubClipboard();
    await mount((r, s) => renderDocs("overview", r, s));
    const block = $$(".doc .code-bare")[0]!;
    // No label line: the prose around a doc's block already says what it is.
    expect(block.querySelector(".block-label, .block-head")).toBeNull();
    // The text is the fence's, without marked's closing newline, and the markup in it is text.
    const code = $("pre code", block);
    expect(code.textContent).toBe("npx kestrel dev --port $PORT # <local>");
    expect(code.querySelector("local")).toBeNull();
    expect($(".cx-tag", code).textContent).toBe("npx");
    expect($$(".cx-num", code).map((s) => s.textContent)).toEqual(["--port"]);
    expect($(".cx-var", code).textContent).toBe("$PORT");
    const copy = $<HTMLButtonElement>("pre + .copy-btn", block);
    expect($("span", copy).textContent).toBe("");
    expect(copy.getAttribute("aria-label")).toBe("Copy");
    copy.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("npx kestrel dev --port $PORT # <local>");
    expect(copy.getAttribute("aria-label")).toBe("Copied");
    expect($("span", copy).textContent).toBe("");
  });

  it("leaves a block whose fence names no language plain, never guessing one, with Copy still on it", async () => {
    fake = fakeApi([]);
    const writeText = stubClipboard();
    await mount((r, s) => renderDocs("overview", r, s));
    const block = $$(".doc .code-bare")[1]!;
    expect($("pre code", block).children).toHaveLength(0);
    $<HTMLButtonElement>("pre + .copy-btn", block).click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("10 inbound-smtp.us-east-1.amazonaws.com");
  });

  it("heals an unknown slug to the index", async () => {
    fake = fakeApi([]);
    location.hash = "#/docs/nope";
    await mount((r, s) => renderDocs("nope", r, s));
    expect($("#toasts").textContent).toMatch(/No doc named “nope”/);
    expect($$(".doc-card")).toHaveLength(1); // the first set's index
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
    expect($(".room-main .error").textContent).toMatch(/went wrong on the server/);
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
    expect($$(".doc-card")).toHaveLength(1);
    expect(fake.calls).toHaveLength(2); // the cut-off read filled no cache
  });
});
