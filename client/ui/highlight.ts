// Syntax highlighting for the template editor (HTML/CSS with template tokens), the post
// composer (Markdown), and the code examples in the API reference and the docs (JSON, JSONC,
// and shell). String assembly by nature: the source is escaped first, then the escaped text
// is decorated with spans, so the result is vouched for as markup at the boundary rather than
// built with the html tag.

import { Lexer, type Token } from "marked";
import { escapeHtml as esc, type Html, unsafeHtml } from "./html";

// --- template syntax highlighting ---
// A small tokenizer for the overlay editor: colors the {{ tokens }}, HTML tags and
// attribute strings, and — inside the <style> block — CSS selectors, properties,
// colors and at-rules. Logic-less templates need nothing heavier, so this stays
// inside the dashboard's framework-free, no-build ethos (no CodeMirror, no bundler).
function hlTokens(s: string): string {
  return s.replace(/\{\{\s*(?:if\s+)?[\w.]+\s*\}\}/g, (m) => `<span class="cx-var">${m}</span>`);
}
function hlHtml(raw: string): string {
  let s = esc(raw);
  s = s.replace(/&quot;[^&]*?&quot;/g, (m) => `<span class="cx-str">${m}</span>`);
  s = s.replace(
    /(&lt;\/?)([a-zA-Z][\w-]*)/g,
    (_m, br, name) => `<span class="cx-punct">${br}</span><span class="cx-tag">${name}</span>`,
  );
  s = s.replace(/(\/?)&gt;/g, (_m, sl) => `<span class="cx-punct">${sl}&gt;</span>`);
  return hlTokens(s);
}
function hlCss(raw: string): string {
  let s = esc(raw);
  s = s.replace(/&quot;[^&]*?&quot;/g, (m) => `<span class="cx-str">${m}</span>`);
  s = s.replace(/#[0-9a-fA-F]{3,8}\b/g, (m) => `<span class="cx-num">${m}</span>`);
  s = s.replace(/@[\w-]+/g, (m) => `<span class="cx-at">${m}</span>`);
  s = s.replace(
    /^(\s*)(?![@\s])([^\n{}<]+?)(\s*)\{$/gm,
    (_m, ind, sel, sp) => `${ind}<span class="cx-sel">${sel}</span>${sp}{`,
  );
  s = s.replace(
    /^(\s*)([a-z-]+)(\s*:)/gm,
    (_m, ind, prop, colon) => `${ind}<span class="cx-prop">${prop}</span>${colon}`,
  );
  return hlTokens(s);
}
/** The template source as highlighted markup for the overlay editor. */
export function highlightTemplate(src: string): Html {
  return unsafeHtml(
    String(src)
      .split(/(<style>[\s\S]*?<\/style>)/)
      .map((seg) => {
        const m = seg.match(/^<style>([\s\S]*?)<\/style>$/);
        if (m) {
          return `<span class="cx-punct">&lt;</span><span class="cx-tag">style</span><span class="cx-punct">&gt;</span>${hlCss(m[1] ?? "")}<span class="cx-punct">&lt;/</span><span class="cx-tag">style</span><span class="cx-punct">&gt;</span>`;
        }
        return hlHtml(seg);
      })
      .join(""),
  );
}

// --- post (Markdown) syntax highlighting ---
// highlightTemplate()'s counterpart for the post editor: the same transparent-textarea-
// over-highlighted-<pre> overlay, tokenizing Markdown instead of HTML/CSS. The scheme is
// deliberately minimal (Sublime-style): it colors the *marks* an author scans for — the #, >,
// list bullets, the emphasis *asterisks*, a link's URL — and leaves the CONTENT in the font
// color, carrying only weight/slant. So a bold word reads as weight, not as a color that could
// be confused with a heading. It is a light, line-oriented pass over the shared --syntax-*
// palette, except for links, which marked decides (below).

// Whether link Markdown becomes a link is marked's call, and its rules are subtler than a
// pattern can follow: an address ends at a space unless it's in <…>, its parentheses must
// balance, a stray ")" cuts it short, and what counts shifts between marked's releases. So the
// highlighter asks the renderer's own lexer, with the renderer's options (src/render/markdown.ts),
// and colors an address only where the email will have a link. Text shaped like a link that
// marked won't make one is marked broken, so the publisher sees it where they type, not only in
// the Preview's warning.
const MARKED_INLINE = { gfm: true, breaks: false } as const;
/** Text written as a link: brackets, then an address in parentheses on the same line. */
const LINK_SHAPED = /^!?\[[^\]\n]*\]\([^)\n]*\)/;

/** Where marked makes a link or image in one line: its offset in the line, and its source. A
 *  link inside emphasis is found by walking into the emphasis, whose source holds its own. */
function markedLinks(line: string): Map<number, string> {
  const found = new Map<number, string>();
  const walk = (tokens: Token[], src: string, base: number) => {
    let cursor = 0;
    for (const t of tokens) {
      const at = src.indexOf(t.raw, cursor);
      if (at < 0) {
        continue;
      }
      if ((t.type === "link" || t.type === "image") && !("autolink" in t && t.autolink)) {
        found.set(base + at, t.raw);
      } else if ("tokens" in t && t.tokens) {
        walk(t.tokens, t.raw, base + at);
      }
      cursor = at + t.raw.length;
    }
  };
  walk(Lexer.lexInline(line, MARKED_INLINE), line, 0);
  return found;
}

// Inline constructs within one line, in a single left-to-right pass. One alternation consumes
// each construct whole so we never re-tokenize inside a span we just emitted (the classic bug
// from chaining .replace() calls — an italic pass eating a bold marker). Marks are colored, the
// content plain: emphasis asterisks are pink and the word carries only weight/slant; a link's
// text stays plain and only its URL is treated; inline `code` sits on a chip. Order at a given
// position: `code`, a backslash escape (plain, so an escaped \[ is never a link), a [ or ![
// that may open a link, then **strong** before *em*. Single-underscore _em_ is guarded by \b
// so intra-word underscores (snake_case, price_1) stay literal, not emphasized.
const MD_INLINE =
  /(`[^`\n]+`)|(\\[!-/:-@[-`{-~])|(!?\[)|(\*\*|__)([^\n]+?)\4|\*([^*\n]+?)\*|\b_([^_\n]+?)_\b/g;
/** `src` (a run of `line` starting at `base`) highlighted, with the links marked made in `links`. */
function hlMdRun(src: string, base: number, links: Map<number, string>): string {
  let out = "";
  let last = 0;
  const re = new RegExp(MD_INLINE);
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const [whole, code, escaped, open, bd, btext, aem, uem] = m;
    out += esc(src.slice(last, m.index));
    let end = m.index + whole.length;
    if (code !== undefined) {
      out += `<span class="cx-md-code">${esc(code)}</span>`;
    } else if (escaped !== undefined) {
      out += esc(escaped);
    } else if (open !== undefined) {
      const rest = src.slice(m.index);
      const link = links.get(base + m.index);
      const shaped = link === undefined ? LINK_SHAPED.exec(rest) : null;
      if (link !== undefined) {
        // Link/image: text + brackets stay plain; only what's in the parentheses is treated.
        // The address opens at the first "](" past the label's own brackets.
        const opens = labelEnd(link) + 2;
        out += `${esc(link.slice(0, opens))}<span class="cx-md-url">${esc(link.slice(opens, -1))}</span>)`;
        end = m.index + link.length;
      } else if (shaped) {
        out += `<span class="cx-md-broken">${esc(shaped[0])}</span>`;
        end = m.index + shaped[0].length;
      } else {
        // Not a link here. A "!" may still sit before one, so step past only the first mark.
        out += esc(open.charAt(0));
        end = m.index + 1;
      }
    } else if (bd !== undefined && btext !== undefined) {
      const inner = m.index + bd.length;
      out += `<span class="cx-md-mark">${bd}</span><span class="cx-md-strong">${hlMdRun(btext, base + inner, links)}</span><span class="cx-md-mark">${bd}</span>`;
    } else {
      // Emphasis: asterisk and underscore share the same treatment; the delimiter is a literal.
      const [d, text] = aem !== undefined ? ["*", aem] : ["_", uem ?? ""];
      out += `<span class="cx-md-mark">${d}</span><span class="cx-md-em">${hlMdRun(text, base + m.index + 1, links)}</span><span class="cx-md-mark">${d}</span>`;
    }
    last = end;
    re.lastIndex = end;
  }
  return out + esc(src.slice(last));
}
/** Where a link's label closes: the "]" that balances its opening "[", past any escape. */
function labelEnd(link: string): number {
  let depth = 0;
  for (let i = link.indexOf("["); i < link.length; i++) {
    const c = link[i];
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      depth++;
    } else if (c === "]" && --depth === 0) {
      return i;
    }
  }
  return link.indexOf("](");
}
function hlMdInline(raw: string): string {
  return hlMdRun(raw, 0, markedLinks(raw));
}
// One line's block-level construct. Marks are colored and the text stays plain (still inline-
// tokenized). Falls through to a plain inline pass for prose.
function renderMdLine(line: string): string {
  // ATX heading: crimson # marks, heading text in the font color (bold for hierarchy).
  const h = line.match(/^(\s{0,3}#{1,6})(\s.*)?$/);
  if (h) {
    return `<span class="cx-md-hmark">${esc(h[1] ?? "")}</span><span class="cx-md-htext">${esc(h[2] || "")}</span>`;
  }
  // Thematic break: --- *** ___ (three or more of one mark), alone on the line.
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return `<span class="cx-md-bmark">${esc(line)}</span>`;
  }
  // Blockquote: > markers colored, the quoted text plain (still inline-tokenized).
  const q = line.match(/^(\s{0,3})((?:>\s?)+)(.*)$/);
  if (q) {
    return `${esc(q[1] ?? "")}<span class="cx-md-bmark">${esc(q[2] ?? "")}</span>${hlMdInline(q[3] ?? "")}`;
  }
  // List item: -, *, + (unordered) or 1. / 1) (ordered); colored marker, plain text.
  const li = line.match(/^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/);
  if (li) {
    return `${li[1]}<span class="cx-md-bmark">${esc(li[2] ?? "")}</span>${li[3]}${hlMdInline(li[4] ?? "")}`;
  }
  return hlMdInline(line);
}
/** The post's Markdown as highlighted markup for the composer overlay, one block row per line. */
export function highlightMarkdown(src: string): Html {
  let inFence = false;
  return unsafeHtml(
    String(src)
      .split("\n")
      .map((line) => {
        let html: string;
        let band = false;
        // Fenced code block: a ``` or ~~~ line toggles the fence. The backticks stay plain and
        // only the language after them is colored. The fence lines themselves stay off the band —
        // only the code between the fences carries the background.
        const fence = line.match(/^(\s*)(```+|~~~+)(.*)$/);
        if (fence) {
          inFence = !inFence;
          const lang = fence[3] ? `<span class="cx-md-bmark">${esc(fence[3])}</span>` : "";
          html = `${fence[1]}${esc(fence[2] ?? "")}${lang}`;
        } else if (inFence) {
          band = true;
          html = esc(line);
        } else {
          html = renderMdLine(line);
        }
        // Each source line is its own block row, so the caret aligns line-for-line with the
        // textarea and consecutive fenced rows' backgrounds abut into one continuous band. An
        // empty row is held open to one line by .cx-md-ln's min-height (CSS), not a filler glyph.
        return `<span class="cx-md-ln${band ? " cx-md-band" : ""}">${html}</span>`;
      })
      .join(""),
  );
}

// --- code examples (the API reference and the docs) ---
// One pass over the raw JSON text: each token is escaped and wrapped, and the whitespace
// between tokens is escaped as it stands, so nothing is decorated twice. A `//` or `/* */`
// comment (JSONC, as in wrangler.jsonc) is one token too, so a `//` inside a string, already
// consumed by then, is never read as one.
const JSON_TOKEN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*")(\s*:)?|(?<![\w.-])(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w.])|\b(true|false|null)\b|([{}[\],])/g;
/** JSON or JSONC source text, highlighted on the shared syntax palette. Anything that is not
 *  a token (a placeholder like `…`) is kept as text. */
export function highlightJsonText(src: string): Html {
  let out = "";
  let last = 0;
  for (const m of src.matchAll(JSON_TOKEN)) {
    out += esc(src.slice(last, m.index));
    const [whole, comment, str, colon, num, lit] = m;
    if (comment !== undefined) {
      out += `<span class="cx-punct">${esc(comment)}</span>`;
    } else if (str !== undefined) {
      out += colon
        ? `<span class="cx-prop">${esc(str)}</span><span class="cx-punct">${esc(colon)}</span>`
        : `<span class="cx-str">${esc(str)}</span>`;
    } else if (num !== undefined) {
      out += `<span class="cx-num">${num}</span>`;
    } else if (lit !== undefined) {
      out += `<span class="cx-tag">${lit}</span>`;
    } else {
      out += `<span class="cx-punct">${esc(whole)}</span>`;
    }
    last = m.index + whole.length;
  }
  return unsafeHtml(out + esc(src.slice(last)));
}
/** A value as pretty-printed JSON (two-space indent), highlighted on the shared syntax palette. */
export function highlightJson(value: unknown): Html {
  return highlightJsonText(JSON.stringify(value, null, 2) ?? "");
}

// A shell command line, read the way a reader scans one: the command each line (or each
// part of a pipeline) runs, its flags, the variables to fill in, quoted strings, comments,
// and the backslash that continues a command onto the next line. A light pass, not a shell
// parser: it never expands anything, and an alternative it doesn't know stays plain.
const SHELL_TOKEN =
  /(\\\n)|(\\[\s\S])|('[^']*')|("(?:\\[\s\S]|[^"\\])*")|(\$\{?[A-Za-z_]\w*\}?)|(&&|\|\||[|;])|(\n)|(#[^\n]*)|([^\s'"$|&;\\]+)/g;
const SHELL_VAR = /\$\{?[A-Za-z_]\w*\}?/g;
/** A shell (`bash`) block with each command, its flags, variables, strings, comments, and
 *  line continuations marked. */
export function highlightShell(src: string): Html {
  let out = "";
  let last = 0;
  // Whether the next word is a command: at the start of a line that doesn't continue the one
  // before, and after `&&`, `||`, `|`, or `;`.
  let command = true;
  for (const m of src.matchAll(SHELL_TOKEN)) {
    out += esc(src.slice(last, m.index));
    const [whole, cont, escaped, single, double, variable, op, newline, comment, word] = m;
    if (cont !== undefined) {
      out += `<span class="cx-punct">\\</span>\n`;
    } else if (escaped !== undefined) {
      out += esc(escaped);
    } else if (single !== undefined) {
      out += `<span class="cx-str">${esc(single)}</span>`;
      command = false;
    } else if (double !== undefined) {
      // Double quotes expand a variable, so one inside is still marked.
      out += `<span class="cx-str">${esc(double).replace(SHELL_VAR, '<span class="cx-var">$&</span>')}</span>`;
      command = false;
    } else if (variable !== undefined) {
      out += `<span class="cx-var">${variable}</span>`;
      command = false;
    } else if (op !== undefined) {
      out += `<span class="cx-punct">${esc(op)}</span>`;
      command = true;
    } else if (newline !== undefined) {
      out += "\n";
      command = true;
    } else if (comment !== undefined) {
      out += `<span class="cx-punct">${esc(comment)}</span>`;
    } else if (word !== undefined) {
      if (command && /^[A-Za-z_]\w*=/.test(word)) {
        // An assignment before the command (`PORT=8788 npm run dev`) leaves the command next.
        out += esc(word);
      } else if (command) {
        out += `<span class="cx-tag">${esc(word)}</span>`;
        command = false;
      } else if (word.startsWith("-")) {
        out += `<span class="cx-num">${esc(word)}</span>`;
      } else {
        out += esc(word);
      }
    }
    last = m.index + whole.length;
  }
  return unsafeHtml(out + esc(src.slice(last)));
}
