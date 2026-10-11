/*
 * Which dev server seed and reset may act on (cli/dev-api.mjs). They wipe the database of the
 * server they reach, so a target found implicitly must prove it is this directory's, and one
 * the caller names is used as given. Plain Node: cli/ is plain Node, and so is its suite.
 */
import { describe, expect, it } from "vitest";
import { chooseTarget, ownsServer } from "../../cli/dev-api.mjs";

const record = { port: "8794", id: "run-a" };

describe("chooseTarget and ownsServer", () => {
  it("refuses when nothing names a server and none is recorded here, with no fallback port", () => {
    expect(chooseTarget({})).toEqual({ refuse: "unrecorded" });
    expect(chooseTarget({ envPort: "" })).toEqual({ refuse: "unrecorded" });
  });

  it("goes to the recorded server when it reports the recorded run ID", () => {
    const target = chooseTarget({ record });
    expect(target).toEqual({ base: "http://localhost:8794", expectId: "run-a" });
    expect(ownsServer(target, "run-a")).toBe(true);
  });

  it("refuses the recorded port when the server there reports another run ID or none", () => {
    const target = chooseTarget({ record });
    expect(ownsServer(target, "run-b")).toBe(false);
    expect(ownsServer(target, undefined)).toBe(false);
  });

  it("uses a port or URL argument as given, whatever the server reports", () => {
    const port = chooseTarget({ arg: "8795", envPort: "9000", record });
    expect(port).toEqual({ base: "http://localhost:8795", explicit: true });
    expect(ownsServer(port, undefined)).toBe(true);
    expect(ownsServer(port, "run-b")).toBe(true);
    expect(chooseTarget({ arg: "http://127.0.0.1:9001" }).base).toBe("http://127.0.0.1:9001");
  });

  it("uses PORT as given, over the record", () => {
    const target = chooseTarget({ envPort: "8795", record });
    expect(target).toEqual({ base: "http://localhost:8795", explicit: true });
    expect(ownsServer(target, undefined)).toBe(true);
  });
});
