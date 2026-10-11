import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, type FakeApi, fakeApi, resetShell, typeInto } from "../test/support";
import { addSubscriberModal, confirmUnsubscribe } from "./dialogs";

let fake: FakeApi;
beforeEach(() => {
  resetShell();
  vi.useFakeTimers();
});
afterEach(() => {
  fake?.restore();
  vi.useRealTimers();
});

describe("addSubscriberModal", () => {
  it("refuses an address without an @ before asking the API", () => {
    fake = fakeApi([]);
    addSubscriberModal();
    typeInto($<HTMLInputElement>("#addEmail"), "nope");
    $("#aGo").click();
    expect(fake.calls).toHaveLength(0);
    expect($("#toasts").textContent).toMatch(/valid email/);
  });
});

describe("confirmUnsubscribe", () => {
  const sub = {
    id: "s1",
    email: "a@b.c",
    status: "confirmed" as const,
    confirm_token: null,
    confirm_sent_at: 1,
    confirm_attempt_at: 1,
    unsub_token: "t",
    created_at: 1,
    confirmed_at: 2,
    unsubscribed_at: null,
  };

  it("names the address, unsubscribes on confirm, and tells the caller", async () => {
    fake = fakeApi([
      { method: "POST", path: "/api/subscribers/s1/unsubscribe", reply: () => ({}) },
    ]);
    const onDone = vi.fn();
    confirmUnsubscribe(sub, onDone);
    expect($(".modal strong").textContent).toBe("a@b.c");
    $("#uGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/subscribers/s1/unsubscribe",
    ]);
    expect(onDone).toHaveBeenCalledOnce();
    expect($("#toasts").textContent).toMatch(/Unsubscribed a@b\.c/);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("cancels without a call", () => {
    fake = fakeApi([]);
    const onDone = vi.fn();
    confirmUnsubscribe(sub, onDone);
    $("#uCancel").click();
    expect(document.querySelector(".modal")).toBeNull();
    expect(fake.calls).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });
});
