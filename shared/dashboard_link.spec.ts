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
    const url = dashboardLink("https://x.example", `/sent/${encodeURIComponent("a/b c")}`);
    expect(route(url)).toBe("#/sent/a%2Fb%20c");
    // A dot inside a segment is only a character; a whole `.` or `..` segment is refused.
    expect(dashboardRouteFromSearch("?to=/sent/s.1..2")).toBe("#/sent/s.1..2");
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
      "?to=/sent/s1%23x",
      "?to=%2F%2Fevil.example",
      "?to=/%5Cevil.example",
      "?to=https://evil.example",
      "?to=javascript:alert(1)",
      "?to=/sent/..",
      "?to=/sent/.",
      "?to=/sent/%2e%2E/x",
    ]) {
      expect(dashboardRouteFromSearch(search), search).toBeNull();
    }
  });
});
