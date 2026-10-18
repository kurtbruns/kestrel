import { beforeEach, describe, expect, it } from "vitest";
import type { ScheduledSendRef } from "../../shared/settings";
import { ApiError } from "../api";
import { $, $$, mount, resetShell, settle } from "../test/support";
import { fmt } from "../ui/format";
import {
  inUseChip,
  isRemakeTooClose,
  REMAKE_TEMPLATE,
  remakeWait,
  savedToast,
  withRemakeConfirm,
} from "./remake";

// The signal of a page that stays mounted throughout.
const live = new AbortController().signal;

const ref = (id: string, subject: string): ScheduledSendRef => ({
  id,
  post_id: `p-${id}`,
  subject,
  fire_at: 1_800_000_000_000,
  remade_at: null,
});
const required = (sends: ScheduledSendRef[]) =>
  new ApiError("ack", 409, { error: "remake_required", message: "ack", sends });
const tooClose = () =>
  new ApiError("sends in 3 minutes", 409, { error: "remake_too_close", retry_after: 1, sends: [] });

/**
 * A write the server refuses with each of `refusals` in turn, then answers "saved". `acks`
 * is what each attempt acknowledged.
 */
function server(...refusals: Error[]) {
  const acks: (string[] | null)[] = [];
  const attempt = async (ack: string[] | null) => {
    acks.push(ack);
    const refusal = refusals.shift();
    if (refusal) {
      throw refusal;
    }
    return "saved";
  };
  return { acks, attempt };
}

describe("withRemakeConfirm", () => {
  beforeEach(() => {
    resetShell();
  });

  it("writes once, asking nothing, when the server needs no acknowledgement", async () => {
    const s = server();
    expect(await withRemakeConfirm(s.attempt, REMAKE_TEMPLATE, live)).toBe("saved");
    expect(s.acks).toEqual([null]);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("asks with the sends the server listed, and retries acknowledging exactly those", async () => {
    const s = server(required([ref("x1", "Gulls"), ref("x2", "")]));
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE, live);
    await settle();
    expect($(".modal h3").textContent).toBe("Apply this change to 2 scheduled emails?");
    expect($(".modal .hint").textContent).toBe(
      "This template is used by 2 posts that are already scheduled. Saving applies the change to their emails too.",
    );
    expect($$(".remake-list li").map((li) => li.textContent)).toEqual([
      `Gullssends ${fmt(1_800_000_000_000)}`,
      `untitledsends ${fmt(1_800_000_000_000)}`,
    ]);
    expect($("#rmGo").textContent).toBe("Save and apply");
    $("#rmGo").click();
    expect(await out).toBe("saved");
    expect(s.acks).toEqual([null, ["x1", "x2"]]);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("asks again with the fresh list when a send was scheduled meanwhile", async () => {
    const s = server(
      required([ref("x1", "Gulls")]),
      required([ref("x1", "Gulls"), ref("x3", "Terns")]),
    );
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE, live);
    await settle();
    $("#rmGo").click();
    await settle();
    expect($(".modal h3").textContent).toBe("Apply this change to 2 scheduled emails?");
    $("#rmGo").click();
    expect(await out).toBe("saved");
    expect(s.acks).toEqual([null, ["x1"], ["x1", "x3"]]);
  });

  it("backs out on Cancel: nothing is retried, and the caller is told so", async () => {
    const s = server(required([ref("x1", "Gulls")]));
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE, live);
    await settle();
    $("#rmCancel").click();
    expect(await out).toBeNull();
    expect(s.acks).toEqual([null]);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("backs out when the dialog is closed without a button", async () => {
    const s = server(required([ref("x1", "Gulls")]));
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE, live);
    await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await out).toBeNull();
    expect(s.acks).toEqual([null]);
  });

  it("backs out when the page goes, taking the dialog with it", async () => {
    const page = new AbortController();
    const s = server(required([ref("x1", "Gulls")]));
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE, page.signal);
    await settle();
    expect(document.querySelector(".modal")).not.toBeNull();
    page.abort();
    expect(await out).toBeNull();
    expect(s.acks).toEqual([null]);
    expect(document.querySelector(".modal")).toBeNull();
    expect($("#toasts").textContent).toBe("Not saved: the change needed your confirmation");
  });

  it("says the save didn't happen, on the next page, when the page went before the server asked", async () => {
    // The save starts on one mounted page; its answer, asking for the acknowledgement,
    // arrives only after another page has mounted, so the dialog never shows.
    let refuse: () => void = () => {};
    const acks: (string[] | null)[] = [];
    const attempt = (ack: string[] | null) => {
      acks.push(ack);
      return new Promise<string>((_, reject) => {
        refuse = () => reject(required([ref("x1", "Gulls")]));
      });
    };
    let out: Promise<string | null> = Promise.resolve(null);
    await mount((_r, signal) => {
      out = withRemakeConfirm(attempt, REMAKE_TEMPLATE, signal);
    });
    await mount((r) => {
      r.textContent = "another page";
    });
    refuse();
    expect(await out).toBeNull();
    expect(acks).toEqual([null]);
    expect(document.querySelector(".modal")).toBeNull();
    expect($("#toasts").textContent).toBe("Not saved: the change needed your confirmation");
    expect($("#app").textContent).toBe("another page");
  });

  it("says nothing more when the publisher cancels on the page", async () => {
    const s = server(required([ref("x1", "Gulls")]));
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE, live);
    await settle();
    $("#rmCancel").click();
    expect(await out).toBeNull();
    expect($("#toasts").textContent).toBe("");
  });

  it("hands any other refusal back to the surface, a send about to fire included", async () => {
    const s = server(tooClose());
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE, live);
    await expect(out).rejects.toSatisfy(isRemakeTooClose);
    expect(document.querySelector(".modal")).toBeNull();
  });
});

describe("isRemakeTooClose", () => {
  it("reads only a 409 with that code", () => {
    expect(isRemakeTooClose(tooClose())).toBe(true);
    expect(isRemakeTooClose(required([]))).toBe(false);
    expect(isRemakeTooClose(new ApiError("x", 400, { error: "remake_too_close" }))).toBe(false);
    expect(isRemakeTooClose(new Error("remake_too_close"))).toBe(false);
  });
});

describe("inUseChip", () => {
  const chip = (in_use: Parameters<typeof inUseChip>[0]) => {
    const el = document.createElement("div");
    el.innerHTML = inUseChip(in_use).markup;
    return el.firstElementChild as HTMLElement;
  };

  it("says nothing is scheduled, or how many posts a change would reach, as a plain label (DESIGN §11)", () => {
    expect(chip(null).textContent?.trim()).toBe("No posts scheduled");
    expect(chip({ sends: [], retry_after: null, identity_fields: [] }).classList).not.toContain(
      "inuse",
    );
    const two = chip({
      sends: [ref("a", "A"), ref("b", "B")],
      retry_after: null,
      identity_fields: [],
    });
    expect(two.textContent).toBe("In use by 2 scheduled posts");
    expect(two.hasAttribute("title")).toBe(false);
    const waiting = chip({
      sends: [ref("a", "A")],
      retry_after: 1_800_000_000_000,
      identity_fields: [],
    });
    expect(waiting.textContent).toBe("In use by 1 scheduled post");
    expect(waiting.hasAttribute("title")).toBe(false);
  });
});

describe("remakeWait", () => {
  const inside = (fireAts: number[], until: number | null) => ({
    sends: fireAts.map((t, i) => ({ ...ref(`s${i}`, `S${i}`), fire_at: t })),
    retry_after: until,
    identity_fields: [],
  });

  it("names when a post about to send has gone, and that a save can follow (SPEC §9)", () => {
    const now = Date.now();
    const at = now + 120_000;
    expect(remakeWait(inside([at, at + 3_600_000], at), now)).toBe(
      `A scheduled post sends at ${fmt(at)}. You can save once it has sent.`,
    );
  });

  it("counts every post inside the lead and names when the last of them sends", () => {
    const now = Date.now();
    const at = now + 120_000;
    expect(remakeWait(inside([now + 60_000, at, at + 3_600_000], at), now)).toBe(
      `2 scheduled posts send by ${fmt(at)}. You can save once they have sent.`,
    );
  });

  it("says nothing with none inside the lead, or once that time has passed", () => {
    const now = Date.now();
    expect(remakeWait(inside([now + 3_600_000], null), now)).toBe("");
    expect(remakeWait(null, now)).toBe("");
    expect(remakeWait(inside([now - 1], now - 1), now)).toBe("");
  });
});

describe("savedToast", () => {
  it("says how many emails a save re-made, and that each needs a fresh test", () => {
    expect(savedToast("Template saved", [])).toBe("Template saved");
    expect(savedToast("Template saved", null)).toBe("Template saved");
    expect(savedToast("Settings saved", [{}])).toBe(
      "Settings saved and applied to 1 scheduled email. Send yourself a test of each.",
    );
    expect(savedToast("Settings saved", [{}, {}])).toMatch(/applied to 2 scheduled emails\./);
  });
});
