import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READER_JOURNEYS } from "../../shared/reader_pages";
import {
  $,
  $$,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settingsResponse,
  settle,
  unmount,
} from "../test/support";
import { html, setHtml } from "../ui/html";
import { mountReaderPages, readerPageAddress, readerPagesSection } from "./reader_pages";

const page = (name: string) => new Response(`<html><head></head><body>${name}</body></html>`);
const deployment = settingsResponse().deployment;

describe("reader pages section (SPEC §5)", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
  });
  afterEach(() => {
    unmount();
    fake?.restore();
  });

  /** The section alone, mounted the way Settings mounts it. */
  async function open(routes: FakeRoute[] = []) {
    fake = fakeApi([
      ...routes,
      { path: /^\/api\/reader-pages\//, reply: (req) => page(req.url.pathname) },
    ]);
    await mount((root, signal) => {
      setHtml(root, readerPagesSection(html`<h2>Reader pages</h2>`));
      mountReaderPages(root, deployment, signal);
    });
    await settle();
  }

  const reads = () => fake.calls.map((c) => c.url.pathname);
  const frame = () => $<HTMLIFrameElement>("#rpFrame");
  const row = (journey: string, label: string) => {
    const b = $$<HTMLButtonElement>(`.set-rp-item[data-journey="${journey}"]`).find((x) =>
      x.textContent?.trim().endsWith(label),
    );
    if (!b) {
      throw new Error(`no row ${journey} / ${label}`);
    }
    return b;
  };
  const current = () =>
    $$<HTMLButtonElement>('.set-rp-item[aria-current="true"]').map(
      (b) => `${b.dataset.journey}/${b.dataset.state}`,
    );

  it("lists every journey as a heading over its pages, steps numbered and off-path pages branched", async () => {
    await open();
    expect($$(".set-rp-jhead").map((h) => h.textContent?.trim())).toEqual([
      "Subscribe",
      "Confirm",
      "Unsubscribe",
      "Reading",
    ]);
    // A heading is a label, never a control.
    expect($$(".set-rp-jhead button")).toEqual([]);
    // Every page in the shared list has one row.
    expect($$(".set-rp-item")).toHaveLength(
      READER_JOURNEYS.reduce((n, j) => n + j.states.length, 0),
    );
    const marks = (journey: string) =>
      $$(`.set-rp-journey[data-journey="${journey}"] .set-rp-item`).map((b) => ({
        mark: $(".set-rp-mark", b).querySelector(".set-rp-dot")
          ? "dot"
          : $(".set-rp-mark", b).textContent?.trim(),
        off: b.classList.contains("off"),
      }));
    expect(marks("confirm")).toEqual([
      { mark: "1", off: false },
      { mark: "2", off: false },
      { mark: "", off: true },
      { mark: "", off: true },
    ]);
    // Reading's pages are peers, so they carry no numbers.
    expect(marks("reading")).toEqual([
      { mark: "dot", off: false },
      { mark: "dot", off: false },
      { mark: "dot", off: false },
      { mark: "", off: true },
      { mark: "", off: true },
      { mark: "", off: true },
    ]);
    // The thread joins only a journey's steps: never Reading's peers, never an off-path page.
    const threaded = (journey: string) =>
      $$(`.set-rp-journey[data-journey="${journey}"] .set-rp-list.steps .set-rp-item`).map(
        (b) => b.dataset.state,
      );
    expect(threaded("confirm")).toEqual(["ready", "confirmed"]);
    expect(threaded("reading")).toEqual([]);
  });

  it("marks a Reading peer with a drawn dot, not a text glyph", async () => {
    await open();
    const peers = $$('.set-rp-journey[data-journey="reading"] .set-rp-item:not(.off) .set-rp-mark');
    expect(peers.length).toBeGreaterThan(0);
    for (const mark of peers) {
      // An empty element the circle centers exactly; a "·" sits wherever the font puts it.
      expect(mark.children).toHaveLength(1);
      expect(mark.firstElementChild?.classList.contains("set-rp-dot")).toBe(true);
      expect(mark.textContent).toBe("");
    }
  });

  it("opens on the subscribe form, framed so no form on it submits", async () => {
    await open();
    expect(current()).toEqual(["subscribe/form"]);
    expect($("#rpJourney").textContent).toBe("Subscribe");
    expect($("#rpState").textContent).toBe("Form");
    expect($("#rpNote").textContent).toMatch(/Your name, tagline, and logo head each page/);
    expect($("#rpAt").textContent).toBe("app.birds.example/subscribe");
    expect(reads()).toEqual(["/api/reader-pages/subscribe/form"]);
    expect(frame().srcdoc).toContain("/api/reader-pages/subscribe/form");
    expect(frame().srcdoc).toContain("form-action 'none'");
    // The sandbox leaves out forms and scripts.
    expect(frame().getAttribute("sandbox")).toBe("allow-same-origin");
    expect(fake.unhandled).toEqual([]);
  });

  it("shows the page a row names, with its journey's note and where a reader meets it", async () => {
    await open();
    row("confirm", "Expired").click();
    await settle();
    expect(current()).toEqual(["confirm/expired"]);
    expect($(".set-rp-journey.current").dataset.journey).toBe("confirm");
    expect($("#rpJourney").textContent).toBe("Confirm");
    expect($("#rpState").textContent).toBe("Expired");
    expect($("#rpNote").textContent).toMatch(/what a reader agrees to can’t be edited away/);
    expect($("#rpAt").textContent).toBe("app.birds.example/confirm?token=…");
    expect($<HTMLSelectElement>("#rpSelect").value).toBe("confirm/expired");
    row("reading", "Post page").click();
    await settle();
    expect($("#rpAt").textContent).toBe("app.birds.example/archive/sample-post");
    expect($("#rpNote a").getAttribute("href")).toBe("#/template");
    // The row already shown reads nothing again.
    row("reading", "Post page").click();
    await settle();
    expect(reads()).toEqual([
      "/api/reader-pages/subscribe/form",
      "/api/reader-pages/confirm/expired",
      "/api/reader-pages/reading/post",
    ]);
    expect(frame().srcdoc).toContain("/api/reader-pages/reading/post");
  });

  it("offers the same pages as one grouped select, numbering a journey's steps", async () => {
    await open();
    const select = $<HTMLSelectElement>("#rpSelect");
    expect($$("optgroup", select).map((g) => g.getAttribute("label"))).toEqual([
      "Subscribe",
      "Confirm",
      "Unsubscribe",
      "Reading",
    ]);
    const options = (journey: string) =>
      $$(`optgroup[label='${journey}'] option`, select).map((o) => o.textContent);
    expect(options("Unsubscribe")).toEqual(["1. Ask", "2. Unsubscribed", "Invalid link"]);
    // Reading's pages are peers, so none is numbered.
    expect(options("Reading")).toEqual([
      "Landing page",
      "Archive",
      "Post page",
      "Landing, no posts yet",
      "Archive, no posts yet",
      "Nothing here yet",
    ]);
    select.value = "unsubscribe/invalid";
    select.dispatchEvent(new Event("change"));
    await settle();
    expect(current()).toEqual(["unsubscribe/invalid"]);
    expect(reads().at(-1)).toBe("/api/reader-pages/unsubscribe/invalid");
  });

  it("frames the page at a phone's width on Phone, without reading it again", async () => {
    await open();
    $<HTMLButtonElement>("#rpWidth button[data-width='phone']").click();
    expect($("#rpWidth button[aria-pressed='true']").textContent?.trim()).toBe("Phone");
    expect($("#rpStage").classList.contains("phone")).toBe(true);
    $<HTMLButtonElement>("#rpWidth button[data-width='desktop']").click();
    expect($("#rpStage").classList.contains("phone")).toBe(false);
    expect(reads()).toHaveLength(1);
  });

  it("paints only the latest read when an earlier one answers late", async () => {
    let release: (r: Response) => void = () => {};
    await open([
      {
        path: "/api/reader-pages/subscribe/check-inbox",
        reply: () => new Promise<Response>((r) => (release = r)),
      },
    ]);
    row("subscribe", "Check your inbox").click();
    row("subscribe", "Not an email").click();
    await settle();
    release(page("late"));
    await settle();
    expect(frame().srcdoc).toContain("/api/reader-pages/subscribe/not-an-email");
    expect(frame().srcdoc).not.toContain("late");
  });

  it("says when a page can't be read", async () => {
    await open([
      {
        path: "/api/reader-pages/subscribe/form",
        reply: () => jsonResponse({ error: "boom", message: "down" }, 500),
      },
    ]);
    expect($("#rpError").hidden).toBe(false);
    expect($("#rpError").textContent).toMatch(/Couldn’t load this page/);
  });

  it("empties the frame when a page can't be read, rather than show the last one under the new name", async () => {
    await open([
      {
        path: "/api/reader-pages/confirm/expired",
        reply: () => jsonResponse({ error: "boom", message: "down" }, 500),
      },
    ]);
    expect(frame().srcdoc).toContain("/api/reader-pages/subscribe/form");
    row("confirm", "Expired").click();
    await settle();
    expect($("#rpState").textContent).toBe("Expired");
    expect(frame().srcdoc).toBe("");
    expect($("#rpStage").hidden).toBe(true);
    expect($("#rpError").hidden).toBe(false);
    // The next page that reads comes back in the frame, and the error goes.
    row("confirm", "Ready").click();
    await settle();
    expect(frame().srcdoc).toContain("/api/reader-pages/confirm/ready");
    expect($("#rpStage").hidden).toBe(false);
    expect($("#rpError").hidden).toBe(true);
  });

  it("names each journey's lists by its heading, and keeps the marks out of the rows' names", async () => {
    await open();
    const heading = $("#rpJourney-confirm");
    expect(heading.tagName).toBe("H3");
    const lists = $$(".set-rp-journey[data-journey='confirm'] ul");
    expect(lists[0]?.getAttribute("aria-labelledby")).toBe("rpJourney-confirm");
    expect(lists[1]?.getAttribute("aria-label")).toBe("Confirm, off the main path");
    expect($$(".set-rp-mark").every((m) => m.getAttribute("aria-hidden") === "true")).toBe(true);
  });
});

describe("a reader page's address", () => {
  it("is under the app or the archive as the deployment places them, without a scheme", () => {
    const d = {
      ...deployment,
      app_origin: "https://app.birds.example",
      archive_origin: "https://birds.example",
      archive_base_path: "/letters",
    };
    expect(readerPageAddress({ base: "app", path: "/" }, d)).toBe("app.birds.example/");
    expect(readerPageAddress({ base: "archive", path: "" }, d)).toBe("birds.example/letters");
    expect(readerPageAddress({ base: "archive", path: "/sample-post" }, d)).toBe(
      "birds.example/letters/sample-post",
    );
  });
});
