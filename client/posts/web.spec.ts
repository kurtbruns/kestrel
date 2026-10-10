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
import { framedCopy, linksInNewTab, renderWebVersion, webBar, webTarget } from "./web";

const page =
  '<!doctype html><html><head><title>Herons</title></head><body><div class="k-mast">The Marsh Letter</div><p>hello</p></body></html>';
const htmlReply = () => new Response(page, { headers: { "content-type": "text/html" } });
/** A post's read: a draft, a scheduled post, one whose send is going out, or a sent one. */
const postReply = (stage: "draft" | "scheduled" | "sending" | "sent") => () =>
  jsonResponse({
    post: { id: "p1", slug: "herons", status: stage === "sending" ? "scheduled" : stage },
    scheduled:
      stage === "scheduled"
        ? { id: "s1", fire_at: Date.UTC(2026, 9, 12, 16), remade_at: null }
        : null,
    sending: stage === "sending" ? { id: "s1" } : null,
    sent: stage === "sent" ? { id: "s1" } : null,
  });
const deployment = () => {
  appState.appConfig = {
    deployment: { archiveOrigin: "https://newsletter.example.com", archiveBasePath: "/archive" },
  } as unknown as typeof appState.appConfig;
};
/** The bar's words, as text. */
const barText = (state: Parameters<typeof webBar>[0], editHref = "#/edit/p1") => {
  const el = document.createElement("div");
  setHtml(el, html`${webBar(state, editHref)}`);
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

  it("says in its bar where the post stands and where its public page will be, then the way to the editor", () => {
    const url = "https://newsletter.example.com/archive/herons";
    const short = "newsletter.example.com/archive/herons";
    const draft = barText({ kind: "post", stage: "draft", fireAt: null, url });
    expect(draft.textContent).toBe(
      `Web versionNot published yet. It will be at ${short}.Edit post`,
    );
    // The address doesn't answer yet, so it is text; the one link is the way to the editor.
    expect([...draft.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      "#/edit/p1",
    ]);
    const fireAt = Date.UTC(2026, 9, 12, 16);
    expect(barText({ kind: "post", stage: "scheduled", fireAt, url }).textContent).toBe(
      `Web versionSends ${fmt(fireAt)}. It will be at ${short}.Edit post`,
    );
    expect(barText({ kind: "post", stage: "sending", fireAt: null, url }).textContent).toBe(
      `Web versionSending now. It will be at ${short} once the send finishes.Edit post`,
    );
    const sample = barText({ kind: "template" }, "#/template");
    expect(sample.textContent).toBe(
      "Web versionThe sample post, with your saved templateEdit template",
    );
    expect(sample.querySelector("a")?.getAttribute("href")).toBe("#/template");
    // Unknown stage or address: the bar names no address rather than a wrong one.
    expect(barText(null).textContent).toBe("Web versionEdit post");
    expect(barText({ kind: "post", stage: "draft", fireAt: null, url: null }).textContent).toBe(
      "Web versionNot published yet.Edit post",
    );
  });

  it("fills the window under its bar with a post's web version, sandboxed with no script or form", async () => {
    location.hash = "#/web/post/p1";
    deployment();
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
      "It will be at newsletter.example.com/archive/herons.",
    );
    expect($<HTMLAnchorElement>(".web-edit").getAttribute("href")).toBe("#/edit/p1");
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
    expect($(".web-bar").textContent).toBe("Web versionEdit post");
  });

  it("goes to the public page itself once the post is sent", async () => {
    location.hash = "#/web/post/p1";
    deployment();
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: postReply("sent") },
    ]);
    const replace = vi.spyOn(location, "replace").mockImplementation(() => {});
    await mount((r, s) => renderWebVersion({ post: "p1" }, r, s));
    await settle();
    expect(replace).toHaveBeenCalledWith("https://newsletter.example.com/archive/herons");
    expect(document.querySelector(".web-frame")).toBeNull();
    replace.mockRestore();
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
