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
import { findInstance, handoff, INSTANCE_COMMANDS } from "../../packages/kestrel/lib/handoff.mjs";

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
      expect(findInstance(at)?.bin).toBe(bin);
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
    // On Windows the shell gets one command line, so a name with a space stays one argument.
    expect(
      handoff("init", ["My Site"], { dir, version: "9.9.9", env: {}, platform: "win32" }),
    ).toEqual({
      cmd: 'npx.cmd --yes --package=@kurtbruns/kestrel@9.9.9 -- kestrel init "My Site"',
      args: [],
      shell: true,
    });
    const packed = handoff("init", [], {
      dir,
      version: "9.9.9",
      env: { KESTREL_INSTANCE_PACKAGE: "/tmp/kurtbruns-kestrel-9.9.9.tgz" },
      platform: "linux",
    });
    expect(packed.args[1]).toBe("--package=/tmp/kurtbruns-kestrel-9.9.9.tgz");
  });

  it("refuses an install with no kestrel command rather than calling it missing or fetching another", () => {
    const bin = installInstancePackage();
    const manifest = join(dir, "node_modules", "@kurtbruns", "kestrel", "package.json");
    writeFileSync(manifest, JSON.stringify({ ...readJson(manifest), bin: undefined }));
    expect(findInstance(dir)).toEqual({ root: join(bin, "..", ".."), bin: undefined });
    for (const command of ["init", "dev"]) {
      const plan = handoff(command, [], { dir, version: "9.9.9", env: {} });
      expect(plan.cmd).toBeUndefined();
      expect(plan.refuse).toContain("has no kestrel command");
    }
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
        const specifiers = [
          ...source.matchAll(/(?:\bfrom|\bimport\s*\(?)\s*["'`]([^"'`]+)["'`]/g),
        ].map((m) => m[1]);
        // A module in lib/ reaches its siblings only; bin/ reaches into lib/. Nothing else is
        // in the client's tarball, or in the copy of lib/ the instance package ships.
        const own = folder === "lib" ? /^\.\/[\w-]+\.mjs$/ : /^\.\.\/lib\/[\w-]+\.mjs$/;
        for (const specifier of specifiers) {
          expect(
            specifier.startsWith("node:") || own.test(specifier),
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
