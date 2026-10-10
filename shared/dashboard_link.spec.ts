import { describe, expect, it } from "vitest";
import { dashboardLink, dashboardRouteFromSearch } from "./dashboard_link";

const route = (url: string) => dashboardRouteFromSearch(new URL(url).search);

describe("links into the editor from outside it", () => {
  it("carries the route in the query, which a login keeps, and reads as the page it opens", () => {
    const url = dashboardLink("https://newsletter.example.com", "/sent/s1");
    expect(url).toBe("https://newsletter.example.com/dashboard/?to=/sent/s1");
    expect(new URL(url).hash).toBe("");
    expect(route(url)).toBe("#/sent/s1");
    expect(route(dashboardLink("https://x.example", "/settings"))).toBe("#/settings");
  });

  it("keeps an encoded segment encoded, both ways", () => {
    const url = dashboardLink("https://x.example", `/web/post/${encodeURIComponent("a/b c")}`);
    expect(route(url)).toBe("#/web/post/a%2Fb%20c");
  });

  it("names no route for a query that isn't one", () => {
    for (const search of [
      "",
      "?to=",
      "?to=sent/s1",
      "?to=/",
      "?to=//evil.example",
      "?to=/sent/<b>",
      "?to=/sent/s1?x=1",
    ]) {
      expect(dashboardRouteFromSearch(search), search).toBeNull();
    }
  });
});
