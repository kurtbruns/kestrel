import { describe, expect, it } from "vitest";
import editorCss from "../../public/dashboard/styles.css?raw";
import { SANS_STACK, SERIF_STACK, serifStacksNamed } from "../../shared/fonts";
import { buildEmbed } from "./subscribe";
import { EMAIL_TEMPLATE_EXAMPLES } from "./template";

// The editor's half of one serif across the publication (SPEC §5, DESIGN §2): what a publisher
// starts a template from, pastes into their own site, or sees as a sample names exactly the
// stack in shared/fonts.ts, as the reader pages and the built-in template do
// (test/fonts.spec.ts).

/** Every serif stack `text` names is the app's, and it names at least one. */
function expectOnlyTheAppSerif(text: string, where: string): void {
  const stacks = serifStacksNamed(text);
  expect(stacks.length, where).toBeGreaterThan(0);
  expect(new Set(stacks), where).toEqual(new Set([SERIF_STACK]));
}

describe("the app's serif in the editor", () => {
  it("is the one each starting template names, and each teaches the rule it follows", () => {
    for (const [key, ex] of Object.entries(EMAIL_TEMPLATE_EXAMPLES)) {
      expectOnlyTheAppSerif(ex.html, key);
      expect(ex.html, key).toContain("Name only fonts your readers already have");
    }
  });

  it("is the one the styled subscribe embed names", () => {
    expectOnlyTheAppSerif(buildEmbed("styled", "Birds Weekly", "https://app.example"), "embed");
  });

  it("is the one the stylesheet names, as a token every serif rule reads", () => {
    expectOnlyTheAppSerif(editorCss, "public/dashboard/styles.css");
    expect(editorCss.match(/Georgia/g)).toHaveLength(1);
    // The sans token is shared/fonts.ts's too, in the stylesheet's double quotes.
    expect(editorCss).toContain(`--font: ${SANS_STACK.replaceAll("'", '"')};`);
  });
});
