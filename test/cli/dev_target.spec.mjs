/*
 * Which dev server seed and reset may act on (packages/kestrel/lib/dev-api.mjs). They wipe the database of the
 * server they reach, so a target found implicitly must prove it is this directory's, and one
 * the caller names is used as given. Plain Node: cli/ is plain Node, and so is its suite.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectDevServer,
  ownsServer,
  planDevTarget,
} from "../../packages/kestrel/lib/dev-api.mjs";
import {
  clearDevServer,
  readDevServer,
  writeDevServer,
} from "../../packages/kestrel/lib/dev-server.mjs";
import { CliError } from "../../packages/kestrel/lib/errors.mjs";

const record = { port: "8794", id: "run-a" };

describe("planDevTarget and ownsServer", () => {
  it("refuses when nothing names a server and none is recorded here, with no fallback port", () => {
    expect(planDevTarget({})).toEqual({ refuse: "unrecorded" });
    expect(planDevTarget({ arg: "" })).toEqual({ refuse: "unrecorded" });
  });

  it("goes to the recorded server when it reports the recorded run ID", () => {
    const target = planDevTarget({ record });
    expect(target).toEqual({ base: "http://localhost:8794", expectId: "run-a" });
    expect(ownsServer(target, "run-a")).toBe(true);
  });

  it("refuses the recorded port when the server there reports another run ID or none", () => {
    const target = planDevTarget({ record });
    expect(ownsServer(target, "run-b")).toBe(false);
    expect(ownsServer(target, undefined)).toBe(false);
  });

  it("uses a port or URL argument as given, whatever the server reports", () => {
    const port = planDevTarget({ arg: "8795", record });
    expect(port).toEqual({ base: "http://localhost:8795", explicit: true });
    expect(ownsServer(port, undefined)).toBe(true);
    expect(ownsServer(port, "run-b")).toBe(true);
    expect(planDevTarget({ arg: "http://127.0.0.1:9001" }).base).toBe("http://127.0.0.1:9001");
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

describe("a server that isn't a Kestrel dev server", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is refused in a line when it answers the dev token with a page", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>another app</html>", { status: 200 }));
    const refused = connectDevServer("3000", "api", "human");
    await expect(refused).rejects.toThrow(CliError);
    await expect(refused).rejects.toThrow(
      "the server at http://localhost:3000 didn't answer as a Kestrel dev server.",
    );
  });
});

describe("a dev token route that answers 404 and never finishes its body", () => {
  let server;
  let scratch;
  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("is refused, and the command exits at once rather than wait on the body", async () => {
    scratch = mkdtempSync(join(tmpdir(), "kestrel-404-"));
    server = createServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.write("not here");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const bin = join(import.meta.dirname, "..", "..", "bin", "kestrel.mjs");
    const started = Date.now();
    const { code, err } = await new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, "reset", base], { cwd: scratch });
      let err = "";
      child.stderr.on("data", (chunk) => {
        err += chunk;
      });
      child.on("exit", (code) => resolve({ code, err }));
    });
    expect(code).toBe(1);
    expect(err).toMatch(/^kestrel reset: \/api\/dev\/token is unavailable/m);
    // Waiting on the body, it took about eight seconds; at once is well under three.
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 20_000);
});
