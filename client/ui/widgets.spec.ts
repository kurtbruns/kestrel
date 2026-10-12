import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetShell } from "../test/support";
import { $ } from "./dom";
import { html } from "./html";
import { fieldError, modal, openMenu, toast } from "./widgets";

// The signal of a view that stays mounted throughout.
const live = new AbortController().signal;

// What the reader sees: the toasts still showing, oldest first, leaving ones excluded.
const showing = (): string[] =>
  [...$("#toasts").querySelectorAll(".toast:not(.leaving)")].map((t) => t.textContent ?? "");

describe("toast (DESIGN §5)", () => {
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fades after its time and then leaves the region", () => {
    toast("Saved");
    expect(showing()).toEqual(["Saved"]);
    vi.advanceTimersByTime(3600);
    expect(showing()).toEqual([]);
    expect($("#toasts").children.length).toBe(1); // still collapsing
    vi.advanceTimersByTime(300);
    expect($("#toasts").children.length).toBe(0);
  });

  it("restarts a message already showing instead of stacking a second copy", () => {
    toast("Copied");
    vi.advanceTimersByTime(3000);
    toast("Copied");
    expect(showing()).toEqual(["Copied"]);
    vi.advanceTimersByTime(3000); // past the first one's time, inside the restart's
    expect(showing()).toEqual(["Copied"]);
    vi.advanceTimersByTime(600);
    expect(showing()).toEqual([]);
  });

  it("shows at most three, the oldest leaving early for a new one", () => {
    for (const m of ["One", "Two", "Three", "Four", "Five"]) {
      toast(m);
    }
    expect(showing()).toEqual(["Three", "Four", "Five"]);
    vi.advanceTimersByTime(300);
    expect($("#toasts").children.length).toBe(3);
  });
});

const pressEscape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

describe("modal", () => {
  beforeEach(() => {
    resetShell();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes on Escape", () => {
    const m = modal(html`<p>Sure?</p>`, live);
    expect(m.el.isConnected).toBe(true);
    pressEscape();
    expect(m.el.isConnected).toBe(false);
  });

  it("leaves no Escape listener behind when it closes another way", () => {
    const m = modal(html`<p>Sure?</p>`, live);
    m.close();
    // A listener left on the document would run the closed dialog's close() again.
    const remove = vi.spyOn(m.el, "remove");
    pressEscape();
    expect(remove).not.toHaveBeenCalled();
  });

  it("closes when the view that opened it ends", () => {
    const view = new AbortController();
    const m = modal(html`<p>Sure?</p>`, view.signal);
    expect(m.el.isConnected).toBe(true);
    view.abort();
    expect(m.el.isConnected).toBe(false);
    // Its Escape listener went with it.
    const remove = vi.spyOn(m.el, "remove");
    pressEscape();
    expect(remove).not.toHaveBeenCalled();
  });

  it("starts focus on its first control, keeps Tab inside, and hands focus back on close", async () => {
    const opener = document.createElement("button");
    $("#app").appendChild(opener);
    opener.focus();
    const m = modal(html`<button id="a">Cancel</button><button id="b">Go</button>`, live);
    await Promise.resolve();
    expect(document.activeElement?.id).toBe("a");
    const tab = (shiftKey: boolean) => {
      const e = new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(tab(true)).toBe(true); // Shift+Tab from the first wraps to the last
    expect(document.activeElement?.id).toBe("b");
    expect(tab(false)).toBe(true); // Tab from the last wraps to the first
    expect(document.activeElement?.id).toBe("a");
    m.close();
    expect(document.activeElement).toBe(opener);
  });

  it("lets only the top dialog of a stack answer Tab and Escape", async () => {
    const lower = modal(html`<button id="l1">Lower</button>`, live);
    const upper = modal(html`<button id="u1">One</button><button id="u2">Two</button>`, live);
    await Promise.resolve();
    $<HTMLButtonElement>("#u1").focus();
    const tab = () => {
      const e = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
      document.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // Not the last control, so Tab moves on naturally: the lower dialog must not pull focus.
    expect(tab()).toBe(false);
    expect(document.activeElement?.id).toBe("u1");
    pressEscape();
    expect(upper.el.isConnected).toBe(false);
    expect(lower.el.isConnected).toBe(true);
    lower.close();
  });

  it("hands focus back when closed by a click on the backdrop", async () => {
    const opener = document.createElement("button");
    $("#app").appendChild(opener);
    opener.focus();
    const m = modal(html`<button>Cancel</button>`, live);
    await Promise.resolve();
    // A click on the backdrop drops focus to the body before the dialog closes.
    (document.activeElement as HTMLElement).blur();
    m.el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(m.el.isConnected).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus where its caller put it", async () => {
    const m = modal(html`<button id="a">Cancel</button><input id="f" />`, live);
    $<HTMLInputElement>("#f", m.el).focus();
    await Promise.resolve();
    expect(document.activeElement?.id).toBe("f");
    m.close();
  });

  it("says a failure inside the dialog, above its actions, where the reader is looking", () => {
    const m = modal(html`<p>Sure?</p><div class="actions"><button>Go</button></div>`, live);
    m.error("The server said no");
    const line = $(".modal .dialog-error", m.el);
    expect(line.textContent).toBe("!The server said no");
    expect(line.getAttribute("role")).toBe("alert");
    expect(line.nextElementSibling?.classList.contains("actions")).toBe(true);
    m.error("Still no"); // a second call replaces the first
    expect(m.el.querySelectorAll(".field-error").length).toBe(1);
    m.clearError();
    expect(m.el.querySelector(".field-error")).toBeNull();
    m.close();
  });

  it("never shows for a view that has already ended", () => {
    const view = new AbortController();
    view.abort();
    const m = modal(html`<p>Sure?</p>`, view.signal);
    expect(m.el.isConnected).toBe(false);
    expect(document.querySelector(".modal")).toBeNull();
  });
});

describe("openMenu", () => {
  beforeEach(() => {
    resetShell();
  });

  const anchor = () => {
    const b = document.createElement("button");
    $("#app").appendChild(b);
    return b;
  };

  it("closes when the view that opened it ends", () => {
    const view = new AbortController();
    openMenu(anchor(), [{ label: "Unsubscribe", onClick: () => {} }], view.signal);
    expect(document.querySelector(".menu")).not.toBeNull();
    expect(document.querySelector(".menu-overlay")).not.toBeNull();
    view.abort();
    expect(document.querySelector(".menu")).toBeNull();
    expect(document.querySelector(".menu-overlay")).toBeNull();
  });

  it("is reachable by keyboard: arrows move, Escape closes and returns to the ⋯", () => {
    const b = anchor();
    b.focus();
    openMenu(
      b,
      [
        { label: "Edit", onClick: () => {} },
        { label: "Delete", danger: true, onClick: () => {} },
      ],
      live,
    );
    const key = (k: string) =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
      );
    expect(document.activeElement?.textContent).toBe("Edit");
    key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Delete");
    key("ArrowDown"); // wraps
    expect(document.activeElement?.textContent).toBe("Edit");
    key("End");
    expect(document.activeElement?.textContent).toBe("Delete");
    key("Escape");
    expect(document.querySelector(".menu")).toBeNull();
    expect(document.activeElement).toBe(b);
  });

  it("returns focus to the ⋯ after a pick opens a dialog and the dialog closes", async () => {
    const b = anchor();
    b.focus();
    let dialog: ReturnType<typeof modal> | undefined;
    openMenu(
      b,
      [
        {
          label: "Delete",
          onClick: () => {
            dialog = modal(html`<button>Cancel</button>`, live);
          },
        },
      ],
      live,
    );
    $<HTMLButtonElement>(".menu-item").click();
    await Promise.resolve();
    expect(dialog?.el.contains(document.activeElement)).toBe(true);
    dialog?.close();
    expect(document.activeElement).toBe(b);
  });

  it("lets go of a view it no longer belongs to", () => {
    const first = new AbortController();
    const second = new AbortController();
    openMenu(anchor(), [{ label: "One", onClick: () => {} }], first.signal);
    openMenu(anchor(), [{ label: "Two", onClick: () => {} }], second.signal);
    // The first view ending must not close the menu the second one opened.
    first.abort();
    expect(document.querySelector(".menu")?.textContent).toBe("Two");
    second.abort();
    expect(document.querySelector(".menu")).toBeNull();
  });
});

describe("fieldError", () => {
  beforeEach(() => {
    resetShell();
  });

  it("marks the field, describes it by the reason, replaces a second error, and clears on edit", () => {
    const input = document.createElement("input");
    input.setAttribute("aria-describedby", "hint");
    $("#app").appendChild(input);
    fieldError(input, "Too short");
    fieldError(input, "Not an address");
    const lines = $("#app").querySelectorAll(".field-error");
    expect(lines.length).toBe(1);
    expect(lines[0]?.textContent).toBe("!Not an address");
    expect(input.classList.contains("is-invalid")).toBe(true);
    expect(input.getAttribute("aria-describedby")).toBe(`hint ${lines[0]?.id}`);
    input.dispatchEvent(new Event("input"));
    expect($("#app").querySelector(".field-error")).toBeNull();
    expect(input.classList.contains("is-invalid")).toBe(false);
    expect(input.getAttribute("aria-describedby")).toBe("hint");
  });
});
