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
import { trackSaves } from "./pending_save";
import { framedCopy, renderWebVersion, webPostId, webVersionHash } from "./web";

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
describe("web version", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
  });
  afterEach(() => {
    fake?.restore();
    appState.appConfig = null;
  });

  it("restates the page's own policy inside the framed copy, and changes nothing else", () => {
    const doc =
      '<html><head lang="en"><title>t</title></head><body><pre>rel="opener"</pre><a rel=opener href="https://x.example">x</a></body></html>';
    const framed = framedCopy(doc);
    expect(framed).toMatch(
      /^<html><head lang="en"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none';[^"]*"><title>/,
    );
    expect(framed).toContain("form-action 'none'");
    expect(framed).toContain("frame-src 'none'");
    expect(framed).toContain("base-uri 'none'");
    // A <meta> can't carry frame-ancestors.
    expect(framed).not.toContain("frame-ancestors");
    // The page's own markup is untouched, a code sample's text included; its links are
    // set once the frame has loaded.
    expect(framed.replace(/<meta [^>]*>/, "")).toBe(doc);
    // No <head> (and a <header> is not one): the markup goes first.
    expect(framedCopy("<header>x</header>")).toMatch(/^<meta [^>]*><header>/);
  });

  it("reads its post from the route, and names its route", () => {
    expect(webPostId("post", "p1")).toBe("p1");
    expect(webPostId("post", "a%2Fb")).toBe("a/b");
    expect(webPostId("post", undefined)).toBeNull();
    expect(webPostId("other", "p1")).toBeNull();
    expect(webPostId("post", "%E0")).toBeNull(); // malformed: no page, never a throw
    expect(webVersionHash("a/b c")).toBe("#/web/post/a%2Fb%20c");
  });

  it("fills the window with a scheduled post's web version, sandboxed with no script or form", async () => {
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
    // The page, nothing else: no bar, back link, edit link, or app chrome (the page's own
    // banner, from the server, says what it is).
    expect($(".web-page").children).toHaveLength(1);
    expect(document.querySelector(".web-page a")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("reads the page only once the editor's save in flight has landed, so an edit just made shows", async () => {
    location.hash = "#/web/post/p1";
    deployment();
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: postReply("draft") },
    ]);
    let land!: () => void;
    trackSaves(new Promise<void>((r) => (land = r)));
    const mounted = mount((r, s) => renderWebVersion("p1", r, s));
    await settle();
    expect(fake.calls).toHaveLength(0);
    land();
    await mounted;
    await settle();
    expect(fake.calls.map((c) => c.url.pathname).sort()).toEqual([
      "/api/posts/p1",
      "/api/posts/p1/web",
    ]);
    expect($<HTMLIFrameElement>(".web-frame").srcdoc).toBe(framedCopy(page));
  });

  it("sends the framed page's links to a new tab once it loads, and a fragment-only link nowhere", async () => {
    location.hash = "#/web/post/p1";
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: postReply("draft") },
    ]);
    await mount((r, s) => renderWebVersion("p1", r, s));
    await settle();
    const frame = $<HTMLIFrameElement>(".web-frame");
    // happy-dom loads no srcdoc, so the page is written in as the browser would load it.
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(
      '<title>Herons</title><a href="https://x.example" target="_self" rel="opener">x</a><a href="#notes">notes</a>',
    );
    doc.close();
    frame.dispatchEvent(new Event("load"));
    const [out, jump] = [...doc.querySelectorAll("a")];
    expect(out!.getAttribute("target")).toBe("_blank");
    expect(out!.getAttribute("rel")).toBe("noopener noreferrer");
    expect(jump!.hasAttribute("target")).toBe(false);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    jump!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(document.title).toBe("Web version · Herons");
  });

  it("still shows the page when the post can't be read", async () => {
    location.hash = "#/web/post/p1";
    fake = fakeApi([
      { path: "/api/posts/p1/web", reply: htmlReply },
      { path: "/api/posts/p1", reply: () => jsonResponse({ error: "boom" }, 500) },
    ]);
    await mount((r, s) => renderWebVersion("p1", r, s));
    await settle();
    expect($<HTMLIFrameElement>(".web-frame").srcdoc).toBe(framedCopy(page));
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
