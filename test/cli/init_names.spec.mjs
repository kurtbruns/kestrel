/*
 * The names `kestrel init` gives an instance's Worker, D1 database, and R2 bucket
 * (cli/init.mjs): made from the folder's name or `--name`, held to the characters and length
 * Cloudflare takes for each, so a second instance in one account never takes the first's.
 * And the hostnames `--hostname` and `--sending` write into the production block, each a bare
 * hostname off example.com, a value not given keeping the placeholder the Worker refuses.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fillHostnames,
  hostnameRefusal,
  hostnamesLine,
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
    expect(parseInitArgs([])).toEqual({ dir: "." });
    expect(parseInitArgs(["site"])).toEqual({ dir: "site" });
    expect(parseInitArgs(["--name", "windbreak", "site"])).toEqual({
      dir: "site",
      name: "windbreak",
    });
    expect(parseInitArgs(["site", "--name=windbreak"])).toEqual({
      dir: "site",
      name: "windbreak",
    });
  });

  it("reads --hostname and --sending in either spelling, beside --name and the directory", () => {
    expect(
      parseInitArgs([
        "--hostname",
        "newsletter.mysite.com",
        "site",
        "--sending=send.mysite.com",
        "--name",
        "windbreak",
      ]),
    ).toEqual({
      dir: "site",
      name: "windbreak",
      hostname: "newsletter.mysite.com",
      sending: "send.mysite.com",
    });
  });

  it("reads a bare flag as an empty value, which is refused, never as the directory", () => {
    expect(parseInitArgs(["site", "--name"])).toEqual({ dir: "site", name: "" });
    expect(parseInitArgs(["site", "--sending"])).toEqual({ dir: "site", sending: "" });
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

/** The production block's four hostname values, as init leaves them. */
const productionHosts = (config) => {
  const production = config.slice(config.indexOf('"production"'));
  const value = (key) => production.match(new RegExp(`"${key}":\\s*"([^"]*)"`))[1];
  return {
    pattern: value("pattern"),
    APP_ORIGIN: value("APP_ORIGIN"),
    SENDING_DOMAIN: value("SENDING_DOMAIN"),
    FROM_ADDRESS: value("FROM_ADDRESS"),
  };
};

const PLACEHOLDERS = {
  pattern: "newsletter.example.com",
  APP_ORIGIN: "https://newsletter.example.com",
  SENDING_DOMAIN: "send.example.com",
  FROM_ADDRESS: "newsletter@send.example.com",
};

describe("hostnameRefusal", () => {
  it("takes a bare hostname, capitals included", () => {
    for (const host of [
      "newsletter.mysite.com",
      "mysite.com",
      "send.my-site.co.uk",
      "News.MySite.com",
    ]) {
      expect(hostnameRefusal("--hostname", host)).toBeNull();
    }
  });

  it("refuses a scheme, a path, or a port", () => {
    for (const host of [
      "https://newsletter.mysite.com",
      "newsletter.mysite.com/",
      "newsletter.mysite.com:8787",
    ]) {
      expect(hostnameRefusal("--hostname", host)).toBe(
        `--hostname "${host}" isn't a bare hostname: give the name alone, with no scheme, path, or port`,
      );
    }
  });

  it("refuses an empty value, a single label, and characters a hostname can't hold", () => {
    expect(hostnameRefusal("--sending", "")).toBe(
      "--sending takes a hostname, such as send.mysite.com",
    );
    for (const host of [
      "localhost",
      "send..mysite.com",
      "send.mysite.com.",
      "-send.mysite.com",
      "send_x.mysite.com",
      "me@mysite.com",
    ]) {
      expect(hostnameRefusal("--sending", host)).toMatch(/isn't a hostname/);
    }
  });

  it("refuses example.com and any name under it, the placeholder the Worker refuses", () => {
    for (const host of ["example.com", "newsletter.example.com", "send.EXAMPLE.com"]) {
      expect(hostnameRefusal("--hostname", host)).toMatch(/is on example\.com/);
    }
    expect(hostnameRefusal("--hostname", "example.com.au")).toBeNull();
  });
});

describe("fillHostnames", () => {
  it("writes both hostnames into the production block, in the template's shape", () => {
    const filled = fillHostnames(TEMPLATE, {
      hostname: "newsletter.mysite.com",
      sending: "send.mysite.com",
    });
    expect(productionHosts(filled)).toEqual({
      pattern: "newsletter.mysite.com",
      APP_ORIGIN: "https://newsletter.mysite.com",
      SENDING_DOMAIN: "send.mysite.com",
      FROM_ADDRESS: "newsletter@send.mysite.com",
    });
  });

  it("leaves the development top level as it was", () => {
    const filled = fillHostnames(TEMPLATE, {
      hostname: "newsletter.mysite.com",
      sending: "send.mysite.com",
    });
    const top = (config) => config.slice(0, config.indexOf('"production"'));
    expect(top(filled)).toBe(top(TEMPLATE));
  });

  it("fills only the hostname given, keeping the other's placeholder", () => {
    expect(productionHosts(fillHostnames(TEMPLATE, { hostname: "news.mysite.com" }))).toEqual({
      ...PLACEHOLDERS,
      pattern: "news.mysite.com",
      APP_ORIGIN: "https://news.mysite.com",
    });
    expect(productionHosts(fillHostnames(TEMPLATE, { sending: "send.mysite.com" }))).toEqual({
      ...PLACEHOLDERS,
      SENDING_DOMAIN: "send.mysite.com",
      FROM_ADDRESS: "newsletter@send.mysite.com",
    });
  });

  it("changes nothing when neither is given", () => {
    expect(fillHostnames(TEMPLATE, {})).toBe(TEMPLATE);
  });

  it("refuses a config whose placeholder moved, rather than say a value was filled", () => {
    const moved = TEMPLATE.replace('"pattern": "newsletter.example.com"', '"pattern": "other"');
    expect(() => fillHostnames(moved, { hostname: "news.mysite.com" })).toThrow(/pattern/);
  });
});

describe("hostnamesLine", () => {
  it("says what was filled and what is still on example.com", () => {
    expect(hostnamesLine("news.mysite.com", "send.mysite.com")).toBe(
      "[init] production: the app on news.mysite.com (route and APP_ORIGIN), sending from newsletter@send.mysite.com (SENDING_DOMAIN and FROM_ADDRESS).",
    );
    expect(hostnamesLine(undefined, "send.mysite.com")).toBe(
      "[init] production: sending from newsletter@send.mysite.com (SENDING_DOMAIN and FROM_ADDRESS).\n" +
        "[init] still on example.com in wrangler.jsonc's production block: the route's pattern and APP_ORIGIN (--hostname).",
    );
    expect(hostnamesLine(undefined, undefined)).toBe(
      "[init] still on example.com in wrangler.jsonc's production block: the route's pattern and APP_ORIGIN (--hostname), SENDING_DOMAIN and FROM_ADDRESS (--sending).",
    );
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

  it("writes --hostname and --sending into production, lowercased", () => {
    const dir = join(work, "site");
    initCommand([dir, "--hostname", "News.MySite.com", "--sending", "send.mysite.com"]);
    expect(productionHosts(readFileSync(join(dir, "wrangler.jsonc"), "utf8"))).toEqual({
      pattern: "news.mysite.com",
      APP_ORIGIN: "https://news.mysite.com",
      SENDING_DOMAIN: "send.mysite.com",
      FROM_ADDRESS: "newsletter@send.mysite.com",
    });
  });

  it("keeps every placeholder without the flags", () => {
    const dir = join(work, "site");
    initCommand([dir]);
    expect(productionHosts(readFileSync(join(dir, "wrangler.jsonc"), "utf8"))).toEqual(
      PLACEHOLDERS,
    );
  });

  it("refuses a hostname with a scheme, or on example.com, before writing anything", () => {
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = join(work, "site");
    expect(() => initCommand([dir, "--hostname", "https://news.mysite.com"])).toThrow("exit");
    expect(() =>
      initCommand([dir, "--hostname", "news.mysite.com", "--sending", "send.example.com"]),
    ).toThrow("exit");
    expect(error.mock.calls.map((call) => call[0])).toEqual([
      '[init] refused: --hostname "https://news.mysite.com" isn\'t a bare hostname: give the name alone, with no scheme, path, or port.',
      '[init] refused: --sending "send.example.com" is on example.com, the scaffold\'s placeholder: give your own hostname.',
    ]);
    expect(() => readFileSync(join(dir, "wrangler.jsonc"))).toThrow();
  });

  it("refuses an invalid --name before writing anything", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => initCommand([join(work, "site"), "--name", "Wind_Break"])).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0][0]).toMatch(/refused: "Wind_Break" isn't a valid instance name/);
    expect(() => readFileSync(join(work, "site", "wrangler.jsonc"))).toThrow();
  });
});
