import { describe, expect, it } from "vitest";
import { escapeHtml, Html, html, setHtml, unsafeHtml } from "./html";

describe("html", () => {
  it("escapes every interpolated string, in text and in a quoted attribute", () => {
    const evil = `<img src=x onerror="alert('x')">&`;
    expect(html`<p title="${evil}">${evil}</p>`.markup).toBe(
      `<p title="&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;">&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;</p>`,
    );
    expect(html`<p title='${'it\'s "x"'}'></p>`.markup).toBe(
      `<p title='it&#39;s &quot;x&quot;'></p>`,
    );
  });

  it("refuses an interpolation in an unquoted attribute value, where escaping cannot help", () => {
    const cls = "a onmouseover=alert(1)";
    expect(() => html`<div class=${cls}></div>`).toThrow(/unquoted attribute/);
    expect(() => html`<div class= ${cls}></div>`).toThrow(/unquoted attribute/);
    expect(html`<div class="${cls}"></div>`.markup).toBe(
      `<div class="a onmouseover=alert(1)"></div>`,
    );
    // Markup after `=` is the caller's own doing (an attribute spelled as markup), not text.
    expect(html`<b${html` disabled`}></b>`.markup).toBe("<b disabled></b>");
  });

  it("throws on a literal with an invalid escape sequence instead of dropping the text", () => {
    expect(() => html`<code>C:\users</code>`).toThrow(/invalid escape sequence/);
  });

  it("does not make a URL or a handler safe: that is a scheme check, not escaping", () => {
    // Documented limit, pinned so the contract cannot drift silently.
    expect(html`<a href="${"javascript:alert(1)"}">x</a>`.markup).toBe(
      `<a href="javascript:alert(1)">x</a>`,
    );
  });

  it("is nominal: a look-alike object is not markup, at compile time or at runtime", () => {
    const fake = { markup: "<img src=x onerror=alert(1)>" };
    const el = document.createElement("div");
    // @ts-expect-error a plain object with a markup field is not Html
    expect(() => setHtml(el, fake)).toThrow(/expected Html/);
    // @ts-expect-error a string is not Html
    expect(() => setHtml(el, "<b>x</b>")).toThrow(/expected Html/);
    expect(html`<div>${fake as unknown as string}</div>`.markup).toBe("<div>[object Object]</div>");
  });

  it("admits false but not true, so a bare boolean in markup is a compile error", () => {
    const on = Math.random() < 2;
    // @ts-expect-error true is not an Interpolation
    html`${on}`;
    expect(html`${on && html`<b>on</b>`}`.markup).toBe("<b>on</b>");
  });

  it("is frozen once built", () => {
    const m = html`<b>x</b>`;
    expect(Object.isFrozen(m)).toBe(true);
  });

  it("passes markup through untouched and never escapes it twice", () => {
    const inner = html`<b>${"<i>"}</b>`;
    expect(html`<div>${inner}</div>`.markup).toBe("<div><b>&lt;i&gt;</b></div>");
    expect(html`<div>${html`<div>${inner}</div>`}</div>`.markup).toBe(
      "<div><div><b>&lt;i&gt;</b></div></div>",
    );
  });

  it("flattens arrays, so a list is a map", () => {
    const items = ["a & b", "<c>"].map((s) => html`<li>${s}</li>`);
    expect(html`<ul>${items}</ul>`.markup).toBe("<ul><li>a &amp; b</li><li>&lt;c&gt;</li></ul>");
    expect(html`${[[html`<i>x</i>`], ["y"]]}`.markup).toBe("<i>x</i>y");
  });

  it("renders nothing for null, undefined, and false, so conditionals read plainly", () => {
    const show = false;
    expect(html`<p>${null}${undefined}${show && html`<b>no</b>`}</p>`.markup).toBe("<p></p>");
  });

  it("renders numbers and zero as text", () => {
    expect(html`<td>${0}</td><td>${42}</td>`.markup).toBe("<td>0</td><td>42</td>");
  });

  it("is a string when the DOM or a plain template asks for one", () => {
    const m = html`<b>${"x"}</b>`;
    expect(String(m)).toBe("<b>x</b>");
    expect(`${m}`).toBe("<b>x</b>");
    expect(m).toBeInstanceOf(Html);
  });

  it("unsafeHtml vouches for markup the tag did not build", () => {
    expect(html`<div>${unsafeHtml("<hr>")}</div>`.markup).toBe("<div><hr></div>");
  });

  it("setHtml puts markup in an element", () => {
    const el = document.createElement("div");
    setHtml(el, html`<span>${"<x>"}</span>`);
    expect(el.innerHTML).toBe("<span>&lt;x&gt;</span>");
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that can change meaning in text or a quoted attribute", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml("plain")).toBe("plain");
  });
});
