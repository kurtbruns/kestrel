import { describe, expect, it } from "vitest";
import { emailLogoHtml } from "./email_logo";

describe("emailLogoHtml", () => {
  it("renders nothing when no logo is set", () => {
    expect(emailLogoHtml("", "Birds Weekly")).toBe("");
  });

  it("renders the logo image, attribute-escaped", () => {
    const out = emailLogoHtml("https://media.example/branding/logo?v=1&x=2", 'Ben & "Co"');
    expect(out).toBe(
      '<img class="logo" src="https://media.example/branding/logo?v=1&amp;x=2" alt="Ben &amp; &quot;Co&quot;" width="44" height="44" />',
    );
  });
});
