// Markup as a value. html`…` builds it and escapes every interpolation that is not already
// markup, so the safe path is the default: a subject, an email, a template a publisher typed
// can never break out of the element it is shown in. The unsafe path has a name to grep for.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for an HTML text node or a quoted attribute value. */
export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * Markup that is safe to put in the document. Only `html`, `unsafeHtml`, and what they
 * build produce one: the declared private field makes the type nominal, so a look-alike
 * object cannot pass as markup at compile time, and `instanceof` is what the runtime
 * checks, which a look-alike cannot pass either. An object rather than a branded string so
 * nesting can tell markup from text and never escape it twice. Frozen, so what was built is
 * what is set.
 */
export class Html {
  private declare readonly brand: undefined;
  readonly markup: string;
  constructor(markup: string) {
    this.markup = markup;
    Object.freeze(this);
  }
  toString(): string {
    return this.markup;
  }
}

/**
 * What an interpolation may be. Arrays flatten; `null`, `undefined`, and `false` render
 * nothing, so `${cond && html\`…\`}` reads plainly. `true` is not admitted: a bare boolean
 * in markup is a bug, not a value.
 */
export type Interpolation = Html | string | number | false | null | undefined | Interpolation[];

function toMarkup(value: Interpolation): string {
  if (value instanceof Html) {
    return value.markup;
  }
  if (value == null || value === false) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(toMarkup).join("");
  }
  return escapeHtml(value);
}

// A literal chunk that ends in `=` (optionally followed by whitespace) puts the next
// interpolation in an unquoted attribute value, where nothing escaping can do makes it safe.
const UNQUOTED_ATTRIBUTE = /=\s*$/;

/**
 * Build markup. Escaping makes exactly two contexts safe: text, and a quoted attribute
 * value whose meaning is text. It does nothing for a value that is code or a URL: not
 * `href`, `src`, `action`, `formaction` (a `javascript:` URL has no character to escape;
 * check the scheme first), not `srcdoc`, `style`, or an `on*` handler, and never inside
 * `<script>` or `<style>`, an attribute name, or a tag name. An interpolation in an
 * unquoted attribute value throws. A literal with an invalid escape sequence (`\u`, `\x`,
 * `\1`) throws rather than vanish: that is what the cooked string would do.
 */
export function html(strings: TemplateStringsArray, ...values: Interpolation[]): Html {
  let out = chunk(strings, 0);
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!(value instanceof Html) && UNQUOTED_ATTRIBUTE.test(out)) {
      throw new Error(
        "html: an interpolation in an unquoted attribute value cannot be made safe; quote it",
      );
    }
    out += toMarkup(value) + chunk(strings, i + 1);
  }
  return new Html(out);
}

function chunk(strings: TemplateStringsArray, i: number): string {
  const s = strings[i];
  if (s === undefined) {
    throw new Error(
      `html: invalid escape sequence in template text near ${JSON.stringify(strings.raw[i])}`,
    );
  }
  return s;
}

/**
 * Markup the tag did not build: server-rendered HTML the API returns, or markup a module
 * still assembles by hand. The caller vouches for it. Grep for this name when auditing.
 */
export function unsafeHtml(markup: string): Html {
  return new Html(markup);
}

/**
 * Put markup in an element: the one place strings reach innerHTML. The runtime check
 * holds the line where the type checker cannot see (a spec's cast, a value that crossed
 * an `unknown`): a string here is a bug, and it fails loud rather than render the word
 * "undefined".
 */
export function setHtml(el: Element, markup: Html): void {
  if (!(markup instanceof Html)) {
    throw new Error(
      "setHtml: expected Html; build it with html`…` or vouch for it with unsafeHtml()",
    );
  }
  el.innerHTML = markup.markup;
}
