import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../state";
import {
  $,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
  unmount,
} from "../test/support";
import { fmt } from "../ui/format";
import { html, setHtml } from "../ui/html";
import { framedCopy, renderWebVersion, webBar, webPostId, webVersionHash } from "./web";

const page =
  '<!doctype html><html><head><title>Herons</title></head><body><div class="k-mast">The Marsh Letter</div><p>hello</p></body></html>';
const htmlReply = () => new Response(page, { headers: { "content-type": "text/html" } });
const FIRE_AT = Date.UTC(2026, 9, 12, 16);
/** A post's read: a draft, a scheduled post, one whose send is going out, or a sent one. */
const postReply = (stage: "draft" | "scheduled" | "sending" | "sent") => () =>
  jsonResponse({
    post: { id: "p1", slug: "herons", status: stage === "sending" ? "scheduled" : stage },
    scheduled: stage === "scheduled" ? { id: "s1", fire_at: FIRE_AT, remade_at: null } : null,
    sending: stage === "sending" ? { id: "s1" } : null,
    sent: stage === "sent" ? { id: "s1" } : null,
  });
const deployment = () => {
  appState.appConfig = {
    deployment: { archiveOrigin: "https://newsletter.example.com", archiveBasePath: "/archive" },
  } as unknown as typeof appState.appConfig;
};
/** The bar's words, as an element. */
const bar = (state: Parameters<typeof webBar>[0]) => {
  const el = document.createElement("div");
  setHtml(el, html`${webBar(state)}`);
  return el;
};

describe("web version", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
  });
  afterEach(() => {
    fake?.restore();
    appState.appConfig = null;
  });

  it("restates the page's own policy inside the framed copy, opens links in a new tab, and never as an opener", () => {
    const framed = framedCopy(
      '<html><head lang="en"><title>t</title></head><body><a rel="opener nofollow" href="https://x.example">x</a><a rel=\'OPENER\' href="https://y.example">y</a></body></html>',
    );
    expect(framed).toMatch(
      /^<html><head lang="en"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none';[^"]*"><base target="_blank"><title>/,
    );
    expect(framed).toContain("form-action 'none'");
    expect(framed).toContain("frame-src 'none'");
    // The <base> the copy adds must stand, and a <meta> can't carry frame-ancestors.
    expect(framed).not.toContain("base-uri");
    expect(framed).not.toContain("frame-ancestors");
    expect(framed).toContain('rel="nofollow"');
    expect(framed).toContain("rel=''");
    expect(framed.toLowerCase()).not.toContain("opener");
    // No <head> (and a <header> is not one): the markup goes first.
    expect(framedCopy("<header>x</header>")).toMatch(/^<meta [^>]*><base target="_blank"><header>/);
  });

  it("reads its post from the route, and names its route", () => {
    expect(webPostId("post", "p1")).toBe("p1");
    expect(webPostId("post", "a%2Fb")).toBe("a/b");
    expect(webPostId("post", undefined)).toBeNull();
    expect(webPostId("other", "p1")).toBeNull();
    expect(webPostId("post", "%E0")).toBeNull(); // malformed: no page, never a throw
    expect(webVersionHash("a/b c")).toBe("#/web/post/a%2Fb%20c");
  });

  it("says in its bar where the post stands and where its public page will be, as text", () => {
    const url = "https://newsletter.example.com/archive/herons";
    const short = "newsletter.example.com/archive/herons";
    const draft = bar({ fireAt: null, url });
    expect(draft.textContent).toBe(`Web versionNot published yet. It will be at ${short}.`);
    // The address doesn't answer yet, so it is text, and the bar has no link at all.
    expect(draft.querySelectorAll("a")).toHaveLength(0);
    expect(bar({ fireAt: FIRE_AT, url }).textContent).toBe(
      `Web versionSends ${fmt(FIRE_AT)}. It will be at ${short}.`,
    );
    // Unknown address or post: the bar names no address rather than a wrong one.
    expect(bar({ fireAt: null, url: null }).textContent).toBe("Web versionNot published yet.");
    expect(bar(null).textContent).toBe("Web version");
  });

  it("fills the window under its bar with a scheduled post's web version, sandboxed with no script or form", async () => {
    location.hash = "#/web/post/p1";
    deployment();
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: postReply("scheduled") },
    ]);
    await mount((r, s) => renderWebVersion("p1", r, s));
    await settle();
    const frame = $<HTMLIFrameElement>(".web-frame");
    expect(frame.srcdoc).toBe(framedCopy(page));
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-popups-to-escape-sandbox");
    expect(sandbox).not.toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-forms");
    expect($(".web-bar").textContent).toBe(
      `Web versionSends ${fmt(FIRE_AT)}. It will be at newsletter.example.com/archive/herons.`,
    );
    // The bar and the page, nothing else: no back link, edit link, or app chrome.
    expect($(".web-page").children).toHaveLength(2);
    expect(document.querySelector(".web-page a")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("still shows the page, with a bar that names no stage or address, when the post can't be read", async () => {
    location.hash = "#/web/post/p1";
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: () => jsonResponse({ error: "boom" }, 500) },
    ]);
    await mount((r, s) => renderWebVersion("p1", r, s));
    await settle();
    expect($<HTMLIFrameElement>(".web-frame").srcdoc).toBe(framedCopy(page));
    expect($(".web-bar").textContent).toBe("Web version");
  });

  for (const stage of ["sending", "sent"] as const) {
    it(`goes to the public page itself once the post is ${stage}`, async () => {
      location.hash = "#/web/post/p1";
      deployment();
      fake = fakeApi([
        { path: "/api/posts/p1/web", reply: htmlReply },
        { path: "/api/posts/p1", reply: postReply(stage) },
      ]);
      const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
      await mount((r, s) => renderWebVersion("p1", r, s));
      await settle();
      expect(replace).toHaveBeenCalledWith("https://newsletter.example.com/archive/herons");
      expect(document.querySelector(".web-frame")).toBeNull();
      replace.mockRestore();
    });
  }

  it("names the tab for the page, and gives the app's title back when it leaves", async () => {
    location.hash = "#/web/post/p1";
    document.title = "Kestrel";
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: postReply("draft") },
    ]);
    await mount((r, s) => renderWebVersion("p1", r, s));
    await settle();
    expect(document.title).toMatch(/^Web version/);
    unmount();
    expect(document.title).toBe("Kestrel");
  });

  it("says what went wrong, with a retry, when the page can't be read", async () => {
    location.hash = "#/web/post/gone";
    fake = fakeApi([
      {
        path: "/api/posts/gone/web",
        reply: () => jsonResponse({ error: "post not found" }, 404),
      },
      { path: "/api/posts/gone", reply: () => jsonResponse({ error: "post not found" }, 404) },
    ]);
    await mount((r, s) => renderWebVersion("gone", r, s));
    await settle();
    expect(document.querySelector(".web-frame")).toBeNull();
    expect($(".web-error .error")).toBeTruthy();
    expect($("[data-retry]")).toBeTruthy();
  });
});
