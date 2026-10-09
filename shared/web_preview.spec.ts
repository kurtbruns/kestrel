import { describe, expect, it } from "vitest";
import { webPreviewHash, webPreviewUrl } from "./web_preview";

describe("web-version preview address", () => {
  it("names a post's preview and the template's sample inside the editor", () => {
    expect(webPreviewHash({ post: "p1" })).toBe("#/web/post/p1");
    expect(webPreviewHash("template")).toBe("#/web/template");
    expect(webPreviewUrl("https://newsletter.example.com", { post: "p1" })).toBe(
      "https://newsletter.example.com/dashboard/#/web/post/p1",
    );
  });

  it("keeps a post id inside its one path segment", () => {
    expect(webPreviewHash({ post: "a/b c" })).toBe("#/web/post/a%2Fb%20c");
  });
});
