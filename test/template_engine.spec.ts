import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_TEMPLATE,
  fillEmailTemplate,
  inlineEmailCss,
  type TemplateContext,
  validateEmailTemplate,
} from "../src/render/template_engine";

const ctx: TemplateContext = {
  "post.body": "<h1>Hi</h1><p>body & more</p>",
  "post.subject": "Subject",
  "publication.name": 'Ben & "Co"',
  "publication.tagline": "tag",
  "publication.logoUrl": "https://media.example/logo?v=1",
  "publication.address": "1 Main St",
  "email.unsubscribeUrl": "%%UNSUBSCRIBE_URL%%",
  "email.viewInBrowserUrl": "https://arc.example/archive/x",
};

describe("fillEmailTemplate", () => {
  it("inserts post.body raw and escapes every other value", () => {
    const out = fillEmailTemplate(
      '<a href="{{ email.unsubscribeUrl }}">{{ publication.name }}</a>{{ post.body }}',
      ctx,
    );
    // Body HTML is inserted verbatim…
    expect(out).toContain("<h1>Hi</h1>");
    // …but a name with quotes/ampersand is attribute-safe-escaped.
    expect(out).toContain("Ben &amp; &quot;Co&quot;");
    expect(out).toContain('href="%%UNSUBSCRIBE_URL%%"');
  });

  it("renders an unknown token as empty", () => {
    expect(fillEmailTemplate("[{{ nope.here }}]", ctx)).toBe("[]");
  });
});

describe("validateEmailTemplate", () => {
  it("passes the built-in default with no errors or warnings", () => {
    expect(validateEmailTemplate(DEFAULT_EMAIL_TEMPLATE)).toEqual({ errors: [], warnings: [] });
  });

  it("errors when the unsubscribe link or the body is missing", () => {
    expect(validateEmailTemplate("<div>{{ post.body }}</div>").errors.join(" ")).toMatch(
      /unsubscribe/i,
    );
    expect(
      validateEmailTemplate('<a href="{{ email.unsubscribeUrl }}">x</a>').errors.join(" "),
    ).toMatch(/post\.body/);
  });

  it("warns on a missing view-in-browser link, unknown variables, and <script>", () => {
    const v = validateEmailTemplate(
      '{{ post.body }}<a href="{{ email.unsubscribeUrl }}">u</a>{{ mystery }}<script>x</script>',
    );
    expect(v.errors).toEqual([]);
    const w = v.warnings.join(" ");
    expect(w).toMatch(/view.?in.?browser/i);
    expect(w).toMatch(/mystery/);
    expect(w).toMatch(/script/i);
  });
});

describe("inlineEmailCss", () => {
  it("inlines <style> onto elements, keeps @media, and preserves comments + the sentinel", async () => {
    const html =
      "<html><head><style>.x a{color:#111}@media (max-width:1px){.x{padding:0}}</style></head>" +
      '<body><div class="x"><!--kestrel:masthead--><a href="%%UNSUBSCRIBE_URL%%">u</a></div></body></html>';
    const out = await inlineEmailCss(html);
    expect(out).toMatch(/<a[^>]*style="[^"]*color: #111/);
    expect(out).toContain("@media");
    expect(out).toContain("<!--kestrel:masthead-->");
    expect(out).toContain("%%UNSUBSCRIBE_URL%%");
  });
});
