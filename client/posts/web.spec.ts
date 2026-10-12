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
import { framedCopy } from "../ui/email_frame";
import { html, setHtml } from "../ui/html";
import { trackSaves } from "./pending_save";
import { renderWebVersion, webBar, webPostId, webVersionHash } from "./web";

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
    vi.restoreAllMocks();
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

  it("names the page as its tag, then where the post stands and where it will be published, as text", () => {
    const url = "https://newsletter.example.com/archive/herons";
    const short = "newsletter.example.com/archive/herons";
    const draft = bar({ scheduled: false, url });
    expect(draft.textContent).toBe(`Web version Draft · will be published at ${short}`);
    // The address doesn't answer yet, so it is text, and the bar has no link at all.
    expect(draft.querySelectorAll("a")).toHaveLength(0);
    // The tag is the dev pill's chip, apart from the sentence.
    expect(draft.querySelector(".web-bar-tag")?.textContent).toBe("Web version");
    expect(bar({ scheduled: true, url }).textContent).toBe(
      `Web version Scheduled · will be published at ${short}`,
    );
    // Unknown address or post: the bar names no address, or no stage, rather than a wrong one.
    expect(bar({ scheduled: false, url: null }).textContent).toBe("Web version Draft");
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
      "Web version Scheduled · will be published at newsletter.example.com/archive/herons",
    );
    // The window scrolls the page: the frame has no scrolling of its own.
    expect(frame.getAttribute("scrolling")).toBe("no");
    // The bar and the page, nothing else: no back link, edit link, or app chrome.
    expect($(".web-page").children).toHaveLength(2);
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

  it("says the page can't be read, with a retry that reads it again", async () => {
    location.hash = "#/web/post/p1";
    let down = true;
    fake = fakeApi([
      {
        path: "/api/posts/p1/web",
        reply: () => (down ? jsonResponse({ error: "post not found" }, 404) : htmlReply()),
      },
      { path: "/api/posts/p1", reply: postReply("draft") },
    ]);
    const webReads = () => fake.calls.filter((c) => c.url.pathname === "/api/posts/p1/web");
    await mount((r, s) => renderWebVersion("p1", r, s));
    await settle();
    expect(document.querySelector(".web-frame")).toBeNull();
    expect(document.querySelectorAll(".web-error .error")).toHaveLength(1);
    expect(webReads()).toHaveLength(1);
    down = false;
    $("[data-retry]").click();
    await settle();
    expect(webReads()).toHaveLength(2);
    expect(document.querySelector(".web-error")).toBeNull();
    expect($<HTMLIFrameElement>(".web-frame").srcdoc).toBe(framedCopy(page));
    expect(fake.unhandled).toEqual([]);
  });

  it("says what went wrong in the server's words when the page can't be read", async () => {
    location.hash = "#/web/post/empty";
    const empty = () =>
      jsonResponse({ error: "bad_request", message: "post has no content yet" }, 400);
    fake = fakeApi([
      { path: "/api/posts/empty/web", reply: empty },
      { path: "/api/posts/empty", reply: postReply("draft") },
    ]);
    await mount((r, s) => renderWebVersion("empty", r, s));
    await settle();
    expect($(".web-error .error span").textContent).toBe("post has no content yet");
    expect(fake.unhandled).toEqual([]);
  });

  it("says there's no post at an address that names none", async () => {
    location.hash = "#/web/post/gone";
    const gone = () => jsonResponse({ error: "not_found", message: "post" }, 404);
    fake = fakeApi([
      { path: "/api/posts/gone/web", reply: gone },
      { path: "/api/posts/gone", reply: gone },
    ]);
    await mount((r, s) => renderWebVersion("gone", r, s));
    await settle();
    expect($(".web-error .error span").textContent).toBe(
      "There’s no post here. It may have been deleted.",
    );
    expect(fake.unhandled).toEqual([]);
  });
});
