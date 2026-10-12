import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../state";
import { $, type FakeApi, fakeApi, resetShell, settingsResponse, typeInto } from "../test/support";
import { addSubscriberModal, confirmUnsubscribe } from "./dialogs";

// The signal of a page that stays mounted throughout.
const live = new AbortController().signal;

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
    addSubscriberModal(() => {}, live);
    typeInto($<HTMLInputElement>("#addEmail"), "nope");
    $("#aGo").click();
    expect(fake.calls).toHaveLength(0);
    expect($("#toasts").textContent).toMatch(/valid email/);
  });

  // DESIGN §2: adding sends a confirmation, so with no provider connected the dialog says
  // so before anything is typed, rather than refusing after.
  it("says a confirmation can't be sent while no provider is connected, with no field and its act disabled", () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    fake = fakeApi([]);
    addSubscriberModal(() => {}, live);
    const line = $(".modal .not-connected");
    expect(line.textContent).toBe(
      "No email provider connected, so a confirmation can’t be sent yet. Connect an email provider to add subscribers.",
    );
    expect($<HTMLAnchorElement>("a", line).getAttribute("href")).toBe("#/docs/resend");
    expect(document.querySelector("#addEmail")).toBeNull();
    expect($<HTMLButtonElement>("#aGo").disabled).toBe(true);
    expect(document.activeElement).toBe($("#aCancel"));
    expect(fake.calls).toHaveLength(0);
  });

  it("takes an address as usual once a provider is set, and on the local stand-in", () => {
    for (const provider of ["resend", "fake"] as const) {
      appState.appConfig = settingsResponse({ deployment: { provider } });
      fake = fakeApi([]);
      addSubscriberModal(() => {}, live);
      expect(document.querySelector(".modal .not-connected"), provider).toBeNull();
      expect($<HTMLButtonElement>("#aGo").disabled, provider).toBe(false);
      expect(document.activeElement, provider).toBe($("#addEmail"));
      $("#aCancel").click();
      fake.restore();
    }
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
    confirmUnsubscribe(sub, onDone, live);
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
    confirmUnsubscribe(sub, onDone, live);
    $("#uCancel").click();
    expect(document.querySelector(".modal")).toBeNull();
    expect(fake.calls).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });
});
