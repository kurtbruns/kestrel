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
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/**
 * Markup that is safe to put in the document. Only `html`, `unsafeHtml`, and what they
 * build produce one; a plain string never is, which is what the type checker enforces at
 * `setHtml`. An object rather than a branded string so nesting can tell markup from text
 * at runtime and never escape it twice.
 */
export class Html {
  constructor(readonly markup: string) {}
  toString(): string {
    return this.markup;
  }
}

/** What an interpolation may be. Arrays flatten; `null`, `undefined`, and `false` render nothing. */
export type Interpolation = Html | string | number | boolean | null | undefined | Interpolation[];

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

/**
 * Build markup. Interpolate only inside text or a *quoted* attribute value; escaping is
 * what makes those two contexts safe, and nothing makes an unquoted attribute safe.
 */
export function html(strings: TemplateStringsArray, ...values: Interpolation[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += toMarkup(values[i]) + (strings[i + 1] ?? "");
  }
  return new Html(out);
}

/**
 * Markup the tag did not build: server-rendered HTML the API returns, or markup a module
 * still assembles by hand. The caller vouches for it. Grep for this name when auditing.
 */
export function unsafeHtml(markup: string): Html {
  return new Html(markup);
}

/** Put markup in an element. In converted code this is the one place strings reach innerHTML. */
export function setHtml(el: Element, markup: Html): void {
  el.innerHTML = markup.markup;
}
