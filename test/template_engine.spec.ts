import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMAIL_TEMPLATE,
  type DeliveryContext,
  fillDeliveryTokens,
  fillEmailTemplate,
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
  "post.body": "<h1>Hi</h1><p>body & more</p>",
  "post.subject": "Subject",
  "publication.name": 'Ben & "Co"',
  "publication.tagline": "tag",
  "publication.logoUrl": "https://media.example/logo?v=1",
  "publication.address": "1 Main St",
  "email.viewInBrowserUrl": "https://arc.example/archive/x",
};

describe("fillEmailTemplate (render pass)", () => {
  it("inserts post.body raw and escapes every other render-phase value", () => {
    const out = fillEmailTemplate(
      '<a href="{{ email.viewInBrowserUrl }}">{{ publication.name }}</a>{{ post.body }}',
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
    // The author writes {{ email.unsubscribeUrl }}, but it resolves at DELIVERY — so the
    // render pass leaves the frozen sentinel behind, whatever the render context holds.
    const out = fillEmailTemplate(
      '<a href="{{ email.unsubscribeUrl }}">u</a>Sent to {{ email.sentTo }}',
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
    "email.unsubscribeUrl": "https://app.example/unsubscribe?token=abc&uid=42",
    "email.sentTo": "reader+<x>@example.com",
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
      { "email.unsubscribeUrl": "https://app.example/unsubscribe", "email.sentTo": "" },
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
