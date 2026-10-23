/*
 * Which dev server seed and reset may act on (packages/kestrel/lib/dev-api.mjs). They wipe the database of the
 * server they reach, so a target found implicitly must prove it is this directory's, and one
 * the caller names is used as given. Plain Node: cli/ is plain Node, and so is its suite.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseTarget, ownsServer } from "../../packages/kestrel/lib/dev-api.mjs";
import {
  clearDevServer,
  readDevServer,
  writeDevServer,
} from "../../packages/kestrel/lib/dev-server.mjs";

const record = { port: "8794", id: "run-a" };

describe("chooseTarget and ownsServer", () => {
  it("refuses when nothing names a server and none is recorded here, with no fallback port", () => {
    expect(chooseTarget({})).toEqual({ refuse: "unrecorded" });
    expect(chooseTarget({ arg: "" })).toEqual({ refuse: "unrecorded" });
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
    const port = chooseTarget({ arg: "8795", record });
    expect(port).toEqual({ base: "http://localhost:8795", explicit: true });
    expect(ownsServer(port, undefined)).toBe(true);
    expect(ownsServer(port, "run-b")).toBe(true);
    expect(chooseTarget({ arg: "http://127.0.0.1:9001" }).base).toBe("http://127.0.0.1:9001");
  });
});

describe("the dev server record", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kestrel-dev-server-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads back what a run wrote, and nothing when none has", () => {
    expect(readDevServer(dir)).toBeUndefined();
    writeDevServer(8794, "run-a", dir);
    expect(readDevServer(dir)).toEqual({ port: "8794", id: "run-a" });
  });

  it("removes the bare-port record of earlier releases, which proves nothing", () => {
    mkdirSync(join(dir, ".wrangler"), { recursive: true });
    writeFileSync(join(dir, ".wrangler", "dev-port"), "8787");
    writeDevServer(8794, "run-a", dir);
    expect(() => readFileSync(join(dir, ".wrangler", "dev-port"))).toThrow();
  });

  it("reads a malformed record as none", () => {
    mkdirSync(join(dir, ".wrangler"), { recursive: true });
    for (const raw of [
      "not json",
      '{"port":"8794"}',
      '{"port":"x","id":"run-a"}',
      '{"port":"8794","id":""}',
    ]) {
      writeFileSync(join(dir, ".wrangler", "dev-server.json"), raw);
      expect(readDevServer(dir)).toBeUndefined();
    }
  });

  it("is cleared by the run that wrote it, never by an earlier run whose record was replaced", () => {
    writeDevServer(8787, "run-a", dir);
    writeDevServer(8794, "run-b", dir);
    clearDevServer("run-a", dir);
    expect(readDevServer(dir)).toEqual({ port: "8794", id: "run-b" });
    clearDevServer("run-b", dir);
    expect(readDevServer(dir)).toBeUndefined();
  });
});
