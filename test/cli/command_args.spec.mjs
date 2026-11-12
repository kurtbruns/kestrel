/*
 * How every `kestrel` command reads its arguments (packages/kestrel/lib/args.mjs): `--help` and
 * `-h` print the command's usage and do nothing else, and an option it doesn't know, a missing
 * value, or an extra positional is refused with the usage before anything runs. Run as an
 * instance runs them, `bin/kestrel.mjs` in a scratch folder, so a command that read `--help` as
 * something else would leave files behind.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseApiArgs } from "../../packages/kestrel/lib/api.mjs";
import { asksForHelp, readArgs } from "../../packages/kestrel/lib/args.mjs";
import { COMMANDS } from "../../packages/kestrel/lib/commands.mjs";
import { UsageError } from "../../packages/kestrel/lib/errors.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const BIN = join(ROOT, "bin", "kestrel.mjs");
const CLIENT_BIN = join(ROOT, "packages", "kestrel", "bin", "kestrel.mjs");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kestrel-args-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run `kestrel <args>` in the scratch folder, with no dev server recorded and no sign-ins. */
const kestrel = (bin, ...args) => {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, KESTREL_CONFIG_DIR: join(dir, ".config"), KESTREL_URL: "" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("readArgs", () => {
  const spec = { options: { size: { type: "string" }, quiet: { type: "boolean" } }, max: 1 };

  it("reads options in either spelling and positionals in any order", () => {
    expect(readArgs(["--size", "1k", "8790", "--quiet"], spec)).toEqual({
      values: { size: "1k", quiet: true },
      positionals: ["8790"],
    });
    expect(readArgs(["--size=1k"], spec)).toEqual({ values: { size: "1k" }, positionals: [] });
  });

  it.each([
    [["--sise", "1k"], "unknown option --sise"],
    [["-x"], "unknown option -x"],
    [["--size"], "--size needs a value"],
    [["8790", "8791"], 'unexpected argument "8791"'],
  ])("refuses %j: %s", (argv, message) => {
    expect(() => readArgs(argv, spec)).toThrow(UsageError);
    expect(() => readArgs(argv, spec)).toThrow(message);
  });

  it("reads -h after -- as an argument, not a request for help", () => {
    expect(asksForHelp(["--", "-h"])).toBe(false);
    expect(readArgs(["--", "-h"], spec)).toEqual({ values: {}, positionals: ["-h"] });
  });

  it("answers help before anything it would refuse", () => {
    expect(readArgs(["--sise", "1k", "-h"], spec)).toEqual({ help: true });
  });
});

describe("--help on each command", () => {
  it.each([
    ["init", "Usage: kestrel init"],
    ["sync-migrations", "Usage: kestrel sync-migrations"],
    ["check-context", "Usage: kestrel check-context"],
    ["seed", "Usage: kestrel seed"],
    ["reset", "Usage: kestrel reset"],
    ["dev", "Usage: kestrel dev"],
    ["login", "Usage: kestrel login"],
    ["logout", "Usage: kestrel logout"],
    ["api", "Usage: kestrel api"],
  ])("kestrel %s --help prints its usage, exits 0, and writes nothing", (command, usage) => {
    for (const flag of ["--help", "-h"]) {
      const r = kestrel(BIN, command, flag);
      expect(r.code).toBe(0);
      expect(r.out.startsWith(usage)).toBe(true);
      expect(r.err).toBe("");
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it.each(["init", "dev", "sync-migrations", "check-context", "seed", "reset"])(
    "answers kestrel %s --help from the client with no instance installed, fetching nothing",
    (command) => {
      const r = kestrel(CLIENT_BIN, command, "--help");
      expect(r.code).toBe(0);
      expect(r.out.startsWith(`Usage: kestrel ${command}`)).toBe(true);
      expect(r.err).toBe("");
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it("answers the client's own commands the same way", () => {
    for (const command of ["login", "logout", "api"]) {
      const r = kestrel(CLIENT_BIN, command, "--help");
      expect(r.code).toBe(0);
      expect(r.out.startsWith(`Usage: kestrel ${command}`)).toBe(true);
    }
  });
});

describe("a command line a command can't run", () => {
  it("leaves the folder empty when init is given a misspelled flag", () => {
    const r = kestrel(BIN, "init", "--nmae", "windbreak");
    expect(r.code).toBe(1);
    expect(r.err.startsWith("kestrel init: unknown option --nmae\n\nUsage: kestrel init")).toBe(
      true,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ["sync-migrations", ["extra"], 'kestrel sync-migrations: unexpected argument "extra"'],
    ["check-context", ["--updat"], "kestrel check-context: unknown option --updat"],
    ["seed", ["--sise", "1k"], "kestrel seed: unknown option --sise"],
    ["reset", ["8787", "8788"], 'kestrel reset: unexpected argument "8788"'],
    ["login", ["--nobrowser", "news.example.com"], "kestrel login: unknown option --nobrowser"],
    [
      "logout",
      ["a.example.com", "b.example.com"],
      'kestrel logout: unexpected argument "b.example.com"',
    ],
  ])("kestrel %s %j is refused with its usage", (command, args, first) => {
    const r = kestrel(BIN, command, ...args);
    expect(r.code).toBe(1);
    expect(r.err.split("\n")[0]).toBe(first);
    expect(r.err).toContain(`Usage: kestrel ${command}`);
    expect(r.out).toBe("");
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("kestrel api's own reader", () => {
  it("takes --help or -h anywhere as a request for the usage", () => {
    expect(parseApiArgs(["--help"])).toEqual({ mode: "usage" });
    expect(parseApiArgs(["GET", "/api/posts", "-h"])).toEqual({ mode: "usage" });
  });

  it("still reads help as its subcommand", () => {
    expect(parseApiArgs(["help"])).toMatchObject({ mode: "list" });
  });
});

describe("kestrel --help", () => {
  it("lists every command by the first line of its own usage, so the two can't differ", () => {
    const r = kestrel(BIN, "--help");
    for (const { usage } of COMMANDS) {
      expect(r.out).toContain(`  ${usage.split("\n")[0].replace("Usage: kestrel ", "")}  `);
    }
  });

  it("refuses an unknown command with the help, and exit 1", () => {
    const r = kestrel(BIN, "frob");
    expect(r.code).toBe(1);
    expect(r.err.startsWith('kestrel: unknown command "frob"\n\nkestrel ')).toBe(true);
  });
});
