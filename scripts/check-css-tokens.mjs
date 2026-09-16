#!/usr/bin/env node
/*
 * Lint the admin SPA's design tokens (DESIGN §3).
 *
 * This is a framework-free, no-build app: a `var(--typo)` silently falls back to
 * nothing, and there is no compiler to catch a mistyped or renamed token. Two rules
 * from DESIGN §3 are stated there but nothing enforced them — this script does:
 *
 *   1. Every `var(--x)` with no fallback (styles.css or app.js) resolves to a token
 *      declared somewhere — a `:root` theme token or a component-scoped one. This is
 *      what makes a token *rename* safe: drop a definition without updating a
 *      reference and it becomes a build failure here, not a silent wrong color in the
 *      browser. `var(--x, fallback)` is a deliberate optional hook and is exempt.
 *   2. Every color-valued token has BOTH a light and a dark value — "a color defined
 *      in only one theme is a bug" (DESIGN §3). Non-color tokens (the z-index ladder,
 *      font stacks) are theme-independent and exempt by their value shape; a token
 *      that only aliases another (`var(--x)`) tracks that token across themes and so
 *      needs no dark value of its own.
 *
 * Wired into `pretest` beside the asset-stamp check, so the quality gate catches a
 * dangling reference or a single-theme color. Pure Node, no dependencies.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN = join(ROOT, "public", "dashboard");
const CSS = join(ADMIN, "styles.css");
const JS = join(ADMIN, "app.js");

/* Custom properties set at runtime from JS (never declared in :root), so a var()
 * reference to one is legitimate even though no static definition exists. */
const RUNTIME_TOKENS = new Set(["--tip-x"]);

/** Index of the `}` that closes the `{` at `openIdx` (brace-depth match). */
function matchBrace(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") {
      depth++;
    } else if (text[i] === "}" && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** Body text of the first `:root { … }` at or after `from`. */
function rootBody(text, from = 0) {
  const at = text.indexOf(":root", from);
  if (at === -1) {
    return "";
  }
  const open = text.indexOf("{", at);
  return text.slice(open + 1, matchBrace(text, open));
}

/** Map of `--name` → declared value for every custom property in a block body. */
function declsIn(body) {
  const map = new Map();
  const re = /(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    map.set(m[1], m[2].trim());
  }
  return map;
}

/** Token names referenced by a `var(--x)` with NO fallback — those are the ones that
 *  must resolve, since `var(--x, …)` is a deliberate optional-override hook that is
 *  safe when `--x` is undefined. */
function requiredRefs(text) {
  const set = new Set();
  const re = /var\(\s*(--[A-Za-z0-9-]+)\s*(,|\))/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[2] === ")") {
      set.add(m[1]);
    }
  }
  return set;
}

/** Every custom property declared anywhere in the stylesheet — `:root` theme tokens
 *  plus component-scoped ones (a layout dimension on `.layout`, say). A reference
 *  resolves as long as *some* declaration exists, which is all a rename needs: drop a
 *  definition without updating its references and the name resolves nowhere. */
function allDecls(text) {
  const set = new Set();
  const re = /(--[A-Za-z0-9-]+)\s*:/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    set.add(m[1]);
  }
  return set;
}

const css = await readFile(CSS, "utf8");
const js = await readFile(JS, "utf8");

// Light `:root` is the first one; the dark override is the `:root` nested in the
// `@media (prefers-color-scheme: dark)` block.
const lightDefs = declsIn(rootBody(css, 0));
const darkNames = new Set(declsIn(rootBody(css, css.indexOf("prefers-color-scheme: dark"))).keys());
const declared = allDecls(css);
const refs = new Set([...requiredRefs(css), ...requiredRefs(js)]);

/** A value that carries a literal color (not just aliases to other tokens). */
const hasLiteralColor = (v) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/.test(v);

const errors = [];

// 1 — no dangling references (the rename safety net).
for (const t of [...refs].sort()) {
  if (!declared.has(t) && !RUNTIME_TOKENS.has(t)) {
    errors.push(`undefined token: var(${t}) is referenced (no fallback) but never declared`);
  }
}

// 2 — every literal-color token exists in both themes.
for (const [t, v] of [...lightDefs].sort()) {
  if (hasLiteralColor(v) && !darkNames.has(t)) {
    errors.push(`single-theme color: ${t} has a light value but no dark override`);
  }
}
for (const t of [...darkNames].sort()) {
  if (!lightDefs.has(t)) {
    errors.push(`dark-only token: ${t} is in the dark block but not in light :root`);
  }
}

if (errors.length) {
  console.error(`[tokens] ${errors.length} problem(s):`);
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}
console.log(
  `[tokens] ok — ${lightDefs.size} tokens declared, ${refs.size} referenced; every reference resolves and every color has light + dark`,
);
