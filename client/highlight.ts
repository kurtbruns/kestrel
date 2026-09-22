// @ts-nocheck
// Syntax highlighting for the template editor (HTML/CSS with template tokens) and the
// post composer (Markdown).

import { esc } from "./helpers";

// --- template syntax highlighting (issue #123) ---
// A small tokenizer for the overlay editor: colors the {{ tokens }}, HTML tags and
// attribute strings, and — inside the <style> block — CSS selectors, properties,
// colors and at-rules. Logic-less templates need nothing heavier, so this stays
// inside the dashboard's framework-free, no-build ethos (no CodeMirror, no bundler).
function hlTokens(s) {
  return s.replace(/\{\{\s*[\w.]+\s*\}\}/g, (m) => `<span class="cx-var">${m}</span>`);
}
function hlHtml(raw) {
  let s = esc(raw);
  s = s.replace(/&quot;[^&]*?&quot;/g, (m) => `<span class="cx-str">${m}</span>`);
  s = s.replace(
    /(&lt;\/?)([a-zA-Z][\w-]*)/g,
    (_m, br, name) => `<span class="cx-punct">${br}</span><span class="cx-tag">${name}</span>`,
  );
  s = s.replace(/(\/?)&gt;/g, (_m, sl) => `<span class="cx-punct">${sl}&gt;</span>`);
  return hlTokens(s);
}
function hlCss(raw) {
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
export function highlightTemplate(src) {
  return String(src)
    .split(/(<style>[\s\S]*?<\/style>)/)
    .map((seg) => {
      const m = seg.match(/^<style>([\s\S]*?)<\/style>$/);
      if (m) {
        return `<span class="cx-punct">&lt;</span><span class="cx-tag">style</span><span class="cx-punct">&gt;</span>${hlCss(m[1])}<span class="cx-punct">&lt;/</span><span class="cx-tag">style</span><span class="cx-punct">&gt;</span>`;
      }
      return hlHtml(seg);
    })
    .join("");
}

// --- post (Markdown) syntax highlighting (issue #138) ---
// highlightTemplate()'s counterpart for the post editor: the same transparent-textarea-
// over-highlighted-<pre> overlay, tokenizing Markdown instead of HTML/CSS, in the same
// framework-free, no-build spirit. The scheme is deliberately minimal (Sublime-style): it
// colors the *marks* an author scans for — the #, >, list bullets, the emphasis *asterisks*,
// a link's URL — and leaves the CONTENT in the font color, carrying only weight/slant. So a
// bold word reads as weight, not as a color that could be confused with a heading. It is a
// light, line-oriented pass, not a full CommonMark parser, over the shared --syntax-* palette.

// Inline constructs within one line, in a single left-to-right pass. One alternation consumes
// each construct whole so we never re-tokenize inside a span we just emitted (the classic bug
// from chaining .replace() calls — an italic pass eating a bold marker). Marks are colored, the
// content plain: emphasis asterisks are pink and the word carries only weight/slant; a link's
// text stays plain and only its URL is treated; inline `code` sits on a chip. Order at a given
// position: `code`, then [links]/images, then **strong** before *em*. Single-underscore _em_ is
// guarded by \b so intra-word underscores (snake_case, price_1) stay literal, not emphasized.
function hlMdInline(raw) {
  return esc(raw).replace(
    /(`[^`\n]+`)|(!?)(\[[^\]\n]*\])\(([^)\n]*)\)|(\*\*|__)([^\n]+?)\5|\*([^*\n]+?)\*|\b_([^_\n]+?)_\b/g,
    (_m, code, bang, ltext, lurl, bd, btext, aem, uem) => {
      if (code) {
        return `<span class="cx-md-code">${code}</span>`;
      }
      if (ltext !== undefined) {
        // Link/image: text + brackets stay plain; only the URL is treated (blue, underlined).
        return `${bang || ""}${ltext}(<span class="cx-md-url">${lurl}</span>)`;
      }
      if (bd) {
        return `<span class="cx-md-mark">${bd}</span><span class="cx-md-strong">${btext}</span><span class="cx-md-mark">${bd}</span>`;
      }
      // Emphasis: asterisk and underscore share the same treatment; the delimiter is a literal.
      const [d, text] = aem !== undefined ? ["*", aem] : ["_", uem];
      return `<span class="cx-md-mark">${d}</span><span class="cx-md-em">${text}</span><span class="cx-md-mark">${d}</span>`;
    },
  );
}
// One line's block-level construct. Marks are colored and the text stays plain (still inline-
// tokenized). Falls through to a plain inline pass for prose.
function renderMdLine(line) {
  // ATX heading: crimson # marks, heading text in the font color (bold for hierarchy).
  const h = line.match(/^(\s{0,3}#{1,6})(\s.*)?$/);
  if (h) {
    return `<span class="cx-md-hmark">${esc(h[1])}</span><span class="cx-md-htext">${esc(h[2] || "")}</span>`;
  }
  // Thematic break: --- *** ___ (three or more of one mark), alone on the line.
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    return `<span class="cx-md-bmark">${esc(line)}</span>`;
  }
  // Blockquote: > markers colored, the quoted text plain (still inline-tokenized).
  const q = line.match(/^(\s{0,3})((?:>\s?)+)(.*)$/);
  if (q) {
    return `${esc(q[1])}<span class="cx-md-bmark">${esc(q[2])}</span>${hlMdInline(q[3])}`;
  }
  // List item: -, *, + (unordered) or 1. / 1) (ordered); colored marker, plain text.
  const li = line.match(/^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/);
  if (li) {
    return `${li[1]}<span class="cx-md-bmark">${esc(li[2])}</span>${li[3]}${hlMdInline(li[4])}`;
  }
  return hlMdInline(line);
}
export function highlightMarkdown(src) {
  let inFence = false;
  return String(src)
    .split("\n")
    .map((line) => {
      let html;
      let band = false;
      // Fenced code block: a ``` or ~~~ line toggles the fence. The backticks stay plain and
      // only the language after them is colored. The fence lines themselves stay off the band —
      // only the code between the fences carries the background.
      const fence = line.match(/^(\s*)(```+|~~~+)(.*)$/);
      if (fence) {
        inFence = !inFence;
        const lang = fence[3] ? `<span class="cx-md-bmark">${esc(fence[3])}</span>` : "";
        html = `${fence[1]}${esc(fence[2])}${lang}`;
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
    .join("");
}
