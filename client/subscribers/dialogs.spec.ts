import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../state";
import {
  $,
  type FakeApi,
  fakeApi,
  jsonResponse,
  resetShell,
  settingsResponse,
  typeInto,
} from "../test/support";
import { fmt } from "../ui/format";
import {
  addSubscriberModal,
  confirmErase,
  confirmUnsubscribe,
  viewSubscriberModal,
} from "./dialogs";

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
  it("puts the server's refusal of the address under the address field", async () => {
    fake = fakeApi([
      {
        method: "POST",
        path: "/api/subscribers",
        reply: () =>
          jsonResponse(
            { error: "bad_request", message: "That address can’t receive mail.", field: "email" },
            400,
          ),
      },
    ]);
    addSubscriberModal(() => {}, live);
    typeInto($<HTMLInputElement>("#addEmail"), "owl@example.com");
    $("#aGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect($<HTMLInputElement>("#addEmail").classList.contains("is-invalid")).toBe(true);
    expect($("#addEmail + .field-error").textContent).toContain("That address can’t receive mail.");
  });

  it("refuses an address without an @ before asking the API", () => {
    fake = fakeApi([]);
    addSubscriberModal(() => {}, live);
    typeInto($<HTMLInputElement>("#addEmail"), "nope");
    $("#aGo").click();
    expect(fake.calls).toHaveLength(0);
    // On the field, inside the dialog, where the reader is looking.
    const input = $<HTMLInputElement>("#addEmail");
    expect(input.classList.contains("is-invalid")).toBe(true);
    const err = $(".modal .field-error");
    expect(err.textContent).toContain("Enter a valid email address");
    expect(input.getAttribute("aria-describedby")).toBe(err.id);
    expect($("#toasts").textContent).toBe("");
    // Editing the field takes the error away.
    typeInto(input, "nope@example.com");
    expect(document.querySelector(".modal .field-error")).toBeNull();
    expect(input.classList.contains("is-invalid")).toBe(false);
  });

  // DESIGN §4: adding sends a confirmation, so with no provider connected the dialog says
  // so before anything is typed, rather than refusing after.
  it("says a confirmation can't be sent while no provider is connected, with no field and its act disabled", () => {
    appState.appConfig = settingsResponse({ deployment: { provider: "none" } });
    fake = fakeApi([]);
    addSubscriberModal(() => {}, live);
    const line = $(".modal .not-connected");
    expect(line.textContent).toBe(
      "No email provider connected, so a confirmation can’t be sent yet. Connect Amazon SES to add subscribers.",
    );
    expect($<HTMLAnchorElement>("a", line).getAttribute("href")).toBe("#/docs/ses");
    expect(document.querySelector("#addEmail")).toBeNull();
    expect($<HTMLButtonElement>("#aGo").disabled).toBe(true);
    expect(document.activeElement).toBe($("#aCancel"));
    expect(fake.calls).toHaveLength(0);
  });

  describe("an erased address (SPEC §7)", () => {
    const refusal = () =>
      jsonResponse(
        {
          error: "erasure_acknowledgement_required",
          message: "owl@example.com was erased at the person’s request.",
          erased_at: Date.UTC(2026, 9, 3, 12),
        },
        409,
      );

    it("asks first, and sends the confirmation with the acknowledgement once the publisher agrees", async () => {
      fake = fakeApi([
        {
          method: "POST",
          path: "/api/subscribers",
          reply: (req) =>
            (req.json() as { acknowledge_erasure?: boolean }).acknowledge_erasure === true
              ? { subscriber: null, action: "created" }
              : refusal(),
        },
      ]);
      const onDone = vi.fn();
      addSubscriberModal(onDone, live);
      typeInto($<HTMLInputElement>("#addEmail"), "owl@example.com");
      $("#aGo").click();
      await vi.advanceTimersByTimeAsync(0);
      // The question stacks over the Add dialog, naming the address.
      expect(document.querySelectorAll(".modal")).toHaveLength(2);
      expect($("#eaGo").closest(".modal")?.querySelector("strong")?.textContent).toBe(
        "owl@example.com",
      );
      expect($("#eaGo").closest(".modal")?.textContent).toMatch(/erased at the person’s request/);
      $("#eaGo").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.calls.map((c) => JSON.parse(c.body!))).toEqual([
        { email: "owl@example.com" },
        { email: "owl@example.com", acknowledge_erasure: true },
      ]);
      expect(document.querySelector(".modal")).toBeNull();
      expect($("#toasts").textContent).toMatch(/Confirmation sent to owl@example\.com/);
      expect(onDone).toHaveBeenCalledOnce();
    });

    it("sends nothing when the publisher cancels, and leaves the Add dialog open", async () => {
      fake = fakeApi([{ method: "POST", path: "/api/subscribers", reply: refusal }]);
      const onDone = vi.fn();
      addSubscriberModal(onDone, live);
      typeInto($<HTMLInputElement>("#addEmail"), "owl@example.com");
      $("#aGo").click();
      await vi.advanceTimersByTimeAsync(0);
      $("#eaCancel").click();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.calls).toHaveLength(1);
      expect(document.querySelectorAll(".modal")).toHaveLength(1);
      expect($<HTMLButtonElement>("#aGo").disabled).toBe(false);
      expect(onDone).not.toHaveBeenCalled();
    });
  });

  it("takes an address as usual once a provider is set, and on the local stand-in", () => {
    for (const provider of ["ses", "fake"] as const) {
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
    origin: "kestrel",
    opt_in: "double" as const,
    consent_evidence: null,
    import_id: null,
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

  it("erases only after a Danger confirmation that says it can't be undone, and says a bounce stands", async () => {
    fake = fakeApi([
      {
        method: "POST",
        path: "/api/subscribers/s1/erase",
        reply: () => ({ erased: { email: "a@b.c", deliveries: 3, suppression: "bounce" } }),
      },
    ]);
    const onDone = vi.fn();
    confirmErase(sub, onDone, live);
    expect($(".modal strong").textContent).toBe("a@b.c");
    expect($(".modal .hint").textContent).toMatch(/can’t be undone/);
    expect($("#eGo").classList.contains("danger")).toBe(true);
    expect(fake.calls).toEqual([]);
    $("#eGo").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /api/subscribers/s1/erase",
    ]);
    expect($("#toasts").textContent).toMatch(/Erased a@b\.c\. Its bounce still stands/);
    expect(onDone).toHaveBeenCalledOnce();
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

describe("viewSubscriberModal", () => {
  const signedUp = {
    id: "s2",
    email: "left@b.c",
    status: "unsubscribed" as const,
    confirm_token: null,
    confirm_sent_at: 1,
    confirm_attempt_at: 1,
    unsub_token: "t",
    created_at: 1,
    confirmed_at: null,
    unsubscribed_at: 3,
    origin: "kestrel",
    opt_in: "double" as const,
    consent_evidence: null,
    import_id: null,
  };

  /** The subscriber's rows, label to value, as the dialog shows them. */
  const recordRows = () => {
    const dts = [...document.querySelectorAll(".sub-dl dt")];
    return Object.fromEntries(
      dts.map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]),
    );
  };

  it("dates every subscriber Joined, as the roster does, and says an import's confirmation date is the file's (SPEC §7)", () => {
    fake = fakeApi([]);
    const importedAt = Date.UTC(2026, 9, 13, 12);
    const fileSaid = Date.UTC(2024, 2, 1, 9, 30);
    viewSubscriberModal(
      {
        ...signedUp,
        status: "confirmed",
        created_at: importedAt,
        confirmed_at: fileSaid,
        unsubscribed_at: null,
        origin: "sendy",
        opt_in: "single",
        import_id: "imp1",
      },
      live,
    );
    const rows = recordRows();
    expect(rows.Joined).toBe(fmt(importedAt));
    expect(rows.Confirmed).toBe(fmt(fileSaid));
    expect("Imported" in rows || "Subscribed" in rows).toBe(false);
    expect($(".sub-note").textContent).toBe(
      "The origin, opt-in, confirmation date, and evidence are what the imported file said, not something Kestrel recorded itself.",
    );
    $("#vsClose").click();
    // Someone who joined here reads the same way, with no line about a file.
    viewSubscriberModal({ ...signedUp, status: "confirmed", created_at: 5, confirmed_at: 6 }, live);
    const here = recordRows();
    expect(here.Joined).toBe(fmt(5));
    expect("Imported" in here || "Subscribed" in here).toBe(false);
    expect(document.querySelector(".sub-note")).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("says a reader who signed up here and left never confirmed, and a pending one hasn't yet", () => {
    fake = fakeApi([]);
    viewSubscriberModal(signedUp, live);
    expect($(".sub-dl dd").textContent).toBe("Signed up here, never confirmed");
    expect($(".sub-dl").textContent).toContain("None recorded");
    $("#vsClose").click();
    viewSubscriberModal({ ...signedUp, status: "pending", unsubscribed_at: null }, live);
    expect($(".sub-dl dd").textContent).toBe("Signed up here, not confirmed yet");
    expect(fake.calls).toEqual([]);
  });
});
