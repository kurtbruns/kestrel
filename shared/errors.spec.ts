import { describe, expect, it } from "vitest";
import { accessUnreachable, devTokenAvailable, unauthorizedReason } from "./errors";

describe("accessUnreachable", () => {
  it("reads only the 503's own code, never a 401 or a body that isn't one", () => {
    expect(accessUnreachable({ error: "access_unreachable", retry_after: 1 })).toBe(true);
    expect(accessUnreachable({ error: "unauthorized" })).toBe(false);
    expect(accessUnreachable(null)).toBe(false);
    expect(accessUnreachable("access_unreachable")).toBe(false);
  });
});

describe("an admin 401's offer of a dev token (SPEC §11)", () => {
  it("reads only an unauthorized body that says true", () => {
    expect(devTokenAvailable({ error: "unauthorized", dev_token_available: true })).toBe(true);
    expect(devTokenAvailable({ error: "unauthorized" })).toBe(false);
    expect(devTokenAvailable({ error: "unauthorized", dev_token_available: "true" })).toBe(false);
    expect(devTokenAvailable({ error: "invalid_config", dev_token_available: true })).toBe(false);
    expect(devTokenAvailable(null)).toBe(false);
    expect(devTokenAvailable("unauthorized")).toBe(false);
  });
});

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
