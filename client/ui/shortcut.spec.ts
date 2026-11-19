import { describe, expect, it } from "vitest";
import { modifiedKeyEdits, onApple, shortcutKey, shortcutLabel, shortcutLetter } from "./shortcut";

const press = (key: string, mods: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key, ...mods });

describe("shortcut keys", () => {
  it.each([
    ["MacIntel", true],
    ["iPad", true],
    ["iPhone", true],
    ["Win32", false],
    ["Linux x86_64", false],
    ["", false],
  ])("treats %j as Apple's: %s", (platform, apple) => {
    expect(onApple(platform)).toBe(apple);
  });

  it("takes ⌘ on a Mac and Ctrl elsewhere, never the other", () => {
    expect(shortcutKey(press("k", { metaKey: true }), true)).toBe(true);
    expect(shortcutKey(press("k", { ctrlKey: true }), true)).toBe(false);
    expect(shortcutKey(press("k", { ctrlKey: true }), false)).toBe(true);
    expect(shortcutKey(press("k", { metaKey: true }), false)).toBe(false);
  });

  it("writes a shortcut the way the device does", () => {
    expect(shortcutLabel("K", true)).toBe("⌘K");
    expect(shortcutLabel("K", false)).toBe("Ctrl+K");
  });

  it.each([
    ["a Latin letter, as typed", press("B", { code: "KeyB" }), "b"],
    ["a Latin layout's own letter over its place (B on Dvorak)", press("b", { code: "KeyN" }), "b"],
    ["a Cyrillic layout's letter, by its place", press("и", { code: "KeyB" }), "b"],
    ["a Greek layout's letter, by its place", press("κ", { code: "KeyK" }), "k"],
    ["a key that isn't a letter", press("1", { code: "Digit1" }), "1"],
  ])("reads the shortcut's letter from %s", (_what, e, letter) => {
    expect(shortcutLetter(e)).toBe(letter);
  });

  it.each([
    [
      "cut with Ctrl on a Cyrillic layout",
      press("ч", { code: "KeyX", ctrlKey: true }),
      false,
      true,
    ],
    ["cut with ⌘ on a Mac", press("x", { metaKey: true }), true, true],
    ["undo with Ctrl elsewhere", press("z", { ctrlKey: true }), false, true],
    ["a Mac's Ctrl+K, deleting to the line's end", press("k", { ctrlKey: true }), true, true],
    ["a Mac's Ctrl+D, deleting forward", press("d", { ctrlKey: true }), true, true],
    ["a Mac's Ctrl+A, moving to the line's start", press("a", { ctrlKey: true }), true, false],
    ["copy with ⌘ on a Mac", press("c", { metaKey: true }), true, false],
    ["Ctrl+K off a Mac", press("k", { ctrlKey: true }), false, false],
  ])("knows whether %s changes the text", (_what, e, apple, edits) => {
    expect(modifiedKeyEdits(e, apple)).toBe(edits);
  });
});
