import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetShell, stubEditingCommands, unstubEditingCommands } from "../test/support";
import { replaceRange } from "./text_edit";

describe("replaceRange", () => {
  let ta: HTMLTextAreaElement;
  let inputs: string[];
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
    unstubEditingCommands();
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

  it("never runs the command on another field when the body can't take focus", () => {
    const ran = stubEditingCommands();
    const subject = document.createElement("textarea");
    subject.value = "Subject";
    document.body.append(subject);
    subject.focus();
    ta.disabled = true; // refuses focus, as the hidden body on the Preview tab does in a browser
    replaceRange(ta, 0, 3, "ONE", { start: 3, end: 3 });
    expect(ran).toEqual([]);
    expect(ta.value).toBe("ONE two three");
    expect(subject.value).toBe("Subject");
    expect(inputs).toEqual(["ONE two three"]);
    expect(document.activeElement).toBe(subject);
    subject.remove();
  });
});
