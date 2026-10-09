import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { $, type FakeApi, fakeApi, jsonResponse, mount, resetShell, settle } from "../test/support";
import { renderWebVersion, webTarget } from "./web";

const page =
  '<!doctype html><html><body><div class="k-mast">The Marsh Letter</div><p>hello</p></body></html>';
const htmlReply = () => new Response(page, { headers: { "content-type": "text/html" } });

describe("web-version preview", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
  });
  afterEach(() => {
    fake?.restore();
  });

  it("reads its target from the route", () => {
    expect(webTarget("post", "p1")).toEqual({ post: "p1" });
    expect(webTarget("post", "a%2Fb")).toEqual({ post: "a/b" });
    expect(webTarget("template", undefined)).toBe("template");
    expect(webTarget("post", undefined)).toBeNull();
    expect(webTarget("other", "p1")).toBeNull();
  });

  it("frames a post's web version, sandboxed with no script or form, and links back to the post", async () => {
    location.hash = "#/web/post/p1";
    fake = fakeApi([{ path: "/api/posts/p1/web", reply: htmlReply }]);
    await mount((r, s) => renderWebVersion({ post: "p1" }, r, s));
    await settle();
    const frame = $<HTMLIFrameElement>(".web-frame");
    expect(frame.srcdoc).toBe(page);
    expect(frame.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-forms");
    expect($<HTMLAnchorElement>(".back").getAttribute("href")).toBe("#/edit/p1");
    expect(fake.unhandled).toEqual([]);
  });

  it("frames the template's sample and links back to the template", async () => {
    location.hash = "#/web/template";
    fake = fakeApi([{ path: "/api/settings/template/web", reply: htmlReply }]);
    await mount((r, s) => renderWebVersion("template", r, s));
    await settle();
    expect($<HTMLIFrameElement>(".web-frame").srcdoc).toBe(page);
    expect($<HTMLAnchorElement>(".back").getAttribute("href")).toBe("#/template");
    expect(fake.unhandled).toEqual([]);
  });

  it("says what went wrong, with a retry, when the page can't be read", async () => {
    location.hash = "#/web/post/gone";
    fake = fakeApi([
      { path: "/api/posts/gone/web", reply: () => jsonResponse({ error: "post not found" }, 404) },
    ]);
    await mount((r, s) => renderWebVersion({ post: "gone" }, r, s));
    await settle();
    expect(document.querySelector(".web-frame")).toBeNull();
    expect($(".error")).toBeTruthy();
    expect($("[data-retry]")).toBeTruthy();
  });
});
