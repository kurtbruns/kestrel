import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { $, resetShell, stubClipboard } from "../test/support";
import { bareCodeBlock, codeBlock, copyButton, copyFace, copyWith, wireCopy } from "./copy";
import { html, setHtml } from "./html";

describe("copy (DESIGN §7)", () => {
  let root: HTMLElement;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    root = document.createElement("div");
    document.body.append(root);
  });
  afterEach(() => {
    root.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("copies a block's plain text, says so in place for a moment, then reads as before", async () => {
    const writeText = stubClipboard();
    setHtml(root, codeBlock("curl", html`<b>curl</b> x`, "curl x"));
    wireCopy(root);
    // A code block is its own card: the label and Copy in a header over the code.
    expect($(".code-block > .block-head + pre", root).textContent).toBe("curl x");
    const b = $<HTMLButtonElement>(".code-block .copy-btn", root);
    expect(b.getAttribute("aria-label")).toBe("Copy curl");
    b.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith("curl x");
    expect(b.getAttribute("aria-label")).toBe("Copied");
    expect(b.classList.contains("copied")).toBe(true);
    expect($("#toasts").textContent).toBe("");
    await vi.advanceTimersByTimeAsync(1500);
    expect(b.getAttribute("aria-label")).toBe("Copy curl");
    expect(b.classList.contains("copied")).toBe(false);
  });

  it("puts a bare block's Copy beside the code as its glyph alone, through the check and back", async () => {
    const writeText = stubClipboard();
    setHtml(root, bareCodeBlock(html`<b>npm</b> test`, "npm test"));
    wireCopy(root);
    expect(root.querySelector(".block-head")).toBeNull();
    const b = $<HTMLButtonElement>(".code-bare > pre + .copy-btn", root);
    expect($("span", b).textContent).toBe("");
    b.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith("npm test");
    expect(b.classList.contains("copied")).toBe(true);
    expect($("span", b).textContent).toBe("");
    await vi.advanceTimersByTimeAsync(1500);
    expect(b.getAttribute("aria-label")).toBe("Copy");
    expect($("span", b).textContent).toBe("");
  });

  it("keeps a button's own word through the check and back", async () => {
    stubClipboard();
    setHtml(
      root,
      html`<button type="button" class="secondary" data-copy-word="Copy HTML" aria-label="Copy the form">${copyFace(false, "Copy HTML")}</button>`,
    );
    const b = $<HTMLButtonElement>("button", root);
    await copyWith(b, "<form></form>");
    expect($("span", b).textContent).toBe("Copy HTML");
    expect(b.classList.contains("copied")).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect($("span", b).textContent).toBe("Copy HTML");
    expect(b.getAttribute("aria-label")).toBe("Copy the form");
  });

  it("restarts the moment on a second copy, and still restores the original name", async () => {
    stubClipboard();
    setHtml(root, copyButton("a@b.c", "Copy the address"));
    const b = $<HTMLButtonElement>(".copy-btn", root);
    await copyWith(b, "a@b.c");
    await vi.advanceTimersByTimeAsync(1000);
    await copyWith(b, "a@b.c");
    await vi.advanceTimersByTimeAsync(1000);
    // Still within the second moment.
    expect(b.getAttribute("aria-label")).toBe("Copied");
    await vi.advanceTimersByTimeAsync(500);
    expect(b.getAttribute("aria-label")).toBe("Copy the address");
  });

  it("says a refused clipboard in a toast and leaves the button as it was", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText: () => Promise.reject(new Error("denied")) },
    });
    setHtml(root, copyButton("x", "Copy x"));
    const b = $<HTMLButtonElement>(".copy-btn", root);
    await copyWith(b, "x");
    expect($("#toasts").textContent).toMatch(/Couldn’t copy to clipboard/);
    expect(b.getAttribute("aria-label")).toBe("Copy x");
    expect(b.classList.contains("copied")).toBe(false);
  });

  it("answers only a click on a Copy", async () => {
    const writeText = stubClipboard();
    setHtml(root, html`<p class="other">text</p>${copyButton("x", "Copy x")}`);
    wireCopy(root);
    $<HTMLElement>(".other", root).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).not.toHaveBeenCalled();
  });
});
