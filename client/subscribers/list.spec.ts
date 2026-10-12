import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { $, $$, type FakeApi, fakeApi, mount, resetShell, settle, typeInto } from "../test/support";
import { renderSubscribers } from "./list";

const page = { total: 3, limit: 50, offset: 0, sort: "joined", dir: "desc" };
const counts = { pending: 1, confirmed: 2, unsubscribed: 0, suppressed: 1 };
const subs = [
  {
    id: "s1",
    email: "a@b.c",
    status: "confirmed",
    created_at: 1,
    suppressed: false,
    suppression_reason: null,
    suppression_detail: null,
  },
  {
    id: "s2",
    email: "bad@b.c",
    status: "confirmed",
    created_at: 2,
    suppressed: true,
    suppression_reason: "bounce",
    suppression_detail: "550 no such user",
  },
  {
    id: "s3",
    email: "<script>@b.c",
    status: "pending",
    created_at: 3,
    suppressed: false,
    suppression_reason: null,
    suppression_detail: null,
  },
];

describe("subscribers view", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    location.hash = "#/subscribers";
  });
  afterEach(() => {
    fake?.restore();
  });

  it("shows the counts, the roster with the suppression flag and its reason, and actions only for the confirmed", async () => {
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
    expect($$("tr[data-id='s1'] [data-menu]")).toHaveLength(1);
    expect($$("tr[data-id='s3'] [data-menu]")).toHaveLength(0); // pending: nothing to unsubscribe
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
});
