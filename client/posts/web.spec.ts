import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { framedCopy, linksInNewTab, renderWebVersion, webTarget } from "./web";

const page =
  '<!doctype html><html><head><title>Herons</title></head><body><div class="k-mast">The Marsh Letter</div><p>hello</p></body></html>';
const htmlReply = () => new Response(page, { headers: { "content-type": "text/html" } });

describe("web-version preview", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
  });
  afterEach(() => {
    fake?.restore();
  });

  it("opens every link in a new tab, since the public pages refuse to be framed", () => {
    expect(linksInNewTab('<html><head lang="en"><title>t</title></head></html>')).toBe(
      '<html><head lang="en"><base target="_blank"><title>t</title></head></html>',
    );
    expect(linksInNewTab("<p>no head</p>")).toBe('<base target="_blank"><p>no head</p>');
    // A <header> is not the <head>.
    expect(linksInNewTab("<header>x</header>")).toBe('<base target="_blank"><header>x</header>');
  });

  it("restates the page's own policy inside the framed copy: no script, no form, no frame", () => {
    const framed = framedCopy("<html><head><title>t</title></head></html>");
    expect(framed).toMatch(
      /^<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*"><base target="_blank"><title>/,
    );
    expect(framed).toContain("form-action 'none'");
    expect(framed).toContain("frame-src 'none'");
    expect(framed).not.toContain("script-src");
  });

  it("reads its target from the route", () => {
    expect(webTarget("post", "p1")).toEqual({ post: "p1" });
    expect(webTarget("post", "a%2Fb")).toEqual({ post: "a/b" });
    expect(webTarget("template", undefined)).toBe("template");
    expect(webTarget("post", undefined)).toBeNull();
    expect(webTarget("other", "p1")).toBeNull();
    expect(webTarget("post", "%E0")).toBeNull(); // malformed: no preview, never a throw
  });

  it("fills the window with a post's web version, sandboxed with no script or form, and no chrome of its own", async () => {
    location.hash = "#/web/post/p1";
    fake = fakeApi([{ path: "/api/posts/p1/web", reply: htmlReply }]);
    await mount((r, s) => renderWebVersion({ post: "p1" }, r, s));
    await settle();
    const frame = $<HTMLIFrameElement>(".web-frame");
    expect(frame.srcdoc).toBe(framedCopy(page));
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-forms");
    expect(frame.parentElement?.children).toHaveLength(1);
    expect(fake.unhandled).toEqual([]);
  });

  it("names the tab for the page, and gives the app's title back when it leaves", async () => {
    location.hash = "#/web/post/p1";
    document.title = "Kestrel";
    fake = fakeApi([{ path: "/api/posts/p1/web", reply: htmlReply }]);
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
    expect(fake.unhandled).toEqual([]);
  });

  it("says what went wrong, with a retry, when the page can't be read", async () => {
    location.hash = "#/web/post/gone";
    fake = fakeApi([
      {
        path: "/api/posts/gone/web",
        reply: () => jsonResponse({ error: "post not found" }, 404),
      },
    ]);
    await mount((r, s) => renderWebVersion({ post: "gone" }, r, s));
    await settle();
    expect(document.querySelector(".web-frame")).toBeNull();
    expect($(".web-error .error")).toBeTruthy();
    expect($("[data-retry]")).toBeTruthy();
  });
});
