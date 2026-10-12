import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetShell } from "../test/support";
import { $ } from "./dom";
import { html } from "./html";
import { modal, openMenu, toast } from "./widgets";

// The signal of a view that stays mounted throughout.
const live = new AbortController().signal;

// What the reader sees: the toasts still showing, oldest first, leaving ones excluded.
const showing = (): string[] =>
  [...$("#toasts").querySelectorAll(".toast:not(.leaving)")].map((t) => t.textContent ?? "");

describe("toast (DESIGN §2)", () => {
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
