/*
 * The names `kestrel init` gives an instance's Worker, D1 database, and R2 bucket
 * (cli/init.mjs): made from the folder's name or `--name`, held to the characters and length
 * Cloudflare takes for each, so a second instance in one account never takes the first's.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initCommand,
  nameFromFolder,
  nameRefusal,
  nameResources,
  parseInitArgs,
} from "../../cli/init.mjs";

const TEMPLATE = readFileSync(
  join(import.meta.dirname, "..", "..", "template", "wrangler.jsonc"),
  "utf8",
);

/** Every Worker, database, and bucket name a wrangler config declares. */
const resourceNames = (config) =>
  [...config.matchAll(/"(?:name|database_name|bucket_name)":\s*"([^"]+)"/g)].map((m) => m[1]);

describe("nameFromFolder", () => {
  it("keeps a folder name that is already a valid instance name", () => {
    expect(nameFromFolder("/home/me/symbolsoup-newsletter")).toBe("symbolsoup-newsletter");
  });

  it("lowercases, and turns each run of other characters into one hyphen", () => {
    expect(nameFromFolder("/w/newsletter.example.com")).toBe("newsletter-example-com");
    expect(nameFromFolder("/w/My Wind_Break  News")).toBe("my-wind-break-news");
    expect(nameFromFolder("/w/--Café--")).toBe("cafe");
    expect(nameFromFolder("/w/Ｗｉｎｄ Brëak")).toBe("wind-break");
  });

  it("cuts a long name to the limit without leaving a hyphen at its end", () => {
    const name = nameFromFolder(`/w/${"a".repeat(45)}-tail`);
    expect(name).toBe("a".repeat(45));
    expect(nameRefusal(name)).toBeNull();
  });

  it("falls back to newsletter when nothing usable is left", () => {
    expect(nameFromFolder("/w/___")).toBe("newsletter");
  });
});

describe("nameRefusal", () => {
  it("takes lowercase letters, digits, and inner hyphens", () => {
    for (const name of ["a", "windbreak", "symbolsoup-newsletter", "2026-news"]) {
      expect(nameRefusal(name)).toBeNull();
    }
  });

  it("refuses capitals, other characters, an empty name, and a hyphen at either end", () => {
    for (const name of ["", "Windbreak", "wind_break", "wind.break", "-wind", "wind-"]) {
      expect(nameRefusal(name)).toMatch(/lowercase letters, digits, and hyphens/);
    }
  });

  it("refuses kestrel, the name instances made by earlier releases have", () => {
    expect(nameRefusal("kestrel")).toMatch(/earlier releases/);
    expect(nameRefusal("kestrel-two")).toBeNull();
  });

  it("takes up to 46 characters, so the bucket's name fits R2's 63", () => {
    expect(nameRefusal("a".repeat(46))).toBeNull();
    expect(`${"a".repeat(46)}-media-production`).toHaveLength(63);
    expect(nameRefusal("a".repeat(47))).toMatch(/at most 46/);
  });
});

describe("parseInitArgs", () => {
  it("reads the directory and --name in either order and spelling", () => {
    expect(parseInitArgs([])).toEqual({ dir: ".", name: undefined });
    expect(parseInitArgs(["site"])).toEqual({ dir: "site", name: undefined });
    expect(parseInitArgs(["--name", "windbreak", "site"])).toEqual({
      dir: "site",
      name: "windbreak",
    });
    expect(parseInitArgs(["site", "--name=windbreak"])).toEqual({
      dir: "site",
      name: "windbreak",
    });
  });

  it("refuses a bare --name, never taking it for the directory", () => {
    expect(() => parseInitArgs(["site", "--name"])).toThrow("--name needs a value");
  });

  it("refuses a misspelled flag, which read loosely would name the instance after its folder", () => {
    expect(() => parseInitArgs(["--nmae", "windbreak"])).toThrow("unknown option --nmae");
  });

  it("refuses a second directory", () => {
    expect(() => parseInitArgs(["site", "other"])).toThrow('unexpected argument "other"');
  });

  it("answers --help and -h as a request for help, wherever they stand", () => {
    expect(parseInitArgs(["--help"])).toEqual({ help: true });
    expect(parseInitArgs(["site", "-h"])).toEqual({ help: true });
    expect(parseInitArgs(["--nmae", "x", "--help"])).toEqual({ help: true });
  });
});

describe("nameResources", () => {
  it("renames every resource in the scaffold, development's included", () => {
    expect(resourceNames(nameResources(TEMPLATE, "windbreak"))).toEqual([
      "windbreak-dev",
      "windbreak-dev",
      "windbreak-media-dev",
      "windbreak-production",
      "windbreak-production",
      "windbreak-media-production",
    ]);
  });

  it("never gives two instances a Worker of the same name, whatever names they take", () => {
    const workers = (name) =>
      resourceNames(nameResources(TEMPLATE, name)).filter((_, i) => i === 0 || i === 3);
    const names = ["news", "news-dev", "news-production", "news-media", "news-production-dev"];
    const all = names.flatMap(workers);
    expect(new Set(all).size).toBe(all.length);
  });

  it("leaves the rest of the config as it was", () => {
    const named = nameResources(TEMPLATE, "windbreak");
    expect(named.replaceAll("windbreak", "kestrel")).toBe(TEMPLATE);
  });

  it("refuses a config whose names it doesn't find, rather than write one named kestrel", () => {
    expect(() => nameResources('{ "name": "other" }', "windbreak")).toThrow(/names 0 resources/);
  });
});

describe("initCommand", () => {
  let work;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "kestrel-init-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(work, { recursive: true, force: true });
  });

  it("names the instance after its folder", () => {
    const dir = join(work, "Symbol Soup");
    initCommand([dir]);
    const config = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
    expect(resourceNames(config)).toContain("symbol-soup-media-production");
    expect(resourceNames(config).filter((n) => n.startsWith("kestrel"))).toEqual([]);
  });

  it("names it after --name when given", () => {
    const dir = join(work, "site");
    initCommand([dir, "--name", "windbreak"]);
    const config = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
    expect(resourceNames(config)).toContain("windbreak-production");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name).toBe("windbreak");
  });

  it("refuses an invalid --name before writing anything", () => {
    expect(() => initCommand([join(work, "site"), "--name", "Wind_Break"])).toThrow(
      /^refused: "Wind_Break" isn't a valid instance name/,
    );
    expect(() => readFileSync(join(work, "site", "wrangler.jsonc"))).toThrow();
  });

  it("names the package after the instance, as the resources are", () => {
    const dir = join(work, "My.Site");
    initCommand([dir]);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name).toBe("my-site");
    expect(resourceNames(readFileSync(join(dir, "wrangler.jsonc"), "utf8"))).toContain(
      "my-site-production",
    );
  });
});
