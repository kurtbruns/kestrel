import { beforeEach, describe, expect, it } from "vitest";
import type { ScheduledSendRef } from "../../shared/settings";
import { ApiError } from "../api";
import { $, $$, resetShell, settle } from "../test/support";
import { fmt } from "../ui/format";
import {
  inUseChip,
  isRemakeTooClose,
  REMAKE_TEMPLATE,
  savedToast,
  withRemakeConfirm,
} from "./remake";

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
    expect(await withRemakeConfirm(s.attempt, REMAKE_TEMPLATE)).toBe("saved");
    expect(s.acks).toEqual([null]);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("asks with the sends the server listed, and retries acknowledging exactly those", async () => {
    const s = server(required([ref("x1", "Gulls"), ref("x2", "")]));
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE);
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
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE);
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
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE);
    await settle();
    $("#rmCancel").click();
    expect(await out).toBeNull();
    expect(s.acks).toEqual([null]);
    expect(document.querySelector(".modal")).toBeNull();
  });

  it("backs out when the dialog is closed without a button", async () => {
    const s = server(required([ref("x1", "Gulls")]));
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE);
    await settle();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await out).toBeNull();
    expect(s.acks).toEqual([null]);
  });

  it("hands any other refusal back to the surface, a send about to fire included", async () => {
    const s = server(tooClose());
    const out = withRemakeConfirm(s.attempt, REMAKE_TEMPLATE);
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
  const chip = (inUse: Parameters<typeof inUseChip>[0]) => {
    const el = document.createElement("div");
    el.innerHTML = inUseChip(inUse).markup;
    return el.firstElementChild as HTMLElement;
  };

  it("says nothing is scheduled, or how many posts a change would reach and when saving waits", () => {
    expect(chip(null).textContent?.trim()).toBe("No posts scheduled");
    expect(chip({ sends: [], retry_after: null, identityFields: [] }).classList).not.toContain(
      "inuse",
    );
    const two = chip({
      sends: [ref("a", "A"), ref("b", "B")],
      retry_after: null,
      identityFields: [],
    });
    expect(two.textContent).toBe("In use by 2 scheduled posts");
    expect(two.hasAttribute("title")).toBe(false);
    const waiting = chip({
      sends: [ref("a", "A")],
      retry_after: 1_800_000_000_000,
      identityFields: [],
    });
    expect(waiting.textContent).toBe("In use by 1 scheduled post");
    expect(waiting.title).toBe(
      `One sends at ${fmt(1_800_000_000_000)}; saving waits until it has sent.`,
    );
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
