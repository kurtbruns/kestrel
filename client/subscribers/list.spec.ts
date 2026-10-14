import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ExportRow, toImportCsv } from "../../shared/imports";
import type { SubscriberListItem } from "../../shared/subscribers";
import {
  $,
  $$,
  captureDownloads,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
  typeInto,
} from "../test/support";
import { renderSubscribers } from "./list";

const page = { total: 3, limit: 50, offset: 0, sort: "joined", dir: "desc" };
const counts = { pending: 1, confirmed: 2, unsubscribed: 0, suppressed: 1 };
/** A row of the list as the API answers it: someone who confirmed here, unless `over` says otherwise. */
const subscriber = (over: Partial<SubscriberListItem>): SubscriberListItem => ({
  id: "s0",
  email: "reader@b.c",
  status: "confirmed",
  confirm_token: null,
  confirm_sent_at: null,
  confirm_attempt_at: null,
  unsub_token: "u",
  created_at: 1,
  confirmed_at: 1,
  unsubscribed_at: null,
  origin: "kestrel",
  opt_in: "double",
  consent_evidence: null,
  import_id: null,
  suppressed: false,
  suppression_reason: null,
  suppression_detail: null,
  ...over,
});
const subs = [
  subscriber({
    id: "s1",
    email: "a@b.c",
    origin: "sendy",
    opt_in: "single",
    import_id: "imp1",
    consent_evidence: '{"signup_ip":"203.0.113.7"}',
  }),
  subscriber({
    id: "s2",
    email: "bad@b.c",
    created_at: 2,
    suppressed: true,
    suppression_reason: "bounce",
    suppression_detail: "550 no such user",
  }),
  subscriber({
    id: "s3",
    email: "<script>@b.c",
    status: "pending",
    created_at: 3,
    confirmed_at: null,
  }),
];

describe("subscribers view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    location.hash = "#/subscribers";
  });
  afterEach(() => {
    fake?.restore();
    vi.restoreAllMocks();
  });

  it("shows the counts, the roster with the suppression flag and its reason, and the actions each row allows", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    expect($("#subCounts").textContent).toMatch(
      /2 confirmed.*1 pending.*0 unsubscribed.*1 suppressed/,
    );
    expect($$("tr[data-id]")).toHaveLength(3);
    const flag = $("tr[data-id='s2'] .row-flag");
    expect(flag.textContent).toBe("bounced");
    expect(flag.getAttribute("title")).toMatch(/Hard bounce.*\(550 no such user\)/);
    expect($("tr[data-id='s3'] td").textContent).toBe("<script>@b.c"); // shown as text
    const menuOf = (id: string) => {
      $(`tr[data-id='${id}'] [data-menu]`).click();
      const items = $$(".menu .menu-item").map((b) => b.textContent);
      document.querySelector<HTMLElement>(".menu-overlay")?.click();
      return items;
    };
    expect(menuOf("s1")).toEqual(["View subscriber", "Unsubscribe", "Erase"]);
    expect(menuOf("s3")).toEqual(["View subscriber", "Erase"]); // pending: nothing to unsubscribe
    expect(fake.unhandled).toEqual([]);
  });

  it("erases from the row menu after the dialog's confirmation, and reloads the list", async () => {
    let erased = false;
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({
          counts,
          subscribers: erased ? subs.filter((s) => s.id !== "s3") : subs,
          page,
        }),
      },
      {
        method: "POST",
        path: "/api/subscribers/s3/erase",
        reply: () => {
          erased = true;
          return { erased: { email: "<script>@b.c", deliveries: 0, suppression: "erased" } };
        },
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    $("tr[data-id='s3'] [data-menu]").click();
    $(".menu .danger-item").click();
    expect($(".modal h3").textContent).toBe("Erase this subscriber?");
    $("#eGo").click();
    await settle();
    expect($("#toasts").textContent).toMatch(/Erased <script>@b\.c/);
    expect($$("tr[data-id]")).toHaveLength(2);
    expect(fake.unhandled).toEqual([]);
  });

  it("says how each subscriber joined, keyed on the import, never the file's claim (SPEC §7)", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    expect($$("thead th").map((th) => th.textContent)).toContain("How they joined");
    expect($("tr[data-id='s1'] td.how").textContent).toBe("Imported · Sendy, single opt-in");
    expect($("tr[data-id='s2'] td.how").textContent).toBe("Double opt-in");
    // Pending and never confirmed here: nothing to say yet, and the stacked row drops the cell.
    expect($("tr[data-id='s3'] td.how").classList.contains("empty")).toBe(true);
    // View subscriber shows the evidence on request, under the address.
    $("tr[data-id='s1'] [data-menu]").click();
    $$<HTMLButtonElement>(".menu .menu-item")[0]?.click();
    expect($(".modal h3").textContent).toBe(subs[0]?.email);
    expect($(".modal .hint").textContent).toBe("Confirmed");
    expect($(".modal").textContent).toContain("Imported · Sendy, single opt-in");
    expect($(".sub-evidence").textContent).toBe('{\n  "signup_ip": "203.0.113.7"\n}');
    expect($(".modal").textContent).toContain("not something Kestrel recorded itself.");
    expect(fake.unhandled).toEqual([]);
  });

  it("names an erased address's flag, for one that subscribed again", async () => {
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({
          counts,
          subscribers: [
            { ...subs[2], suppressed: true, suppression_reason: "erased", status: "pending" },
          ],
          page,
        }),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    const flag = $("tr[data-id='s3'] .row-flag");
    expect(flag.textContent).toBe("erased");
    expect(flag.getAttribute("title")).toMatch(/^Erased at the person’s request/);
  });

  it("points a list with no subscribers (suppressions alone count for none) at the import, and opens the import from the head", async () => {
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({
          counts: { pending: 0, confirmed: 0, unsubscribed: 0, suppressed: 2 },
          subscribers: [],
          page: { ...page, total: 0 },
        }),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    expect($("#subList").textContent).toBe(
      "No subscribers yet. Import your list from another service, or share your subscribe page.",
    );
    expect($<HTMLAnchorElement>("#subList a").getAttribute("href")).toBe("#/subscribers/import");
    expect($$(".page-head button").map((b) => [b.textContent, b.className])).toEqual([
      ["Import", "ghost"],
      ["Export", "ghost"],
      ["Add subscriber", "primary"],
    ]);
    $("#importSubs").click();
    expect(location.hash).toBe("#/subscribers/import");
  });

  it("keeps a list whose only subscribers have unsubscribed from reading as empty", async () => {
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({
          counts: { pending: 0, confirmed: 0, unsubscribed: 2, suppressed: 0 },
          subscribers: [],
          page: { ...page, total: 0 },
        }),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    // Nothing matches the filter, but the list has people on it: no invitation to import.
    expect($("#subList").textContent).toBe("No subscribers match.");
    expect(fake.unhandled).toEqual([]);
  });

  it("seeds the filter from the dashboard's deep link", async () => {
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({ counts, subscribers: [], page: { ...page, total: 0 } }),
      },
    ]);
    await mount((r, s) => renderSubscribers("suppressed", r, s));
    await settle();
    expect(fake.calls[0]?.url.searchParams.get("suppressed")).toBe("only");
    expect($<HTMLInputElement>(".lt-suppressed").checked).toBe(true);
    expect($("#subList").textContent).toMatch(/No subscribers match/);
  });

  it("adds a subscriber through the double opt-in and says what happened", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
      {
        method: "POST",
        path: "/api/subscribers",
        reply: (req) => ({
          subscriber: { id: "s9", email: (req.json() as { email: string }).email },
          action: "already_confirmed",
        }),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    $("#addSub").click();
    typeInto($<HTMLInputElement>("#addEmail"), "new@b.c");
    $("#aGo").click();
    await settle();
    expect(fake.calls.find((c) => c.method === "POST")?.body).toBe(`{"email":"new@b.c"}`);
    expect($("#toasts").textContent).toMatch(/new@b\.c is already confirmed/);
    expect(document.querySelector(".modal")).toBeNull();
  });

  // A dialog and a menu belong to the page that opened them: the next page mounting (Back,
  // a changed URL) takes them away, so neither is left acting over a page it isn't for.
  const nextPage = () =>
    mount((r) => {
      r.textContent = "another page";
    });

  it("takes the Add subscriber dialog away when another page mounts", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    $("#addSub").click();
    expect(document.querySelector(".modal")).not.toBeNull();
    await nextPage();
    expect(document.querySelector(".modal")).toBeNull();
    expect(document.querySelector(".modal-backdrop")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("takes the row-action menu away when another page mounts", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    $("tr[data-id='s1'] [data-menu]").click();
    expect(document.querySelector(".menu")).not.toBeNull();
    await nextPage();
    expect(document.querySelector(".menu")).toBeNull();
    expect(document.querySelector(".menu-overlay")).toBeNull();
    expect(fake.unhandled).toEqual([]);
  });

  it("lands a write the dialog started, though the page and the dialog have gone", async () => {
    let answer: (v: unknown) => void = () => {};
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
      {
        method: "POST",
        path: "/api/subscribers/s1/unsubscribe",
        reply: () => new Promise((resolve) => (answer = resolve)),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    $("tr[data-id='s1'] [data-menu]").click();
    $(".menu .danger-item").click();
    $("#uGo").click();
    await settle();
    await nextPage();
    expect(document.querySelector(".modal")).toBeNull();
    answer({});
    await settle();
    // The write was never cut off: it answered, and the publisher is told it landed.
    const write = fake.calls.filter((c) => c.method === "POST");
    expect(write.map((c) => c.url.pathname)).toEqual(["/api/subscribers/s1/unsubscribe"]);
    expect($("#toasts").textContent).toMatch(/Unsubscribed a@b\.c/);
    expect($("#app").textContent).toBe("another page");
    expect(fake.unhandled).toEqual([]);
  });

  for (const [action, said] of [
    ["suppressed", /new@b\.c is suppressed, so no confirmation was sent/],
    ["recently_sent", /A confirmation went to new@b\.c a few minutes ago/],
    ["created", /Confirmation sent to new@b\.c/],
  ] as const) {
    it(`says what the Add did when the API answers ${action}`, async () => {
      fake = fakeApi([
        { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
        { method: "POST", path: "/api/subscribers", reply: () => ({ subscriber: null, action }) },
      ]);
      await mount((r, s) => renderSubscribers(undefined, r, s));
      await settle();
      $("#addSub").click();
      typeInto($<HTMLInputElement>("#addEmail"), "new@b.c");
      $("#aGo").click();
      await settle();
      expect($("#toasts").textContent).toMatch(said);
    });
  }

  const exportRow = (email: string, over: Partial<ExportRow> = {}): ExportRow => ({
    email,
    status: "subscribed",
    opt_in: "double",
    origin: "kestrel",
    suppression: null,
    subscribed_at: "2026-01-02T09:30:00.000Z",
    confirmed_at: "2026-01-02T09:42:00.000Z",
    unsubscribed_at: null,
    suppressed_at: null,
    evidence: null,
    format: "kestrel-subscribers/1",
    ...over,
  });

  it("exports the whole list as one CSV in the import format, following every page (SPEC §7)", async () => {
    const exportedAt = Date.UTC(2026, 0, 15, 9);
    const pages: Record<string, { rows: ExportRow[]; next: string | null }> = {
      "": { rows: [exportRow("ada@example.com")], next: "c1" },
      c1: { rows: [exportRow("=cmd@example.com", { status: "unsubscribed" })], next: "c2" },
      c2: {
        rows: [exportRow("gone@example.com", { status: "none", suppression: "bounce" })],
        next: null,
      },
    };
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
      {
        path: "/api/subscribers/export",
        reply: (req) => {
          const p = pages[req.url.searchParams.get("after") ?? ""];
          return {
            format: "kestrel-subscribers/1",
            exported_at: exportedAt,
            subscribers: p?.rows ?? [],
            next: p?.next ?? null,
          };
        },
      },
    ]);
    const saved = captureDownloads();
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    $("#exportSubs").click();
    await settle();
    const reads = fake.calls.filter((c) => c.url.pathname === "/api/subscribers/export");
    expect(reads.map((c) => c.url.searchParams.get("after"))).toEqual([null, "c1", "c2"]);
    expect(saved.map((f) => f.name)).toEqual(["kestrel-subscribers-2026-01-15.csv"]);
    // One header, then every page's rows, through the writer the server documents.
    expect(await saved[0]?.blob.text()).toBe(
      toImportCsv([...pages[""]!.rows, ...pages.c1!.rows, ...pages.c2!.rows]),
    );
    expect($<HTMLButtonElement>("#exportSubs").disabled).toBe(false);
    expect(fake.unhandled).toEqual([]);
  });

  it("stops an export whose next page names the page just read, rather than loop", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
      {
        path: "/api/subscribers/export",
        reply: () => ({
          format: "kestrel-subscribers/1",
          exported_at: Date.now(),
          subscribers: [exportRow("ada@example.com")],
          next: "c1",
        }),
      },
    ]);
    const saved = captureDownloads();
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    $("#exportSubs").click();
    await settle();
    expect(fake.calls.filter((c) => c.url.pathname === "/api/subscribers/export")).toHaveLength(2);
    expect(saved).toEqual([]);
    expect($("#toasts").textContent).toBe("The export repeated a page. Try again.");
  });

  it("says why an export failed, and saves no partial file", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
      {
        path: "/api/subscribers/export",
        reply: (req) =>
          req.url.searchParams.has("after")
            ? jsonResponse({ error: "internal_error", message: "database unavailable" }, 500)
            : {
                format: "kestrel-subscribers/1",
                exported_at: Date.now(),
                subscribers: [exportRow("ada@example.com")],
                next: "c1",
              },
      },
    ]);
    const saved = captureDownloads();
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    $("#exportSubs").click();
    await settle();
    expect(saved).toEqual([]);
    expect($("#toasts").textContent).toBe("database unavailable");
    expect(fake.unhandled).toEqual([]);
  });
});
