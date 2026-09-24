import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, $$, type FakeApi, fakeApi, mount, resetShell, settle, typeInto } from "../test/support";
import { addSubscriberModal } from "./dialogs";
import { renderSubscribers } from "./list";

const page = { total: 3, limit: 50, offset: 0, sort: "joined", dir: "desc" };
const counts = { pending: 1, confirmed: 2, unsubscribed: 0, suppressed: 1, audience: 1 };
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
    vi.useRealTimers();
  });

  it("shows the counts, the roster with the suppression flag and its reason, and actions only for the confirmed", async () => {
    fake = fakeApi([{ path: "/subscribers", reply: () => ({ counts, subscribers: subs, page }) }]);
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
        path: "/subscribers",
        reply: () => ({ counts, subscribers: [], page: { ...page, total: 0 } }),
      },
    ]);
    await mount((r, s) => renderSubscribers("suppressed", r, s));
    await settle();
    expect(fake.calls[0]?.url.searchParams.get("suppressed")).toBe("only");
    expect($<HTMLSelectElement>(".lt-suppressed").value).toBe("only");
    expect($("#subList").textContent).toMatch(/No subscribers match/);
  });

  it("opens the Confirmed tile's link as who a send reaches: confirmed, suppressed hidden", async () => {
    fake = fakeApi([
      {
        path: "/subscribers",
        reply: () => ({ counts, subscribers: [], page: { ...page, total: 0 } }),
      },
    ]);
    await mount((r, s) => renderSubscribers("audience", r, s));
    await settle();
    const q = fake.calls[0]?.url.searchParams;
    expect(q?.get("status")).toBe("confirmed");
    expect(q?.get("suppressed")).toBe("hide");
    expect($<HTMLSelectElement>(".lt-status").value).toBe("confirmed");
    expect($<HTMLSelectElement>(".lt-suppressed").value).toBe("hide");
    expect(fake.unhandled).toEqual([]);
  });

  it("adds a subscriber through the double opt-in and says what happened", async () => {
    fake = fakeApi([
      { path: "/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
      {
        method: "POST",
        path: "/subscribers",
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

  for (const [action, said] of [
    ["suppressed", /new@b\.c is suppressed, so no confirmation was sent/],
    ["recently_sent", /A confirmation went to new@b\.c a few minutes ago/],
    ["created", /Confirmation sent to new@b\.c/],
  ] as const) {
    it(`says what the Add did when the API answers ${action}`, async () => {
      fake = fakeApi([
        { path: "/subscribers", reply: () => ({ counts, subscribers: subs, page }) },
        { method: "POST", path: "/subscribers", reply: () => ({ subscriber: null, action }) },
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

  it("refuses an address without an @ before asking the API", () => {
    fake = fakeApi([]);
    addSubscriberModal();
    typeInto($<HTMLInputElement>("#addEmail"), "nope");
    $("#aGo").click();
    expect(fake.calls).toHaveLength(0);
    expect($("#toasts").textContent).toMatch(/valid email/);
    document.querySelector(".modal-backdrop")?.remove();
  });
});
