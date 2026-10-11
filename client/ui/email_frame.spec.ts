import { describe, expect, it } from "vitest";
import { openLinksInNewTab } from "./email_frame";

describe("openLinksInNewTab", () => {
  it("sends every link to a new tab with no opener and no referrer, whatever it said", () => {
    const doc = document.implementation.createHTMLDocument("email");
    doc.body.innerHTML =
      '<a href="https://a.example/">a</a>' +
      '<a href="https://b.example/" target="_self" rel="opener">b</a>' +
      '<map><area href="https://c.example/"></map>' +
      "<a>no href</a>";
    openLinksInNewTab(doc);
    for (const link of doc.querySelectorAll("[href]")) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(doc.querySelector("a:not([href])")?.hasAttribute("target")).toBe(false);
  });
});
