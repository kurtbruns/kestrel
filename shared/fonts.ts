// The app's two font stacks (SPEC §5, DESIGN §2), the one place they are named: the reader
// pages, the post page's masthead, the built-in email template and the editor's starting
// templates, the styled subscribe embed, and the system emails all read them from here. The
// editor's stylesheet can't import a module, so a spec holds its copies equal to these.
//
// Both name only fonts a reader already has, with a generic family last. A mail client ignores
// web fonts, and a sent email keeps the font names it was frozen with for good (I3), so a font
// that had to be downloaded would show on some pages and never in the inbox. Georgia is what
// every post already sent names, so the pages around it name it too, and a reader page asks no
// other host for anything.

/** The serif: post headings, the publication's name, and the sign-off. */
export const SERIF_STACK = "Georgia, 'Times New Roman', serif";

/** The sans: everything else a reader reads. */
export const SANS_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** A stack as an inline `style` attribute spells it, with no space after each comma. The same
 *  families in the same order; the spelling is kept because it is already in every email sent
 *  (I3), so a new email's bytes don't move with this module. */
export function inlineStack(stack: string): string {
  return stack.replaceAll(", ", ",");
}

/**
 * Every serif stack a page, an email, a template, or a stylesheet names, each spelled as
 * `SERIF_STACK` is (one space after each comma, single quotes): the run of families before
 * each generic `serif`. Comments are left out, so a sentence about fonts isn't read as one.
 * Only specs call it: the specs that hold every surface to `SERIF_STACK` read through
 * this, and it lives here so the Worker's and the editor's test projects share one copy.
 */
export function serifStacksNamed(text: string): string[] {
  const source = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll('"', "'");
  const family = String.raw`(?:'[^']*'|[A-Za-z][\w -]*?)`;
  const familiesBefore = new RegExp(String.raw`((?:${family}\s*,\s*)+)$`);
  const stacks: string[] = [];
  for (const m of source.matchAll(/(?<![\w-])serif(?![\w-])/g)) {
    const families = familiesBefore.exec(source.slice(0, m.index))?.[1] ?? "";
    const names = families
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f !== "");
    stacks.push([...names, "serif"].join(", "));
  }
  return stacks;
}
