import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { html, setHtml } from "../ui/html";
import { framedCopy, linksInNewTab, renderWebVersion, webBar, webTarget } from "./web";

const page =
  '<!doctype html><html><head><title>Herons</title></head><body><div class="k-mast">The Marsh Letter</div><p>hello</p></body></html>';
const htmlReply = () => new Response(page, { headers: { "content-type": "text/html" } });
const postReply = (status: string) => () =>
  jsonResponse({ post: { id: "p1", slug: "herons", status } });
/** The bar's words, as text. */
const barText = (state: Parameters<typeof webBar>[0]) => {
  const el = document.createElement("div");
  setHtml(el, html`${webBar(state)}`);
  return el;
};

describe("web-version preview", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
  });
  afterEach(() => {
    fake?.restore();
    appState.appConfig = null;
  });

  it("opens every link in a new tab, since the public pages refuse to be framed", () => {
    expect(linksInNewTab('<html><head lang="en"><title>t</title></head></html>')).toBe(
      '<html><head lang="en"><base target="_blank"><title>t</title></head></html>',
    );
    expect(linksInNewTab("<p>no head</p>")).toBe('<base target="_blank"><p>no head</p>');
    // A <header> is not the <head>.
    expect(linksInNewTab("<header>x</header>")).toBe('<base target="_blank"><header>x</header>');
  });

  it("restates the page's own policy inside the framed copy, and never opens a link as an opener", () => {
    const framed = framedCopy(
      '<html><head><title>t</title></head><body><a rel="opener nofollow" href="https://x.example">x</a><a rel=\'OPENER\' href="https://y.example">y</a></body></html>',
    );
    expect(framed).toMatch(
      /^<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none';[^"]*"><base target="_blank"><title>/,
    );
    expect(framed).toContain("form-action 'none'");
    expect(framed).toContain("frame-src 'none'");
    // The <base> the copy adds must stand, and a <meta> can't carry frame-ancestors.
    expect(framed).not.toContain("base-uri");
    expect(framed).not.toContain("frame-ancestors");
    expect(framed).toContain('rel="nofollow"');
    expect(framed).toContain("rel=''");
    expect(framed.toLowerCase()).not.toContain("opener");
  });

  it("reads its target from the route", () => {
    expect(webTarget("post", "p1")).toEqual({ post: "p1" });
    expect(webTarget("post", "a%2Fb")).toEqual({ post: "a/b" });
    expect(webTarget("template", undefined)).toBe("template");
    expect(webTarget("post", undefined)).toBeNull();
    expect(webTarget("other", "p1")).toBeNull();
    expect(webTarget("post", "%E0")).toBeNull(); // malformed: no preview, never a throw
  });

  it("says in its bar what the page is and where the public page is, or will be", () => {
    const url = "https://newsletter.example.com/archive/herons";
    const draft = barText({ kind: "post", status: "draft", url });
    expect(draft.textContent).toBe(`Web versionNot sent yet. Its page will be at ${url}`);
    // An unsent address doesn't answer yet, so it is text, not a link.
    expect(draft.querySelector("a")).toBeNull();
    expect(barText({ kind: "post", status: "scheduled", url }).textContent).toContain(
      "Scheduled, not sent yet. Its page will be at",
    );
    const sent = barText({ kind: "post", status: "sent", url });
    expect(sent.textContent).toBe(`Web versionSent. Published at ${url}`);
    expect(sent.querySelector("a")?.getAttribute("href")).toBe(url);
    expect(sent.querySelector("a")?.getAttribute("target")).toBe("_blank");
    expect(barText({ kind: "template" }).textContent).toContain(
      "The sample post, with the saved template",
    );
    // Unknown status or address: the bar names no address rather than a wrong one.
    expect(barText(null).textContent).toBe("Web version");
    expect(barText({ kind: "post", status: "draft", url: null }).textContent).toBe(
      "Web versionNot sent yet.",
    );
    expect(
      barText({ kind: "post", status: "sent", url: "javascript:x" }).querySelector("a"),
    ).toBeNull();
  });

  it("fills the window under its bar with a post's web version, sandboxed with no script or form", async () => {
    location.hash = "#/web/post/p1";
    appState.appConfig = {
      deployment: { archiveOrigin: "https://newsletter.example.com", archiveBasePath: "/archive" },
    } as unknown as typeof appState.appConfig;
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: postReply("scheduled") },
    ]);
    await mount((r, s) => renderWebVersion({ post: "p1" }, r, s));
    await settle();
    const frame = $<HTMLIFrameElement>(".web-frame");
    expect(frame.srcdoc).toBe(framedCopy(page));
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-forms");
    expect($(".web-bar").textContent).toContain(
      "Scheduled, not sent yet. Its page will be at https://newsletter.example.com/archive/herons",
    );
    // The bar and the page, nothing else: no back link or app chrome.
    expect($(".web-page").children).toHaveLength(2);
    expect(fake.unhandled).toEqual([]);
  });

  it("still shows the page, with a bar that names no address, when the post can't be read", async () => {
    location.hash = "#/web/post/p1";
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: () => jsonResponse({ error: "boom" }, 500) },
    ]);
    await mount((r, s) => renderWebVersion({ post: "p1" }, r, s));
    await settle();
    expect($<HTMLIFrameElement>(".web-frame").srcdoc).toBe(framedCopy(page));
    expect($(".web-bar").textContent).toBe("Web version");
  });

  it("names the tab for the page, and gives the app's title back when it leaves", async () => {
    location.hash = "#/web/post/p1";
    document.title = "Kestrel";
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: postReply("draft") },
    ]);
    await mount((r, s) => renderWebVersion({ post: "p1" }, r, s));
    await settle();
    expect(document.title).toMatch(/^Web version/);
    unmount();
    expect(document.title).toBe("Kestrel");
  });

  it("fills the window with the template's sample", async () => {
    location.hash = "#/web/template";
    fake = fakeApi([{ path: "/api/settings/template/web", reply: htmlReply }]);
    await mount((r, s) => renderWebVersion("template", r, s));
    await settle();
    expect($<HTMLIFrameElement>(".web-frame").srcdoc).toBe(framedCopy(page));
    expect($(".web-bar").textContent).toContain("The sample post");
    expect(fake.unhandled).toEqual([]);
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
    await mount((r, s) => renderWebVersion({ post: "gone" }, r, s));
    await settle();
    expect(document.querySelector(".web-frame")).toBeNull();
    expect($(".web-error .error")).toBeTruthy();
    expect($("[data-retry]")).toBeTruthy();
  });
});
