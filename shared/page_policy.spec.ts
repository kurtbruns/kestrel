import { describe, expect, it } from "vitest";
import { pagePolicy } from "./page_policy";

describe("the post page's content security policy", () => {
  it("runs no script, submits as told, and is never framed or rebased, as a header", () => {
    const policy = pagePolicy("'none'");
    for (const d of [
      "default-src 'none'",
      "script-src 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ]) {
      expect(policy).toContain(d);
    }
    expect(pagePolicy("'self'")).toContain("form-action 'self'");
  });

  it("restates the same inside a framed copy, less what a <meta> can't carry or the copy's <base> needs", () => {
    const framed = pagePolicy("'none'", { framed: true });
    expect(framed).toBe(
      pagePolicy("'none'")
        .split("; ")
        .filter((d) => !d.startsWith("base-uri") && !d.startsWith("frame-ancestors"))
        .join("; "),
    );
  });
});
