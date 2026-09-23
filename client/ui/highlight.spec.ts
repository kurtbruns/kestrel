import { describe, expect, it } from "vitest";
import { highlightCurl, highlightJson } from "./highlight";

/** The markup as a detached element, to read its text and spans the way the page would. */
function render(markup: string): HTMLElement {
  const el = document.createElement("code");
  el.innerHTML = markup;
  return el;
}
const spans = (el: Element, cls: string) =>
  [...el.querySelectorAll(`.${cls}`)].map((s) => s.textContent);

describe("highlightJson", () => {
  it("shows exactly the pretty-printed JSON, with keys, strings, numbers, and literals marked", () => {
    const value = { id: "p1", count: -2.5e3, ok: true, none: null, tags: ["a"] };
    const el = render(highlightJson(value).markup);
    expect(el.textContent).toBe(JSON.stringify(value, null, 2));
    expect(spans(el, "cx-prop")).toEqual(['"id"', '"count"', '"ok"', '"none"', '"tags"']);
    expect(spans(el, "cx-str")).toEqual(['"p1"', '"a"']);
    expect(spans(el, "cx-num")).toEqual(["-2500"]);
    expect(spans(el, "cx-tag")).toEqual(["true", "null"]);
  });

  it("keeps markup, quotes, and backslashes inside a string as text, and never marks what a string contains", () => {
    const hostile = '</code><img src=x onerror="alert(1)"> \\" true 1 {"k": 2}';
    const value = { [`<b>${hostile}`]: hostile };
    const el = render(highlightJson(value).markup);
    expect(el.textContent).toBe(JSON.stringify(value, null, 2));
    expect(el.querySelector("img, b")).toBeNull();
    // One key and one string, each whole: nothing inside them became a number or literal.
    expect(spans(el, "cx-prop")).toHaveLength(1);
    expect(spans(el, "cx-str")).toEqual([JSON.stringify(hostile)]);
    expect(spans(el, "cx-num")).toEqual([]);
    expect(spans(el, "cx-tag")).toEqual([]);
  });
});

describe("highlightCurl", () => {
  it("marks the command, its flags, and the shell variables, and escapes the rest", () => {
    const cmd = `curl -X POST "https://x.test/p" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -d '{"a":"<i>-x $B</i>"}'`;
    const el = render(highlightCurl(cmd).markup);
    expect(el.textContent).toBe(cmd);
    expect(el.querySelector("i")).toBeNull();
    expect(spans(el, "cx-tag")).toEqual(["curl"]);
    expect(spans(el, "cx-num")).toEqual(["-X", "-H", "-d"]);
    expect(spans(el, "cx-var")).toEqual(["$TOKEN", "$B"]);
  });
});
