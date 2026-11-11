/*
 * The instance a folder names: what `kestrel api` calls when nothing else names one, the way
 * `gh` takes a repository from the checkout's remote.
 *
 * An instance's repository says its own address: `wrangler.jsonc`'s `production` block sets
 * `APP_ORIGIN`. So the folder's instance is the one `APP_ORIGIN` across the `env.*` blocks that
 * isn't a loopback address; the top level's is the dev server's and is ignored. Only the
 * current folder counts, never a parent, and only when its `package.json` depends on
 * `@kurtbruns/kestrel`, so another project's Worker is never taken for an instance and a call
 * is never sent somewhere nobody meant. An origin still on the template's example.com
 * placeholder counts as unset, the rule the Worker refuses to run by (src/env.ts), restated
 * here since the client imports nothing of the Worker's. A file that can't be read or parsed
 * is the same as no file. Plain Node, no dependency: the JSONC is read by a small parse of
 * its own.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INSTANCE_PACKAGE } from "./handoff.mjs";
import { isLoopback } from "./oauth.mjs";

/**
 * JSONC's text as JSON: its `//` and `/* *\/` comments and its trailing commas dropped,
 * leaving anything inside a string as it is, so a URL's `//` survives.
 */
export function stripJsonc(text) {
  return dropTrailingCommas(dropComments(text));
}

/** The index just past the string that opens at `text[i]`; a backslash escapes what follows. */
function stringEnd(text, i) {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') {
    j += text[j] === "\\" ? 2 : 1;
  }
  return j + 1;
}

function dropComments(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      // Kept as a space, so a comment between two tokens never joins them.
      out += " ";
      i = end === -1 ? text.length : end + 2;
    } else {
      out += text[i++];
    }
  }
  return out;
}

// Run on text with its comments gone, so only whitespace can stand between a trailing comma
// and the bracket it trails.
function dropTrailingCommas(text) {
  const closes = /\s*[}\]]/y;
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text[i] === ",") {
      closes.lastIndex = i + 1;
      if (!closes.test(text)) {
        out += ",";
      }
      i++;
    } else {
      out += text[i++];
    }
  }
  return out;
}

/** Whether `host` is the template's placeholder: example.com or a subdomain of it. */
export function isPlaceholderHost(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "example.com" || h.endsWith(".example.com");
}

/** `file`'s JSON, or undefined when it can't be read or parsed. */
function readJson(file, jsonc = false) {
  try {
    const text = readFileSync(file, "utf8");
    return JSON.parse(jsonc ? stripJsonc(text) : text);
  } catch {
    return undefined;
  }
}

/**
 * The origins `dir`'s instance names: each distinct non-loopback, non-placeholder `APP_ORIGIN`
 * across its `wrangler.jsonc`'s `env.*` blocks, in the order they appear. Empty when `dir`
 * isn't an instance (no `wrangler.jsonc` that parses, or a `package.json` that doesn't depend
 * on the instance package) or names none. One is the folder's instance; more than one is for
 * the caller to refuse.
 */
export function folderOrigins(dir = process.cwd()) {
  const pkg = readJson(join(dir, "package.json"));
  const depends = [pkg?.dependencies, pkg?.devDependencies].some(
    (deps) => deps && typeof deps === "object" && INSTANCE_PACKAGE in deps,
  );
  if (!depends) {
    return [];
  }
  const config = readJson(join(dir, "wrangler.jsonc"), true);
  const envs = config?.env && typeof config.env === "object" ? Object.values(config.env) : [];
  const origins = [];
  for (const block of envs) {
    const value = block?.vars?.APP_ORIGIN;
    if (typeof value !== "string") {
      continue;
    }
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      continue;
    }
    if (isLoopback(url.origin) || isPlaceholderHost(url.hostname)) {
      continue;
    }
    if (!origins.includes(url.origin)) {
      origins.push(url.origin);
    }
  }
  return origins;
}
