import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  $,
  $$,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
  unmount,
} from "../test/support";
import { html, setHtml } from "../ui/html";
import { mountReaderPages, readerPagesSection } from "./reader_pages";

const page = (name: string) => new Response(`<html><head></head><body>${name}</body></html>`);

describe("reader pages section", () => {
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
      mountReaderPages(root, signal);
    });
    await settle();
  }

  const reads = () => fake.calls.map((c) => c.url.pathname);
  const frame = () => $<HTMLIFrameElement>("#rpFrame");
  const labels = (sel: string) => $$(`${sel} button`).map((b) => b.textContent);
  const pressed = (sel: string) =>
    $$(`${sel} button[aria-pressed="true"]`).map((b) => b.textContent);
  const click = (sel: string, label: string) =>
    $$<HTMLButtonElement>(`${sel} button`)
      .find((b) => b.textContent === label)
      ?.click();

  it("opens on the subscribe form, framed so no form on it submits", async () => {
    await open();
    expect(labels("#rpJourneys")).toEqual(["Subscribe", "Confirm", "Unsubscribe", "Reading"]);
    expect(pressed("#rpJourneys")).toEqual(["Subscribe"]);
    expect(labels("#rpStates")).toEqual(["Form", "Check your inbox", "Not an email"]);
    expect($("#rpNote").textContent).toMatch(/Your name, tagline, and logo head each page/);
    expect(reads()).toEqual(["/api/reader-pages/subscribe/form"]);
    expect(frame().srcdoc).toContain("/api/reader-pages/subscribe/form");
    expect(frame().srcdoc).toContain("form-action 'none'");
    // The sandbox leaves out forms and scripts.
    expect(frame().getAttribute("sandbox")).toBe("allow-same-origin");
    expect(fake.unhandled).toEqual([]);
  });

  it("shows a journey's states, and returns to the state last picked in it", async () => {
    await open();
    click("#rpJourneys", "Confirm");
    await settle();
    expect(labels("#rpStates")).toEqual(["Ready", "Confirmed", "Expired", "Invalid link"]);
    expect($("#rpNote").textContent).toMatch(/what a reader agrees to can’t be edited away/);
    click("#rpStates", "Expired");
    await settle();
    expect(pressed("#rpStates")).toEqual(["Expired"]);
    click("#rpJourneys", "Reading");
    await settle();
    expect($("#rpNote a").getAttribute("href")).toBe("#/template");
    click("#rpJourneys", "Confirm");
    await settle();
    expect(pressed("#rpStates")).toEqual(["Expired"]);
    expect(reads()).toEqual([
      "/api/reader-pages/subscribe/form",
      "/api/reader-pages/confirm/ready",
      "/api/reader-pages/confirm/expired",
      "/api/reader-pages/reading/landing",
      "/api/reader-pages/confirm/expired",
    ]);
    expect(frame().srcdoc).toContain("/api/reader-pages/confirm/expired");
  });

  it("frames the page at a phone's width on Phone, without reading it again", async () => {
    await open();
    click("#rpWidth", "Phone");
    expect(pressed("#rpWidth")).toEqual(["Phone"]);
    expect($("#rpStage").classList.contains("phone")).toBe(true);
    click("#rpWidth", "Desktop");
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
    click("#rpStates", "Check your inbox");
    click("#rpStates", "Not an email");
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
});
