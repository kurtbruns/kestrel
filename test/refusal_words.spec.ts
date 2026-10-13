// The words of every refusal the API returns, and every warning a render hands back, are shown
// to the publisher as they stand (DESIGN §5, §10), so they follow the copy rules: no em dash,
// which reads as a pause in speech rather than a sentence. A refusal's message is written at
// the call that makes it, so the check reads those calls in the source, where every one is
// visible, rather than the few a request can reach in a test.

import { describe, expect, it } from "vitest";

// Every file under src/, as text.
const SOURCES = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

// The calls whose arguments carry a message a client shows: the error helpers
// (src/lib/errors.ts, src/lib/body.ts), the errors built directly, a refusal helper of a
// module's own, and the warnings and template errors a render returns.
const MESSAGE_CALL =
  /\b(?:refusal|refuse|badRequest|fieldError|conflict|notFound|forbidden|unauthorized|unsupportedMediaType|new HttpError|new SettingsFieldError|warnings\.push|errors\.push)\(/g;

// An error body written out as an object literal (a save's `base_required`, say) carries its
// message as a `message:` property.
const MESSAGE_PROPERTY = /\bmessage:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;

/** The source with its comments removed, since a comment is never sent. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The argument list of the call whose opening parenthesis ends at `from`. */
function argumentsFrom(text: string, from: number): string {
  let depth = 1;
  let i = from;
  while (i < text.length && depth > 0) {
    if (text[i] === "(") {
      depth += 1;
    } else if (text[i] === ")") {
      depth -= 1;
    }
    i += 1;
  }
  return text.slice(from, i - 1);
}

/** Every message the source writes, with where it is. */
function messages(): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const [file, raw] of Object.entries(SOURCES)) {
    const text = code(raw);
    for (const m of text.matchAll(MESSAGE_CALL)) {
      const start = (m.index ?? 0) + m[0].length;
      out.push({ where: `${file}: ${m[0]}`, text: argumentsFrom(text, start) });
    }
    for (const m of text.matchAll(MESSAGE_PROPERTY)) {
      out.push({ where: `${file}: message:`, text: m[2] ?? "" });
    }
  }
  return out;
}

const EM_DASH = /—|\\u2014|&mdash;/;

describe("the words the API shows the publisher", () => {
  it("never carry an em dash, in any refusal or render warning (DESIGN §10)", () => {
    const found = messages();
    // The scan found the calls it is meant to check, so a pattern that matched nothing
    // can't pass for a clean tree.
    expect(found.length).toBeGreaterThan(150);
    const dashed = found.filter((m) => EM_DASH.test(m.text)).map((m) => `${m.where} ${m.text}`);
    expect(dashed).toEqual([]);
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
});
