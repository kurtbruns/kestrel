// The drop marker's place in the highlight layer: which row and which character of it a text
// offset is, since the layer splits the text into one row per line and a row into styled spans.
// The geometry is the browser's, so each spec stands in the one box it would answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { caretBox } from "./drop_caret";

function layer(rows: string[]): Element {
  const code = document.createElement("code");
  code.innerHTML = rows.map((r) => `<span class="cx-md-ln">${r}</span>`).join("");
  return code;
}

/** Answers `box` for every collapsed range, and says where each range was put. */
function measured(box: Partial<DOMRect>) {
  const asked: [string, number][] = [];
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
    asked.push([this.startContainer.textContent ?? "", this.startOffset]);
    return [box] as unknown as DOMRectList;
  });
  return asked;
}

afterEach(() => vi.restoreAllMocks());

describe("caretBox", () => {
  it("measures at the caret's own row and character, across the row's styled spans", () => {
    const asked = measured({ left: 40, top: 60, height: 20 });
    const code = layer(["# Owls", "", "Hoot <b>twice</b> now"]);
    const text = "# Owls\n\nHoot twice now";
    expect(caretBox(code, text, text.indexOf("ice"))).toMatchObject({ left: 40, top: 60 });
    expect(asked).toEqual([["twice", 2]]);
  });

  it("puts a caret on an empty line at that row's start, one line tall", () => {
    measured({ height: 0 });
    const code = layer(["# Owls", "", "Hoot"]);
    const row = code.children[1] as Element;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue(new DOMRect(14, 80, 300, 23));
    const box = caretBox(code, "# Owls\n\nHoot", 7);
    expect(box).toMatchObject({ left: 14, top: 80, width: 0, height: 23 });
  });

  it("answers nothing for a line the layer has no row for", () => {
    expect(caretBox(layer(["# Owls"]), "# Owls\nmore", 8)).toBe(null);
  });
});
