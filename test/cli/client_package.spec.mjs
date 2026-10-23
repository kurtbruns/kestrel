/*
 * The unscoped `kestrel` package, Kestrel's client (packages/kestrel): it hands an instance
 * command to the instance package installed where it runs, fetches that package only for
 * `init`, and stays plain Node that imports nothing outside itself, released in step with the
 * instance package. Plain Node, as the client is.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handoff, INSTANCE_COMMANDS, instanceBin } from "../../packages/kestrel/lib/handoff.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const CLIENT = join(ROOT, "packages", "kestrel");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

describe("handing an instance command to @kurtbruns/kestrel", () => {
  let dir;
  beforeEach(() => {
    // Resolved, as Node resolves the install (macOS links its temporary directory).
    dir = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-handoff-")));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** An instance repository with the instance package installed, as npm leaves it. */
  function installInstancePackage() {
    const pkg = join(dir, "node_modules", "@kurtbruns", "kestrel");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "@kurtbruns/kestrel",
        exports: { "./package.json": "./package.json" },
        bin: { kestrel: "bin/kestrel.mjs" },
      }),
    );
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "newsletter" }));
    return join(pkg, "bin", "kestrel.mjs");
  }

  it("runs the repository's install with the same arguments, from the repository or below it", () => {
    const bin = installInstancePackage();
    mkdirSync(join(dir, "src"));
    for (const at of [dir, join(dir, "src")]) {
      expect(instanceBin(at)).toBe(bin);
      expect(handoff("seed", ["--size", "10k"], { dir: at, version: "9.9.9" })).toEqual({
        cmd: process.execPath,
        args: [bin, "seed", "--size", "10k"],
        shell: false,
      });
    }
  });

  it("prefers the repository's install for init too, so it writes the release the repository runs", () => {
    const bin = installInstancePackage();
    expect(handoff("init", ["site"], { dir, version: "9.9.9" }).args).toEqual([
      bin,
      "init",
      "site",
    ]);
  });

  it("fetches the instance package at the client's own version for init where none is installed", () => {
    expect(
      handoff("init", ["site"], { dir, version: "9.9.9", env: {}, platform: "linux" }),
    ).toEqual({
      cmd: "npx",
      args: ["--yes", "--package=@kurtbruns/kestrel@9.9.9", "--", "kestrel", "init", "site"],
      shell: false,
    });
    const windows = handoff("init", [], { dir, version: "9.9.9", env: {}, platform: "win32" });
    expect(windows).toMatchObject({ cmd: "npx.cmd", shell: true });
    const packed = handoff("init", [], {
      dir,
      version: "9.9.9",
      env: { KESTREL_INSTANCE_PACKAGE: "/tmp/kurtbruns-kestrel-9.9.9.tgz" },
      platform: "linux",
    });
    expect(packed.args[1]).toBe("--package=/tmp/kurtbruns-kestrel-9.9.9.tgz");
  });

  it("refuses every other instance command where none is installed, saying where it runs", () => {
    for (const command of INSTANCE_COMMANDS.filter((c) => c !== "init")) {
      const plan = handoff(command, [], { dir, version: "9.9.9", env: {} });
      expect(plan.cmd).toBeUndefined();
      expect(plan.refuse).toContain(`kestrel ${command}`);
      expect(plan.refuse).toContain("npx kestrel init");
    }
  });
});

describe("the client package", () => {
  it("is released in step with the instance package, at the same version", () => {
    expect(readJson(join(CLIENT, "package.json")).version).toBe(
      readJson(join(ROOT, "package.json")).version,
    );
  });

  it("imports only Node's own modules and its own files, so it runs with no dependency", () => {
    const manifest = readJson(join(CLIENT, "package.json"));
    expect(manifest.dependencies).toBeUndefined();
    for (const folder of ["bin", "lib"]) {
      for (const file of readdirSync(join(CLIENT, folder))) {
        const source = readFileSync(join(CLIENT, folder, file), "utf8");
        const specifiers = [...source.matchAll(/(?:from|import\()\s*"([^"]+)"/g)].map((m) => m[1]);
        for (const specifier of specifiers) {
          expect(
            specifier.startsWith("node:") || /^\.\.?\/(lib\/)?[\w-]+\.mjs$/.test(specifier),
            `${folder}/${file} imports ${specifier}`,
          ).toBe(true);
        }
      }
    }
  });

  it("is shipped inside the instance package, so an instance runs the client from its own install", () => {
    expect(readJson(join(ROOT, "package.json")).files).toContain("packages/kestrel/lib/");
  });
});
