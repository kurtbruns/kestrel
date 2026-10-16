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

// Open a row's ⋯ menu and choose an item by its label.
function pick(id: string, label: string): void {
  $(`tr[data-id='${id}'] [data-menu]`).click();
  const item = $$(".menu .menu-item").find((b) => b.textContent === label);
  if (!item) {
    throw new Error(`no ${label} in ${id}'s menu`);
  }
  item.click();
}

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
    // A suppressed row keeps its consent status, greyed; an unsuppressed one is not.
    expect($("tr[data-id='s2'] .badge.confirmed").classList.contains("held")).toBe(true);
    // The pills are plain labels: no hover tooltip, which keyboard and touch can't reach.
    expect($$("tr[data-id] .badge[title]")).toHaveLength(0);
    expect($("tr[data-id='s1'] .badge.confirmed").classList.contains("held")).toBe(false);
    expect($("tr[data-id='s3'] td").textContent).toBe("<script>@b.c"); // shown as text
    // A wrapping address breaks before its "@", not mid-word.
    expect($("tr[data-id='s1'] td").innerHTML).toBe("a<wbr>@b.c");
    const menuOf = (id: string) => {
      $(`tr[data-id='${id}'] [data-menu]`).click();
      const items = $$(".menu .menu-item").map((b) => b.textContent);
      document.querySelector<HTMLElement>(".menu-overlay")?.click();
      return items;
    };
    expect(menuOf("s1")).toEqual(["View subscriber", "Unsubscribe", "Block", "Erase"]);
    // Bounced: already suppressed, so nothing to block; a bounce is cleared, not unblocked.
    expect(menuOf("s2")).toEqual(["View subscriber", "Unsubscribe", "Clear", "Erase"]);
    expect(menuOf("s3")).toEqual(["View subscriber", "Block", "Erase"]); // pending: nothing to unsubscribe
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
    pick("s3", "Erase");
    expect($(".modal h3").textContent).toBe("Erase this subscriber?");
    $("#eGo").click();
    await settle();
    expect($("#toasts").textContent).toMatch(/Erased <script>@b\.c/);
    expect($$("tr[data-id]")).toHaveLength(2);
    expect(fake.unhandled).toEqual([]);
  });

  it("filters the list from its summary counts, with the toolbar following, and clears on a second choice", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    const count = (f: string) => $(`#subCounts [data-filter='${f}']`);
    const pressed = () =>
      $$("#subCounts [data-filter]")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.dataset.filter);
    const lastQuery = () => {
      const q = fake.calls.at(-1)!.url.searchParams;
      return [q.get("status"), q.get("suppressed")];
    };
    expect($$("#subCounts [data-filter]").map((b) => b.textContent)).toEqual([
      "2 confirmed",
      "1 pending",
      "0 unsubscribed",
      "1 suppressed",
    ]);
    expect(pressed()).toEqual([]);

    // Suppressed: every suppressed subscriber, whatever their status.
    count("suppressed").click();
    await settle();
    expect(lastQuery()).toEqual([null, "only"]);
    expect($<HTMLInputElement>(".lt-suppressed").checked).toBe(true);
    expect($<HTMLSelectElement>(".lt-status").value).toBe("");
    expect(pressed()).toEqual(["suppressed"]);

    // A status: that status, suppressed or not, so the suppression facet goes.
    count("confirmed").click();
    await settle();
    expect(lastQuery()).toEqual(["confirmed", null]);
    expect($<HTMLInputElement>(".lt-suppressed").checked).toBe(false);
    expect($<HTMLSelectElement>(".lt-status").value).toBe("confirmed");
    expect(pressed()).toEqual(["confirmed"]);

    // Choosing it again shows the whole list.
    count("confirmed").click();
    await settle();
    expect(lastQuery()).toEqual([null, null]);
    expect($<HTMLSelectElement>(".lt-status").value).toBe("");
    expect(pressed()).toEqual([]);

    // A filter set from the toolbar reads on the count it matches, and on none when combined.
    const status = $<HTMLSelectElement>(".lt-status");
    status.value = "pending";
    status.dispatchEvent(new Event("change"));
    await settle();
    expect(pressed()).toEqual(["pending"]);
    const suppressed = $<HTMLInputElement>(".lt-suppressed");
    suppressed.checked = true;
    suppressed.dispatchEvent(new Event("change"));
    await settle();
    expect(pressed()).toEqual([]);
    expect(fake.unhandled).toEqual([]);
  });

  it("keeps focus on a chosen count through the reload, and drops a search so the count is its rows", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    const search = $<HTMLInputElement>(".lt-search");
    search.value = "gmail";
    search.dispatchEvent(new Event("input"));
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    // Under a search, no count is its rows, so none reads as chosen.
    $<HTMLSelectElement>(".lt-status").value = "pending";
    $(".lt-status").dispatchEvent(new Event("change"));
    await settle();
    expect($("#subCounts [data-filter='pending']").getAttribute("aria-pressed")).toBe("false");
    const pending = $<HTMLButtonElement>("#subCounts [data-filter='pending']");
    pending.focus();
    pending.click();
    await settle();
    // Choosing it shows its slice whole: the search goes.
    const q = fake.calls.at(-1)!.url.searchParams;
    expect([q.get("status"), q.get("search")]).toEqual(["pending", null]);
    expect(search.value).toBe("");
    expect(document.activeElement).toBe(pending);
    expect(pending.getAttribute("aria-pressed")).toBe("true");
    expect(fake.unhandled).toEqual([]);
  });

  it("shows the dashboard's Suppressed tile's filter as the suppressed count, chosen", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers("suppressed", r, s));
    await settle();
    expect($("#subCounts [data-filter='suppressed']").getAttribute("aria-pressed")).toBe("true");
    expect($("#subCounts [data-filter='confirmed']").getAttribute("aria-pressed")).toBe("false");
  });

  it("frames Unsubscribe as the reader's request, and points the publisher's own decision to Block (SPEC §7)", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    pick("s1", "Unsubscribe");
    expect($(".modal .hint").textContent).toBe(
      "Use this when a@b.c asks you to take them off the list. They stop receiving posts immediately, and can rejoin by subscribing again. To stop mailing them on your own judgment, block the address instead.",
    );
    expect(fake.unhandled).toEqual([]);
  });

  it("blocks an address as the publisher's own decision, after the dialog's confirmation", async () => {
    let blocked = false;
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({
          counts,
          subscribers: blocked
            ? [{ ...subs[0], suppressed: true, suppression_reason: "manual" }, subs[1], subs[2]]
            : subs,
          page,
        }),
      },
      {
        method: "POST",
        path: "/api/suppressions",
        reply: (req) => {
          blocked = true;
          return {
            suppression: {
              email: (req.json() as { email: string }).email,
              reason: "manual",
              detail: null,
              created_at: 1,
            },
            added: true,
          };
        },
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    pick("s1", "Block");
    expect($(".modal h3").textContent).toBe("Block this address?");
    expect($(".modal .hint").textContent).toBe(
      "Stops all mail to a@b.c, whatever their status, which stays as it is. Use this when you decide yourself to stop mailing them; if they asked to leave, unsubscribe them instead. You can unblock it later.",
    );
    $("#bGo").click();
    await settle();
    expect(fake.calls.find((c) => c.method === "POST")?.json()).toEqual({ email: "a@b.c" });
    expect($("#toasts").textContent).toMatch(/Blocked a@b\.c/);
    expect($("tr[data-id='s1'] .row-flag").textContent).toBe("blocked");
    expect(fake.unhandled).toEqual([]);
  });

  it("says what stands when the address was suppressed before the block landed", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
      {
        method: "POST",
        path: "/api/suppressions",
        reply: () => ({
          suppression: { email: "a@b.c", reason: "bounce", detail: null, created_at: 1 },
          added: false,
        }),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    pick("s1", "Block");
    $("#bGo").click();
    await settle();
    expect($("#toasts").textContent).toMatch(/a@b\.c was already suppressed \(bounced\)/);
    expect(fake.unhandled).toEqual([]);
  });

  it("unblocks only the publisher's own block, saying whether they'll be mailed again", async () => {
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({
          counts,
          subscribers: [
            { ...subs[0], suppressed: true, suppression_reason: "manual" },
            { ...subs[2], suppressed: true, suppression_reason: "manual" },
          ],
          page,
        }),
      },
      {
        method: "DELETE",
        path: /^\/api\/suppressions\/a%40b\.c$/,
        reply: () => ({ email: "a@b.c", cleared: true }),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    pick("s3", "Unblock");
    expect($(".modal .hint").textContent).toBe(
      "Undoes the block on <script>@b.c. They’ll receive posts again only once they’re confirmed.",
    );
    $("#ubCancel").click();
    pick("s1", "Unblock");
    expect($(".modal .hint").textContent).toBe(
      "Undoes the block on a@b.c. They’re confirmed, so they’ll receive your posts again.",
    );
    $("#ubGo").click();
    await settle();
    expect(fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect($("#toasts").textContent).toMatch(/Unblocked a@b\.c/);
    expect(fake.unhandled).toEqual([]);
  });

  it("clears a bounce or complaint only after a Danger confirmation, and never offers it on an erasure's marker (SPEC §7)", async () => {
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({
          counts,
          subscribers: [
            subs[1],
            { ...subs[2], suppressed: true, suppression_reason: "import_complaint" },
            { ...subs[0], suppressed: true, suppression_reason: "erased" },
          ],
          page,
        }),
      },
      {
        method: "DELETE",
        path: /^\/api\/suppressions\/bad%40b\.c$/,
        reply: () => ({ email: "bad@b.c", cleared: true }),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    const menuOf = (id: string) => {
      $(`tr[data-id='${id}'] [data-menu]`).click();
      const items = $$(".menu .menu-item").map((b) => b.textContent);
      document.querySelector<HTMLElement>(".menu-overlay")?.click();
      return items;
    };
    expect(menuOf("s1")).toEqual(["View subscriber", "Unsubscribe", "Erase"]);
    pick("s3", "Clear");
    expect($(".modal h3").textContent).toBe("Clear this complaint?");
    expect($(".modal .hint").textContent).toBe(
      "Lets mail go again to <script>@b.c, an address that reported your mail as spam. Clear it only when they’ve asked you to send them your posts again. They’ll receive posts again only once they’re confirmed.",
    );
    $("#cCancel").click();
    pick("s2", "Clear");
    expect($(".modal h3").textContent).toBe("Clear this bounce?");
    expect($(".modal .hint").textContent).toBe(
      "Lets mail go again to bad@b.c, an address where mail failed. Clear it only when you know the reason is gone, such as a reader who tells you their mailbox is fixed. They’re confirmed, so they’ll receive your posts again.",
    );
    expect($("#cGo").classList.contains("danger")).toBe(true);
    $("#cGo").click();
    await settle();
    expect(fake.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect($("#toasts").textContent).toMatch(/Cleared the bounce on bad@b\.c/);
    expect(fake.unhandled).toEqual([]);
  });

  it("shows a suppressed address's flag and the provider's words in View subscriber", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    $("tr[data-id='s2'] [data-menu]").click();
    $$<HTMLElement>(".menu .menu-item")
      .find((b) => b.textContent === "View subscriber")!
      .click();
    const dt = $$(".modal .sub-dl dt").find((d) => d.textContent === "Suppressed")!;
    expect(dt.nextElementSibling!.textContent).toBe("bounced: 550 no such user");
    $("#vsClose").click();
    // An address that isn't suppressed has no such line.
    $("tr[data-id='s1'] [data-menu]").click();
    $$<HTMLElement>(".menu .menu-item")
      .find((b) => b.textContent === "View subscriber")!
      .click();
    expect($$(".modal .sub-dl dt").map((d) => d.textContent)).not.toContain("Suppressed");
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

  it("defines every pill in a legend the reader opens, which stays as it is while the list reloads", async () => {
    fake = fakeApi([
      { path: "/api/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    const toggle = $(".sub-summary #subLegendToggle");
    const legend = $("#subLegend");
    expect(toggle.textContent).toBe("Legend");
    expect(toggle.getAttribute("aria-controls")).toBe("subLegend");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(legend.hidden).toBe(true);
    // Each pill as the list draws it (its classes), beside its definition; then each act.
    const lists = $$("#subLegend dl");
    expect(lists).toHaveLength(3);
    const rows = $$("dt", lists[0])
      .concat($$("dt", lists[1]))
      .map((dt) => {
        const pill = dt.querySelector(".badge")!;
        return [pill.className, pill.textContent, dt.nextElementSibling!.textContent];
      });
    expect(rows).toEqual([
      [
        "badge confirmed",
        "confirmed",
        "Receives your posts. They confirmed here, or opted in at the service you imported them from.",
      ],
      ["badge pending", "pending", "Subscribed but hasn’t clicked the confirmation email."],
      ["badge unsubscribed", "unsubscribed", "Opted out, themselves or by asking you."],
      [
        "badge suppressed",
        "bounced",
        "Mail to the address failed, here or at the service it was imported from.",
      ],
      [
        "badge suppressed",
        "complaint",
        "Marked as spam, here or at the service it was imported from.",
      ],
      [
        "badge suppressed",
        "blocked",
        "Stopped by hand, by you or at the service it was imported from. You can unblock it.",
      ],
      [
        "badge suppressed",
        "erased",
        "Erased at their request, then signed up again. Only their confirmation email is sent, and confirming lifts this.",
      ],
    ]);
    expect(
      $$("dt", lists[2]).map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]),
    ).toEqual([
      [
        "Unsubscribe",
        "When they ask you to take them off the list. They can rejoin by subscribing again.",
      ],
      [
        "Block",
        "When you decide yourself to stop mailing an address. Their status stays as it was, and you can unblock it.",
      ],
      [
        "Clear",
        "When you know a bounce’s cause is gone, such as a reader who tells you their mailbox is fixed, or when someone who marked your mail as spam asks you for it again. Mail goes again to an address that failed or reported spam.",
      ],
      ["Erase", "When they ask you to delete their data. It can’t be undone."],
    ]);
    expect($$("#subLegend h2").map((h) => h.textContent)).toEqual([
      "Status",
      "Suppressed",
      "What you can do",
    ]);
    expect($$("#subLegend p").map((p) => p.textContent)).toEqual([
      "The address isn’t sent your posts, whatever its status. The status stays as it was, greyed while the suppression keeps it from taking effect. The red flag beside the address says why:",
    ]);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(legend.hidden).toBe(false);
    // A reload repaints only the counts, so a legend the reader opened stays open.
    const status = $<HTMLSelectElement>(".lt-status");
    status.value = "pending";
    status.dispatchEvent(new Event("change"));
    await settle();
    expect(fake.calls.map((c) => c.url.searchParams.get("status"))).toEqual([null, "pending"]);
    expect($("#subLegend")).toBe(legend);
    expect(legend.hidden).toBe(false);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(legend.hidden).toBe(true);
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
    expect(flag.hasAttribute("title")).toBe(false);
    // Their confirmation lifts the marker, so the pending status is live, not greyed.
    expect($("tr[data-id='s3'] .badge.pending").classList.contains("held")).toBe(false);
  });

  it("flags a bounce or complaint an import brought as bounced or complaint, like one seen here", async () => {
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({
          counts,
          subscribers: [
            { ...subs[0], suppressed: true, suppression_reason: "import_bounce" },
            { ...subs[1], suppressed: true, suppression_reason: "import_complaint" },
          ],
          page,
        }),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    expect($("tr[data-id='s1'] .row-flag").textContent).toBe("bounced");
    expect($("tr[data-id='s2'] .row-flag").textContent).toBe("complaint");
    expect($("tr[data-id='s1'] .badge.confirmed").classList.contains("held")).toBe(true);
  });

  it("greys a confirmed status under an erasure's marker, which no confirmation lifts", async () => {
    fake = fakeApi([
      {
        path: "/api/subscribers",
        reply: () => ({
          counts,
          subscribers: [{ ...subs[0], suppressed: true, suppression_reason: "erased" }],
          page,
        }),
      },
    ]);
    await mount((r, s) => renderSubscribers(undefined, r, s));
    await settle();
    expect($("tr[data-id='s1'] .badge.confirmed").classList.contains("held")).toBe(true);
    expect($("tr[data-id='s1'] .badge.confirmed").hasAttribute("title")).toBe(false);
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
