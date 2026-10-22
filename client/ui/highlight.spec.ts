import { describe, expect, it } from "vitest";
import { highlightJson, highlightJsonText, highlightShell } from "./highlight";

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

describe("highlightJsonText", () => {
  it("marks JSONC as written, its comments included, and never reads a // inside a string as one", () => {
    const src = `{\n  "url": "https://x.test", // ← your app's hostname\n  /* rate */ "max": 14,\n  "id": "…"\n}`;
    const el = render(highlightJsonText(src).markup);
    expect(el.textContent).toBe(src);
    expect(spans(el, "cx-prop")).toEqual(['"url"', '"max"', '"id"']);
    expect(spans(el, "cx-str")).toEqual(['"https://x.test"', '"…"']);
    expect(spans(el, "cx-num")).toEqual(["14"]);
    expect(spans(el, "cx-punct")).toContain("// ← your app's hostname");
    expect(spans(el, "cx-punct")).toContain("/* rate */");
  });

  it("keeps markup in a comment or a string as text", () => {
    const src = `{ "a": "<img src=x onerror=alert(1)>" } // </code><b>x</b>`;
    const el = render(highlightJsonText(src).markup);
    expect(el.textContent).toBe(src);
    expect(el.querySelector("img, b")).toBeNull();
  });
});

describe("highlightShell", () => {
  it("marks the command, its flags, the shell variables, strings, and continuations, and escapes the rest", () => {
    const cmd = `curl -X POST "https://x.test/p" \\\n  -H "Authorization: Bearer $TOKEN" \\\n  -d '{"a":"<i>-x $B</i>"}'`;
    const el = render(highlightShell(cmd).markup);
    expect(el.textContent).toBe(cmd);
    expect(el.querySelector("i")).toBeNull();
    expect(spans(el, "cx-tag")).toEqual(["curl"]);
    expect(spans(el, "cx-num")).toEqual(["-X", "-H", "-d"]);
    // Double quotes expand a variable and single quotes don't, so only the first is marked.
    expect(spans(el, "cx-var")).toEqual(["$TOKEN"]);
    expect(spans(el, "cx-str")).toEqual([
      '"https://x.test/p"',
      '"Authorization: Bearer $TOKEN"',
      `'{"a":"<i>-x $B</i>"}'`,
    ]);
    expect(spans(el, "cx-punct")).toEqual(["\\", "\\"]);
  });

  it("marks the command of each line and each part of a pipeline, past an assignment, and a comment", () => {
    const src = `# start fresh\ncp .dev.vars.example .dev.vars && npm run dev\nSIMULATE_SENDS=ses npx kestrel dev | tee log # watch\ngit status`;
    const el = render(highlightShell(src).markup);
    expect(el.textContent).toBe(src);
    expect(spans(el, "cx-tag")).toEqual(["cp", "npm", "npx", "tee", "git"]);
    expect(spans(el, "cx-punct")).toEqual(["# start fresh", "&&", "|", "# watch"]);
    expect(spans(el, "cx-num")).toEqual([]);
  });
});
