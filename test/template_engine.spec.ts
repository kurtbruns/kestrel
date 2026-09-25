import { describe, expect, it } from "vitest";
import { EMAIL_ONLY_CLOSE, EMAIL_ONLY_OPEN, omitEmailOnly } from "../src/render/template";
import {
  DEFAULT_EMAIL_TEMPLATE,
  type DeliveryContext,
  fillDeliveryTokens,
  fillEmailTemplate,
  identityFieldsInUse,
  inlineEmailCss,
  onceUntilRejected,
  type RenderContext,
  SENTTO_SENTINEL,
  UNSUB_SENTINEL,
  validateEmailTemplate,
} from "../src/render/template_engine";

// Render-phase context only — the delivery-phase tokens (unsubscribe URL, sent-to) carry
// no value here; fillEmailTemplate freezes them to their sentinels for the delivery pass.
const ctx: RenderContext = {
  ".Post.Body": "<h1>Hi</h1><p>body & more</p>",
  ".Post.Subject": "Subject",
  ".Publication.Name": 'Ben & "Co"',
  ".Publication.Tagline": "tag",
  ".Publication.LogoURL": "https://media.example/logo?v=1",
  ".Publication.Logo": '<img class="logo" src="https://media.example/logo?v=1" alt="" />',
  ".Publication.Address": "1 Main St",
  ".Email.ViewInBrowserURL": "https://arc.example/archive/x",
};

describe("fillEmailTemplate (render pass)", () => {
  it("inserts post.body raw and escapes every other render-phase value", () => {
    const out = fillEmailTemplate(
      '<a href="{{ .Email.ViewInBrowserURL }}">{{ .Publication.Name }}</a>{{ .Post.Body }}',
      ctx,
    );
    // Body HTML is inserted verbatim…
    expect(out).toContain("<h1>Hi</h1>");
    // …but a name with quotes/ampersand is attribute-safe-escaped…
    expect(out).toContain("Ben &amp; &quot;Co&quot;");
    // …and a render-phase URL is filled with its resolved value.
    expect(out).toContain('href="https://arc.example/archive/x"');
  });

  it("freezes a delivery-phase token to its sentinel, not to a render value", () => {
    // The author writes {{ .Email.UnsubscribeURL }}, but it resolves at DELIVERY — so the
    // render pass leaves the frozen sentinel behind, whatever the render context holds.
    const out = fillEmailTemplate(
      '<a href="{{ .Email.UnsubscribeURL }}">u</a>Sent to {{ .Email.SentTo }}',
      ctx,
    );
    expect(out).toContain(`href="${UNSUB_SENTINEL}"`);
    expect(out).toContain(`Sent to ${SENTTO_SENTINEL}`);
  });

  it("renders an unknown token as empty", () => {
    expect(fillEmailTemplate("[{{ nope.here }}]", ctx)).toBe("[]");
  });
});

describe("fillDeliveryTokens (delivery pass)", () => {
  const recipient: DeliveryContext = {
    ".Email.UnsubscribeURL": "https://app.example/unsubscribe?token=abc&uid=42",
    ".Email.SentTo": "reader+<x>@example.com",
  };

  it("fills the unsubscribe URL raw and the sent-to address attribute-safe in HTML", () => {
    const frozen = `<a href="${UNSUB_SENTINEL}">u</a> Sent to ${SENTTO_SENTINEL}`;
    const out = fillDeliveryTokens(frozen, recipient, "html");
    // Unsubscribe URL is raw — the `&` is NOT escaped (flavor-2: escaping unchanged).
    expect(out).toContain('href="https://app.example/unsubscribe?token=abc&uid=42"');
    // Sent-to is attribute-safe-escaped so it can't break markup.
    expect(out).toContain("Sent to reader+&lt;x&gt;@example.com");
    expect(out).not.toContain(UNSUB_SENTINEL);
    expect(out).not.toContain(SENTTO_SENTINEL);
  });

  it("fills both values raw in the text surface (no markup to protect)", () => {
    const frozen = `Unsubscribe: ${UNSUB_SENTINEL}\nSent to ${SENTTO_SENTINEL}`;
    const out = fillDeliveryTokens(frozen, recipient, "text");
    expect(out).toContain("Unsubscribe: https://app.example/unsubscribe?token=abc&uid=42");
    expect(out).toContain("Sent to reader+<x>@example.com");
  });

  it("redacts to a generic/empty value on recipient-agnostic surfaces", () => {
    const frozen = `<a href="${UNSUB_SENTINEL}">u</a><span>${SENTTO_SENTINEL}</span>`;
    const out = fillDeliveryTokens(
      frozen,
      { ".Email.UnsubscribeURL": "https://app.example/unsubscribe", ".Email.SentTo": "" },
      "html",
    );
    expect(out).toBe('<a href="https://app.example/unsubscribe">u</a><span></span>');
  });
});

describe("validateEmailTemplate", () => {
  it("passes the built-in default with no errors or warnings", () => {
    expect(validateEmailTemplate(DEFAULT_EMAIL_TEMPLATE)).toEqual({ errors: [], warnings: [] });
  });

  it("errors when the unsubscribe link or the body is missing", () => {
    expect(validateEmailTemplate("<div>{{ .Post.Body }}</div>").errors.join(" ")).toMatch(
      /unsubscribe/i,
    );
    expect(
      validateEmailTemplate('<a href="{{ .Email.UnsubscribeURL }}">x</a>').errors.join(" "),
    ).toMatch(/\.Post\.Body/);
  });

  it("warns on a missing view-in-browser link, unknown variables, and <script>", () => {
    const v = validateEmailTemplate(
      '{{ .Post.Body }}<a href="{{ .Email.UnsubscribeURL }}">u</a>{{ mystery }}<script>x</script>',
    );
    expect(v.errors).toEqual([]);
    const w = v.warnings.join(" ");
    expect(w).toMatch(/view.?in.?browser/i);
    expect(w).toMatch(/mystery/);
    expect(w).toMatch(/script/i);
  });

  it("treats a pre-rename placeholder as an unknown variable, with no alias", () => {
    const v = validateEmailTemplate(
      '{{ post.body }}<a href="{{ email.unsubscribeUrl }}">u</a><a href="{{ .Email.ViewInBrowserURL }}">v</a>',
    );
    expect(v.errors.join(" ")).toMatch(/\{\{ \.Post\.Body \}\}/);
    expect(v.errors.join(" ")).toMatch(/\{\{ \.Email\.UnsubscribeURL \}\}/);
    expect(v.warnings.join(" ")).toMatch(/\{\{ post\.body \}\} is not a known variable/);
    expect(fillEmailTemplate("<p>{{ publication.name }}</p>", ctx)).toBe("<p></p>");
  });

  it("warns on an <img> whose src is the bare logo URL, which is broken while no logo is set", () => {
    const base =
      '{{ .Post.Body }}<a href="{{ .Email.UnsubscribeURL }}">u</a><a href="{{ .Email.ViewInBrowserURL }}">v</a>';
    const warned = validateEmailTemplate(`${base}<img alt="" src="{{ .Publication.LogoURL }}">`);
    expect(warned.warnings.join(" ")).toMatch(/\.Publication\.Logo \}\}/);
    // The logo URL used elsewhere, and the logo token itself, are fine.
    expect(
      validateEmailTemplate(`${base}<a href="{{ .Publication.LogoURL }}">logo</a>`).warnings,
    ).toEqual([]);
    expect(validateEmailTemplate(`${base}{{ .Publication.Logo }}`).warnings).toEqual([]);
  });
});

describe("email-only regions ({{ if .IsEmail }} … {{ end }})", () => {
  const base =
    '{{ .Post.Body }}<a href="{{ .Email.UnsubscribeURL }}">u</a><a href="{{ .Email.ViewInBrowserURL }}">v</a>';
  const errorsOf = (tpl: string) => validateEmailTemplate(tpl).errors.join(" ");

  it("keeps the region's content between inert markers, filled like the rest", () => {
    const out = fillEmailTemplate(
      "<p>{{ .Post.Subject }}</p>{{ if .IsEmail }}<p>{{ .Publication.Address }}</p>{{end}}",
      ctx,
    );
    expect(out).toBe(`<p>Subject</p>${EMAIL_ONLY_OPEN}<p>1 Main St</p>${EMAIL_ONLY_CLOSE}`);
  });

  it("drops the whole region, markers included, for the public page", () => {
    const frozen = `<p>a</p>${EMAIL_ONLY_OPEN}<p>b</p>${EMAIL_ONLY_CLOSE}<p>c</p>${EMAIL_ONLY_OPEN}d${EMAIL_ONLY_CLOSE}`;
    expect(omitEmailOnly(frozen)).toBe("<p>a</p><p>c</p>");
    expect(omitEmailOnly("<p>no region</p>")).toBe("<p>no region</p>");
  });

  it("accepts a region, even one holding the only unsubscribe link, and doesn't read {{ end }} as a variable", () => {
    expect(
      validateEmailTemplate(
        '{{ .Post.Body }}{{ if .IsEmail }}<a href="{{ .Email.UnsubscribeURL }}">u</a><a href="{{ .Email.ViewInBrowserURL }}">v</a>{{ end }}',
      ),
    ).toEqual({ errors: [], warnings: [] });
  });

  it("refuses an unclosed region, a stray {{ end }}, and a nested region", () => {
    expect(errorsOf(`${base}{{ if .IsEmail }}x`)).toMatch(/never closed/);
    expect(errorsOf(`${base}x{{ end }}`)).toMatch(/\{\{ end \}\} has no/);
    expect(errorsOf(`${base}{{ if .IsEmail }}a{{ if .IsEmail }}b{{ end }}{{ end }}`)).toMatch(
      /can't contain another/,
    );
  });

  it("refuses the post body inside a region, since the archived post would be empty", () => {
    expect(
      errorsOf(
        '{{ if .IsEmail }}{{ .Post.Body }}{{ end }}<a href="{{ .Email.UnsubscribeURL }}">u</a>',
      ),
    ).toMatch(/\{\{ \.Post\.Body \}\} can't be inside/);
  });

  it("refuses {{ else }}, names an empty {{ if }} cleanly, and warns on braces it doesn't fill", () => {
    expect(errorsOf(`${base}{{ if .IsEmail }}a{{ else }}b{{ end }}`)).toMatch(
      /\{\{ else \}\} isn't supported/,
    );
    expect(errorsOf(`${base}{{ if }}a{{ end }}`)).toMatch(/^\{\{ if \}\} isn't supported/);
    const trimmed = validateEmailTemplate(`${base}{{- if .IsEmail -}}a{{- end -}}`);
    expect(trimmed.warnings.join(" ")).toMatch(
      /\{\{- if \.IsEmail -\}\} isn't something Kestrel fills/,
    );
  });

  it("refuses any condition but .IsEmail, once, without a second error for its {{ end }}", () => {
    const errors = validateEmailTemplate(`${base}{{ if .Publication.Address }}a{{ end }}`).errors;
    expect(errors).toEqual([
      "{{ if .Publication.Address }} isn't supported. The one condition is {{ if .IsEmail }}.",
    ]);
  });
});

describe("identityFieldsInUse", () => {
  it("reads the logo token as rendering the logo and, as its alt text, the name", () => {
    expect(identityFieldsInUse("{{ .Publication.Logo }}")).toEqual(["logoUrl", "name"]);
    expect(identityFieldsInUse(DEFAULT_EMAIL_TEMPLATE).sort()).toEqual([
      "address",
      "logoUrl",
      "name",
      "tagline",
    ]);
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

describe("onceUntilRejected (the inliner's WASM init)", () => {
  it("runs a successful init once and shares it", async () => {
    let runs = 0;
    const ready = onceUntilRejected(async () => {
      runs += 1;
    });
    await Promise.all([ready(), ready()]);
    await ready();
    expect(runs).toBe(1);
  });

  it("retries after a rejected init instead of caching the failure", async () => {
    let runs = 0;
    const ready = onceUntilRejected(async () => {
      runs += 1;
      if (runs === 1) {
        throw new Error("transient load failure");
      }
    });
    await expect(ready()).rejects.toThrow("transient load failure");
    await expect(ready()).resolves.toBeUndefined();
    await ready();
    expect(runs).toBe(2);
  });
});
