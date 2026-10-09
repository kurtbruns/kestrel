import { describe, expect, it } from "vitest";
import { webPreviewHash, webPreviewHashFromSearch, webPreviewUrl } from "./web_preview";

describe("web-version preview address", () => {
  it("names a post's preview and the template's sample inside the editor", () => {
    expect(webPreviewHash({ post: "p1" })).toBe("#/web/post/p1");
    expect(webPreviewHash("template")).toBe("#/web/template");
  });

  it("carries the target in the query, which survives an Access login, not the hash", () => {
    const url = webPreviewUrl("https://newsletter.example.com", { post: "p1" });
    expect(url).toBe("https://newsletter.example.com/dashboard/?web=post%2Fp1");
    expect(new URL(url).hash).toBe("");
    expect(webPreviewHashFromSearch(new URL(url).search)).toBe("#/web/post/p1");
    expect(
      webPreviewHashFromSearch(new URL(webPreviewUrl("https://x.example", "template")).search),
    ).toBe("#/web/template");
  });

  it("keeps a post id inside its one path segment, both ways", () => {
    const url = webPreviewUrl("https://x.example", { post: "a/b c" });
    expect(webPreviewHashFromSearch(new URL(url).search)).toBe("#/web/post/a%2Fb%20c");
  });

  it("names no preview for a query that isn't one", () => {
    expect(webPreviewHashFromSearch("")).toBeNull();
    expect(webPreviewHashFromSearch("?web=")).toBeNull();
    expect(webPreviewHashFromSearch("?web=post/")).toBeNull();
    expect(webPreviewHashFromSearch("?web=other")).toBeNull();
    expect(webPreviewHashFromSearch("?web=post/a/b")).toBeNull();
  });
});
