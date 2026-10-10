import { describe, expect, it } from "vitest";
import { dashboardRouteFromSearch } from "./dashboard_link";
import { webPreviewHash, webPreviewUrl } from "./web_preview";

describe("web-version preview address", () => {
  it("names a post's preview and the template's sample inside the editor", () => {
    expect(webPreviewHash({ post: "p1" })).toBe("#/web/post/p1");
    expect(webPreviewHash("template")).toBe("#/web/template");
  });

  it("links from outside the editor to the same route", () => {
    const url = webPreviewUrl("https://newsletter.example.com", { post: "p1" });
    expect(url).toBe("https://newsletter.example.com/dashboard/?to=/web/post/p1");
    expect(dashboardRouteFromSearch(new URL(url).search)).toBe(webPreviewHash({ post: "p1" }));
    const sample = webPreviewUrl("https://x.example", "template");
    expect(dashboardRouteFromSearch(new URL(sample).search)).toBe("#/web/template");
  });

  it("keeps a post id inside its one path segment", () => {
    const url = webPreviewUrl("https://x.example", { post: "a/b c" });
    expect(dashboardRouteFromSearch(new URL(url).search)).toBe("#/web/post/a%2Fb%20c");
  });
});
