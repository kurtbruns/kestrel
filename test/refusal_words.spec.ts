// The words of every refusal the API returns, and every warning a render hands back, are shown
// to the publisher as they stand (DESIGN §5, §10), so they follow the copy rules: no em dash,
// which reads as a pause in speech rather than a sentence, and typographic apostrophes. A
// refusal's message is written at the call that makes it, in a constant that call names, or in
// a helper that builds it, so the check reads those in the source, where every one is
// visible, rather than the few a request can reach in a test.

import { describe, expect, it } from "vitest";

// Every file under src/, as text.
const SOURCES = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

// The shared modules, for the message builders the Worker's refusals and conditions use.
const SHARED = import.meta.glob("../shared/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

// The calls whose arguments carry a message a client shows: the error helpers
// (src/lib/errors.ts, src/lib/body.ts), the errors built directly, a refusal helper of a
// module's own, the warnings and template errors a render returns, and the helpers that build
// a message from words their callers pass (a settings field's name, the act a closed review
// window refuses).
const MESSAGE_CALL =
  /\b(?:refusal|refuse|badRequest|fieldError|conflict|notFound|forbidden|unauthorized|unsupportedMediaType|new HttpError|new SettingsFieldError|warnings\.push|errors\.push|normalizeText|windowClosed)\(/g;

// A list of warnings written out whole (a settings save's, with one of its own added) carries
// its messages as the list's items.
const MESSAGE_LIST = /\bwarnings\s*=\s*\[/g;

// An error body written out as an object literal (a save's `base_required`, say) carries its
// message as a `message:` property.
const MESSAGE_PROPERTY = /\bmessage:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;

// The message builders in shared/ whose words a refusal or condition carries as they stand,
// by file. Each must be found, so a rename can't drop one from the check unnoticed.
const SHARED_BUILDERS: Record<string, string[]> = {
  "../shared/sends.ts": ["NOT_CONNECTED_ADVICE", "refusalAdvice", "tooSoonMessage"],
};

/** The source with its comments removed, since a comment is never sent. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The argument list of the call whose opening parenthesis ends at `from` (or the items of
 *  the list whose opening bracket does, given `[` and `]`). */
function argumentsFrom(text: string, from: number, open = "(", close = ")"): string {
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    if (text[i] === open) {
      depth += 1;
    } else if (text[i] === close) {
      depth -= 1;
    }
    i += 1;
  }
  return text.slice(from, i - 1);
}

const isQuote = (ch: string | undefined) => ch === '"' || ch === "'" || ch === "`";

/** Where the template interpolation whose `${` starts at `start` ends, just past its `}`. */
function interpolationEnd(text: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < text.length && depth > 0) {
    if (isQuote(text[i])) {
      i = literalEnd(text, i);
    } else if (text[i] === "{") {
      depth += 1;
    } else if (text[i] === "}") {
      depth -= 1;
    }
    i += 1;
  }
  return i;
}

/** Where the string literal opening at `start` closes (the index of its closing quote). */
function literalEnd(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length && text[i] !== quote) {
    if (text[i] === "\\") {
      i += 2;
    } else if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
      i = interpolationEnd(text, i);
    } else {
      i += 1;
    }
  }
  return i;
}

/** The words of every string literal in `text`, a template's interpolations read on their own. */
function literals(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!isQuote(text[i])) {
      continue;
    }
    const end = literalEnd(text, i);
    if (text[i] !== "`") {
      out.push(text.slice(i + 1, end));
      i = end;
      continue;
    }
    let words = "";
    let j = i + 1;
    while (j < end) {
      if (text[j] === "\\") {
        words += text.slice(j, j + 2);
        j += 2;
      } else if (text[j] === "$" && text[j + 1] === "{") {
        const close = interpolationEnd(text, j);
        out.push(...literals(text.slice(j + 2, close - 1)));
        words += " ";
        j = close;
      } else {
        words += text[j];
        j += 1;
      }
    }
    out.push(words);
    i = end;
  }
  return out;
}

/**
 * The text a declaration spans from `from`: to the first `;` outside any bracket for a
 * constant's value, or to the closing brace of a function's body.
 */
function declarationFrom(text: string, from: number): string {
  const isFunction = /^\s*function\b/.test(text.slice(from));
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (isQuote(ch)) {
      i = literalEnd(text, i);
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (isFunction && depth === 0 && ch === "}") {
        return text.slice(from, i + 1);
      }
    } else if (ch === ";" && depth === 0) {
      return text.slice(from, i);
    }
  }
  return text.slice(from);
}

/**
 * The constants a message names, declared in the same file: a call that passes a constant (or
 * interpolates a local) carries that constant's words, so they are read too, and so are the
 * constants those name in turn. A name read as an object (`send.status`), called, or written
 * as a property key is not a message.
 */
function namedConstants(
  text: string,
  args: string,
  file: string,
  seen: Set<string>,
): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  const bare = args.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
  const names = new Set(
    [...bare.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?!\s*[.(:\w$])/g)].map((m) => m[1] ?? ""),
  );
  for (const name of names) {
    const declared = new RegExp(
      `\\b(?:const|let)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=;]+)?=`,
      "g",
    );
    for (const d of text.matchAll(declared)) {
      const key = `${file}:${d.index}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const value = declarationFrom(text, (d.index ?? 0) + d[0].length);
      out.push({ where: `${file}: ${name}`, text: value });
      out.push(...namedConstants(text, value, file, seen));
    }
  }
  return out;
}

/** Every message the source writes, with where it is. */
function messages(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const [file, raw] of Object.entries(SOURCES)) {
    const text = code(raw);
    const seen = new Set<string>();
    for (const m of text.matchAll(MESSAGE_CALL)) {
      const args = argumentsFrom(text, (m.index ?? 0) + m[0].length);
      out.push({ where: `${file}: ${m[0]}`, text: args });
      out.push(...namedConstants(text, args, file, seen));
    }
    for (const m of text.matchAll(MESSAGE_LIST)) {
      const items = argumentsFrom(text, (m.index ?? 0) + m[0].length, "[", "]");
      out.push({ where: `${file}: ${m[0]}`, text: items });
      out.push(...namedConstants(text, items, file, seen));
    }
    for (const m of text.matchAll(MESSAGE_PROPERTY)) {
      out.push({ where: `${file}: message:`, text: m[2] ?? "" });
    }
  }
  for (const [file, names] of Object.entries(SHARED_BUILDERS)) {
    const text = code(SHARED[file] ?? "");
    for (const name of names) {
      const at = new RegExp(`export (?:const ${name}\\s*=|(?=function ${name}\\())`).exec(text);
      if (at) {
        out.push({
          where: `${file}: ${name}`,
          text: declarationFrom(text, at.index + at[0].length),
        });
      }
    }
  }
  return out;
}

const EM_DASH = /—|\\u2014|&mdash;/;
// A straight apostrophe inside a word ("don't", "SES's"), where the copy uses ’.
const STRAIGHT_APOSTROPHE = /\w'\w/;
// Refusals no page can meet, only a hand-written API call: a cross-site request and a cursor
// from a reset database. They are written for Claude and API clients, in plain ASCII, so the
// apostrophe rule for the publisher's copy doesn't hold them.
const API_ONLY = ['"cross_site_request"', '"cursor_ahead"'];

describe("the words the API shows the publisher", () => {
  const found = messages();

  it("reads the refusals it is meant to check, wherever their words are written", () => {
    // Each shape a message takes in the tree, by a site known to use it, so a pattern that
    // stopped matching can't pass for a clean tree.
    const has = (file: string, words: string) =>
      found.some((m) => m.where.startsWith(`../${file}:`) && m.text.includes(words));
    expect(has("src/routes/posts.ts", "This post is scheduled, so it’s locked.")).toBe(true);
    expect(has("src/send/schedule.ts", '"fire_at_too_soon"')).toBe(true);
    // A constant the call passes, and a local its message interpolates.
    expect(has("src/send/schedule.ts", "This post already has a send scheduled")).toBe(true);
    expect(has("src/send/schedule.ts", "its fire time has passed")).toBe(true);
    // A constant added to a list of warnings.
    expect(has("src/routes/settings.ts", "but this template doesn’t include")).toBe(true);
    // A helper that builds its message from the words its callers pass.
    expect(has("src/db/settings.ts", "must be text.")).toBe(true);
    expect(has("src/db/settings.ts", '"The publication name"')).toBe(true);
    // The shared builders.
    expect(has("shared/sends.ts", "so there’s time to cancel")).toBe(true);
    expect(has("shared/sends.ts", "Service Quotas console")).toBe(true);
    expect(has("shared/sends.ts", "Connect Amazon SES")).toBe(true);
    expect(found.length).toBeGreaterThan(100);
  });

  it("never carry an em dash, in any refusal or render warning (DESIGN §10)", () => {
    const dashed = found.filter((m) => EM_DASH.test(m.text)).map((m) => `${m.where} ${m.text}`);
    expect(dashed).toEqual([]);
  });

  it("use a typographic apostrophe, never a straight one, in their words (DESIGN §10)", () => {
    const straight = found
      .filter((m) => !API_ONLY.some((code) => m.text.includes(code)))
      .filter((m) => literals(m.text).some((words) => STRAIGHT_APOSTROPHE.test(words)))
      .map((m) => `${m.where} ${m.text}`);
    expect(straight).toEqual([]);
  });

  it("leaves the refusals only an API call meets in plain ASCII", () => {
    for (const code of API_ONLY) {
      const message = found.find((m) => m.text.includes(code));
      expect(message, code).toBeDefined();
      expect(message?.text).not.toMatch(/[’“”]/);
    }
  });

  it("reads a message wherever the call writes it, across lines and inside an interpolation", () => {
    // The check is only as good as its reading of the source: hold it to the shapes the
    // tree uses, with the dash in each place a message can put one.
    const sample = (src: string) => {
      const text = code(src);
      return [...text.matchAll(MESSAGE_CALL)].map((m) =>
        argumentsFrom(text, (m.index ?? 0) + m[0].length),
      );
    };
    expect(sample('throw badRequest("no — wait");')[0]).toMatch(EM_DASH);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text holding an interpolation, not a value
    expect(sample('throw refusal(\n  409,\n  "code",\n  `a ${f(x)} — b`,\n);')[0]).toMatch(EM_DASH);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text holding an interpolation, not a value
    expect(sample("warnings.push(`x (y) — ${z}`);")[0]).toMatch(EM_DASH);
    expect(sample('// throw badRequest("a — b");\nthrow badRequest("fine");')).toEqual(['"fine"']);
    const body = 'return json({ error: "x", message: "a — b" });';
    expect([...code(body).matchAll(MESSAGE_PROPERTY)][0]?.[2]).toMatch(EM_DASH);
  });

  it("reads a constant the call names, and the constants that one names in turn", () => {
    const text = code(
      [
        `const WHY = "it can't";`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text holding an interpolation, not a value
        "const MSG = `No — ${WHY}.`;",
        `const send = { status: "isn't a message" };`,
        'throw refusal(409, "x", MSG, { send: send.status });',
      ].join("\n"),
    );
    const call = [...text.matchAll(MESSAGE_CALL)][0];
    const args = argumentsFrom(text, (call?.index ?? 0) + (call?.[0].length ?? 0));
    const named = namedConstants(text, args, "f.ts", new Set());
    expect(named.map((n) => n.where)).toEqual(["f.ts: MSG", "f.ts: WHY"]);
    expect(named[0]?.text).toMatch(EM_DASH);
    expect(literals(named[1]?.text ?? "").some((w) => STRAIGHT_APOSTROPHE.test(w))).toBe(true);
  });

  it("reads only a literal's words for apostrophes, never the code around it", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text holding an interpolation, not a value
    expect(literals("refusal(409, 'code', `It’s ${a['b']} now`)")).toEqual([
      "code",
      "b",
      "It’s   now",
    ]);
    expect(literals(`badRequest("Don't")`).some((w) => STRAIGHT_APOSTROPHE.test(w))).toBe(true);
  });
});
