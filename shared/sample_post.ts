// The sample post that stands in for a real one where there is none to show: a template
// test's email, the Template page's preview, and Settings' previews of the reader pages.
// It says what it is, because a template test arrives under the publisher's own sign-off
// and would otherwise read as a post they didn't write.

/** A template test's subject line, which the Template page's preview binds too. */
export const TEMPLATE_TEST_SUBJECT = "Template test: how your posts will look";

/** The sample as a listed post's title: Settings' previews of the reader pages. */
export const SAMPLE_POST_SUBJECT = "How your posts will look";

/** The sample's body, as the render path takes it. */
export const SAMPLE_POST_MARKDOWN = [
  `# ${SAMPLE_POST_SUBJECT}`,
  "",
  "This is a test of your email template, with sample text. A real post’s Markdown fills this space.",
  "",
  "It shows the parts of a post that a template styles:",
  "",
  "- Headings, like the one above",
  "- **Bold** text",
  "- [Links](https://example.com)",
  "- Lists, like this one",
  "",
  "> And quotes, like this one.",
].join("\n");

/** The same body as the render path's Markdown step makes it, for the Template page's
 *  preview, which fills a template in the browser with no Markdown renderer. A spec holds
 *  the two equal (`test/render.spec.ts`). */
export const SAMPLE_POST_HTML = [
  `<h1>${SAMPLE_POST_SUBJECT}</h1>`,
  "<p>This is a test of your email template, with sample text. A real post’s Markdown fills this space.</p>",
  "<p>It shows the parts of a post that a template styles:</p>",
  "<ul>",
  "<li>Headings, like the one above</li>",
  "<li><strong>Bold</strong> text</li>",
  '<li><a href="https://example.com">Links</a></li>',
  "<li>Lists, like this one</li>",
  "</ul>",
  "<blockquote>",
  "<p>And quotes, like this one.</p>",
  "</blockquote>",
  "",
].join("\n");
