import { describe, expect, it } from "vitest";
import { unauthorizedReason } from "./errors";

describe("an admin 401's reason (SPEC §11)", () => {
  it("reads the two reasons signing in again can't fix, and nothing else", () => {
    expect(unauthorizedReason({ error: "unauthorized", reason: "access_not_configured" })).toBe(
      "access_not_configured",
    );
    expect(unauthorizedReason({ error: "unauthorized", reason: "access_unidentified" })).toBe(
      "access_unidentified",
    );
    expect(unauthorizedReason({ error: "unauthorized" })).toBeNull();
    expect(unauthorizedReason({ error: "unauthorized", reason: "something_else" })).toBeNull();
    expect(unauthorizedReason({ error: "forbidden", reason: "access_unidentified" })).toBeNull();
    expect(unauthorizedReason(null)).toBeNull();
    expect(unauthorizedReason("unauthorized")).toBeNull();
  });
});
