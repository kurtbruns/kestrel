import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetShell, stubEditingCommands, unstubEditingCommands } from "../test/support";
import { replaceRange } from "./text_edit";

describe("replaceRange", () => {
  let ta: HTMLTextAreaElement;
  let inputs: string[];
  let other: HTMLElement | undefined; // a second field a test adds, removed even if it fails
  beforeEach(() => {
    resetShell();
    ta = document.createElement("textarea");
    ta.value = "one two three";
    document.body.append(ta);
    inputs = [];
    ta.addEventListener("input", () => inputs.push(ta.value));
  });
  afterEach(() => {
    ta.remove();
    other?.remove();
    other = undefined;
    unstubEditingCommands();
    vi.restoreAllMocks();
  });

  it("edits through the browser's insertText, so the change is one undo step", () => {
    const ran = stubEditingCommands();
    replaceRange(ta, 4, 7, "**two**", { start: 6, end: 9 });
    expect(ran).toEqual([["insertText", "**two**"]]);
    expect(ta.value).toBe("one **two** three");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([6, 9]);
    expect(inputs).toEqual(["one **two** three"]); // one input event, from the command
  });

  it("removes a range with the browser's delete when the replacement is empty", () => {
    const ran = stubEditingCommands();
    replaceRange(ta, 3, 7, "", { start: 3, end: 3 });
    expect(ran).toEqual([["delete", undefined]]);
    expect(ta.value).toBe("one three");
  });

  it("still makes the edit, and still fires input, where the browser has no editing command", () => {
    replaceRange(ta, 4, 7, "**two**", { start: 6, end: 9 });
    expect(ta.value).toBe("one **two** three");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([6, 9]);
    expect(inputs).toEqual(["one **two** three"]);
  });

  it("takes the body's focus without scrolling the page", () => {
    stubEditingCommands();
    const focus = vi.spyOn(ta, "focus");
    replaceRange(ta, 4, 7, "**two**", { start: 6, end: 9 });
    expect(focus.mock.calls).toEqual([[{ preventScroll: true }]]);
  });

  it("leaves another field's focus alone, landing the edit without an undo step, so that field never blurs", () => {
    const ran = stubEditingCommands();
    const subject = document.createElement("input");
    other = subject;
    document.body.append(subject);
    subject.focus();
    let blurs = 0;
    subject.addEventListener("blur", () => {
      blurs += 1;
    });
    replaceRange(ta, 4, 7, "**two**", { start: 6, end: 9 });
    expect(ta.value).toBe("one **two** three");
    expect(inputs).toEqual(["one **two** three"]);
    expect(ran).toEqual([]);
    expect(blurs).toBe(0);
    expect(document.activeElement).toBe(subject);
  });

  it("still makes the edit when the body can't take focus, as on the Preview tab", () => {
    const ran = stubEditingCommands();
    ta.disabled = true; // refuses focus, as the hidden body on the Preview tab does in a browser
    replaceRange(ta, 0, 3, "ONE", { start: 3, end: 3 });
    expect(ran).toEqual([]);
    expect(ta.value).toBe("ONE two three");
    expect(inputs).toEqual(["ONE two three"]);
  });
});
