// Renders Markdown under two versions of marked and prints what differs, for the
// upgrade-dependencies skill, since a parser change can move an email with every test green.
// Usage: compare-render.mjs <old-version> <new-version> <file or directory>...
// Installs both versions in a temporary directory, without their scripts, and removes it after.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The options src/render/markdown.ts gives marked. Keep them in step with it.
const OPTIONS = { gfm: true, breaks: false };

// What real posts rarely hold but a parser release often changes.
const EDGE_CASES = {
  "balanced parentheses in a link": "[a](https://en.wikipedia.org/wiki/Foo_(bar))",
  "unbalanced parentheses in a link": "[a](https://example.com/foo(bar)",
  "numeric character reference": "Wait &#8212; what &#38; why",
  "www inside a word": "see awww.example.com and www.example.com",
  "emphasis against punctuation": "**Note:**this and *a*b and **bold.**next and snake_case_word",
  "backslash in a code span": "`a\\` *b* `c`",
  "lazy blockquote lines": "> quote\nlazy line\n\n> # h\nlazy\n\n> | a |\n> |---|\n> | b |\nlazy",
  "tab after a blockquote marker": ">\ttabbed quote",
  "tabs in a list": "- a\n\tb\n- c\td\n\n1. one\n\n\tpara",
  "tab after a task checkbox": "- [x]\tdone\n- [ ] todo",
  "hash without a space in a list": "- item\n#nospace\n- two\n# real",
  "whitespace after a hard break": "line one  \n   line two\\\n   line three",
  "mismatched code fences": "```\ncode\n~~~\nstill\n```\n\n~~~js\nx\n```\ny\n~~~",
  "raw HTML blocks": "para\n<div>x</div>\n\n<pre>a</pre>\n\n<!-- c -->\ntext\n<table>\n</table>",
  images: '![alt *em* `c`](logo.png "t")\n\n![](x.png)\n\n[![a](b.png)](https://c.d)',
  "reference links": '[Foo  Bar][ref] [x][REF]\n\n[ref]: https://a.b "t"\n[ref]: https://c.d',
  "setext headings": "Title\n  more\n===\n\n- a\nb\n---",
  "table with a lazy row": "| a | b |\n|---|---|\n| 1 | 2 |\nlazy row",
};

const [oldVersion, newVersion, ...roots] = process.argv.slice(2);
if (!oldVersion || !newVersion) {
  console.error("Usage: compare-render.mjs <old-version> <new-version> <file or directory>...");
  process.exit(2);
}

function markdownFiles(path) {
  if (statSync(path).isDirectory()) {
    return readdirSync(path).flatMap((name) =>
      name === "node_modules" ? [] : markdownFiles(join(path, name)),
    );
  }
  return path.endsWith(".md") ? [path] : [];
}

async function loadMarked(root, side, version) {
  const dir = join(root, side);
  mkdirSync(dir);
  execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", "--silent", `marked@${version}`], {
    cwd: dir,
    stdio: "ignore",
  });
  const url = pathToFileURL(join(dir, "node_modules/marked/lib/marked.esm.js"));
  return (await import(url.href)).Marked;
}

const root = mkdtempSync(join(tmpdir(), "compare-render-"));
try {
  const OldMarked = await loadMarked(root, "old", oldVersion);
  const NewMarked = await loadMarked(root, "new", newVersion);
  const files = roots.flatMap(markdownFiles).map((path) => [path, readFileSync(path, "utf8")]);
  const differing = [];
  for (const [name, markdown] of [...files, ...Object.entries(EDGE_CASES)]) {
    const before = new OldMarked(OPTIONS).parse(markdown);
    const after = new NewMarked(OPTIONS).parse(markdown);
    if (before !== after) {
      differing.push({ name, before, after, isFile: files.some(([path]) => path === name) });
    }
  }
  const realFiles = differing.filter((entry) => entry.isFile).length;
  console.log(`marked ${oldVersion} -> ${newVersion}`);
  console.log(`files: ${files.length}, of which ${realFiles} differ`);
  const cases = Object.keys(EDGE_CASES).length;
  console.log(`edge cases: ${cases}, of which ${differing.length - realFiles} differ`);
  for (const { name, before, after } of differing) {
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    console.log(`\n### ${name}`);
    for (const line of beforeLines.filter((candidate) => !afterLines.includes(candidate))) {
      console.log(`- ${line}`);
    }
    for (const line of afterLines.filter((candidate) => !beforeLines.includes(candidate))) {
      console.log(`+ ${line}`);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
