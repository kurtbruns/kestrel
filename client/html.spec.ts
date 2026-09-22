import { describe, expect, it } from "vitest";
import { escapeHtml, Html, html, setHtml, unsafeHtml } from "./html";

describe("html", () => {
  it("escapes every interpolated string, in text and in a quoted attribute", () => {
    const evil = `<img src=x onerror="alert('x')">&`;
    expect(html`<p title="${evil}">${evil}</p>`.markup).toBe(
      `<p title="&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;">&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;</p>`,
    );
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
