/**
 * The email template engine: a publisher-authored HTML layout with a `<style>` block
 * and logic-less `{{ variables }}`, filled and CSS-inlined at render time (SPEC §9).
 *
 * One token registry (`TOKENS`) is the single source of truth for every variable — the
 * pass that fills it (`render` vs `delivery`) and how its value is escaped. Two resolvers
 * read that registry, so "which token resolves when, and how" lives in exactly one place:
 *  - `fillEmailTemplate` — the RENDER pass. Substitutes `{{ }}` render-phase tokens from
 *    a fixed context (logic-less: a token is only ever replaced by a value, so nothing
 *    executes) and freezes each delivery-phase token to an internal sentinel.
 *  - `fillDeliveryTokens` — the DELIVERY pass. Fills those frozen sentinels per recipient
 *    (send/test) or with generic/empty values (archive/preview): the same registry, a
 *    later phase, instead of a separate side-channel.
 *  - `validateEmailTemplate` reports errors (which the route rejects) and warnings —
 *    above all, every email MUST keep an unsubscribe link, so a template without one
 *    is an error (§7/§10, I2).
 *  - `inlineEmailCss` inlines the `<style>` rules onto elements, because mail clients
 *    strip/ignore `<style>` (Outlook especially); `@media` rules can't be inlined and
 *    are kept in a `<style>` block. Backed by css-inline (WASM), initialized once.
 *
 * The default template ships so a fresh install sends a sensible post out of the box.
 */

import { initWasm, inline } from "@css-inline/css-inline-wasm";
import wasmModule from "@css-inline/css-inline-wasm/index_bg.wasm";
import type { AppSettings } from "../db/settings";
import { BRANDING_LOGO_KEY } from "../db/settings";
import type { Config } from "../env";
import { escapeHtmlAttr } from "../lib/html";

// --- the token registry -----------------------------------------------------------
// One place declares every {{ variable }} a template may use: which pass fills it and
// how its value is escaped. The two resolvers below both read this, so nothing else
// needs to know "which token resolves when, and how it's escaped."

/** How a value is escaped into the HTML surface. `raw` inserts it verbatim — for the
 *  already-sanitized body HTML, and for the app-generated unsubscribe URL (kept raw to
 *  preserve the pre-unification wire bytes; see that token). `attr` HTML-escapes it so a
 *  stray `<`, `"`, or `&` can't break markup. The plain-text surface never escapes. */
type Escaping = "raw" | "attr";

/** One variable's contract. `phase` is when it's filled:
 *  - `render`: at freeze time, from values known then (post / publication / view-in-
 *    browser); `fillEmailTemplate` writes these into the frozen bytes.
 *  - `delivery`: per recipient, after freezing. The frozen bytes hold an internal
 *    `sentinel`; the send fills it with the recipient's value, and the recipient-agnostic
 *    archive/preview surfaces fill it with a generic/empty one. Keeping these OUT of the
 *    frozen render is what upholds I3 (recipient-agnostic bytes) and I4 (delivery is a
 *    pure function of frozen bytes + recipient). A delivery token's `sentinel` is an
 *    internal placeholder an author can't type in a `{{ }}` token, so authored body
 *    content can never collide with it. */
type TokenSpec =
  | { phase: "render"; escaping: Escaping }
  | { phase: "delivery"; escaping: Escaping; sentinel: string };

/** Internal delivery sentinels. Not `{{ }}` (an author can't produce them) and escape-
 *  inert, so they survive `fillEmailTemplate`'s escaping and CSS inlining untouched,
 *  frozen into the render verbatim until the delivery pass fills them.
 *
 *  These are NOT about SES template semantics: every provider (fake, resend, ses)
 *  substitutes in-app before the wire — the SES adapter sends fully-substituted raw MIME
 *  (providers/ses_mime.ts), not SES-side `{{ }}` templating — so the only constraints a
 *  sentinel must meet are the two above. */
export const UNSUB_SENTINEL = "%%UNSUBSCRIBE_URL%%";
export const SENTTO_SENTINEL = "%%SENT_TO%%";

/** THE token registry — the one place each variable's phase + escaping is declared.
 *  Order is cosmetic (it drives `EMAIL_TEMPLATE_VARIABLES`); resolution is keyed. */
const TOKENS = {
  "post.body": { phase: "render", escaping: "raw" },
  "post.subject": { phase: "render", escaping: "attr" },
  "publication.name": { phase: "render", escaping: "attr" },
  "publication.tagline": { phase: "render", escaping: "attr" },
  "publication.logoUrl": { phase: "render", escaping: "attr" },
  "publication.address": { phase: "render", escaping: "attr" },
  "email.viewInBrowserUrl": { phase: "render", escaping: "attr" },
  // Delivery-phase (per recipient). Unsubscribe stays `raw` so the delivered bytes are
  // byte-for-byte the pre-unification output (I5); the URL is app-generated (origin +
  // token), not user content, so raw is safe. Routing it through `attr` would &-escape a
  // multi-param URL — a deliberate, separately-tracked change. The sent-to address is
  // `attr`: it lands in markup, so it's attribute-safe-escaped.
  "email.unsubscribeUrl": { phase: "delivery", escaping: "raw", sentinel: UNSUB_SENTINEL },
  "email.sentTo": { phase: "delivery", escaping: "attr", sentinel: SENTTO_SENTINEL },
} as const satisfies Record<string, TokenSpec>;

type TokenKey = keyof typeof TOKENS;
type RenderKey = {
  [K in TokenKey]: (typeof TOKENS)[K]["phase"] extends "render" ? K : never;
}[TokenKey];
type DeliveryKey = {
  [K in TokenKey]: (typeof TOKENS)[K]["phase"] extends "delivery" ? K : never;
}[TokenKey];

/** The variables a template may reference (the registry keys). */
export const EMAIL_TEMPLATE_VARIABLES = Object.keys(TOKENS) as TokenKey[];

const KNOWN_VARS = new Set<string>(EMAIL_TEMPLATE_VARIABLES);

/** Values the RENDER pass binds — render-phase tokens only. Delivery-phase tokens carry
 *  no value here; `fillEmailTemplate` freezes them to their sentinels for the later pass. */
export type RenderContext = Record<RenderKey, string>;

/** Per-recipient values the DELIVERY pass binds — the delivery-phase tokens, by key. */
export type DeliveryContext = Record<DeliveryKey, string>;

/** The delivery-phase tokens, precomputed from the registry (drives `fillDeliveryTokens`). */
const DELIVERY_TOKENS: { key: DeliveryKey; escaping: Escaping; sentinel: string }[] =
  Object.entries(TOKENS).flatMap(([key, spec]) =>
    spec.phase === "delivery"
      ? [{ key: key as DeliveryKey, escaping: spec.escaping, sentinel: spec.sentinel }]
      : [],
  );

const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

/** RENDER pass. Substitute `{{ token }}` for each render-phase token (escaped per the
 *  registry; `post.body` raw) and freeze each delivery-phase token to its sentinel, so
 *  the per-recipient pass can fill it later. Logic-less: a token is only ever replaced
 *  by a value. An unknown token renders empty (validation warns). */
export function fillEmailTemplate(html: string, ctx: RenderContext): string {
  return html.replace(TOKEN, (_m, key: string) => {
    const spec = (TOKENS as Record<string, TokenSpec>)[key];
    if (!spec) {
      return "";
    }
    if (spec.phase === "delivery") {
      return spec.sentinel;
    }
    const value = (ctx as Record<string, string | undefined>)[key];
    if (value === undefined) {
      return "";
    }
    return spec.escaping === "raw" ? value : escapeHtmlAttr(value);
  });
}

/** DELIVERY pass. Fill the frozen render's delivery-phase sentinels for one surface —
 *  the per-recipient send/test, or a recipient-agnostic archive/preview (generic
 *  unsubscribe URL, empty sent-to). `surface` selects escaping: the HTML surface escapes
 *  per the token's rule (unsubscribe URL raw, sent-to attribute-safe); the plain-text
 *  surface inserts every value raw (no markup to protect). A pure function of (frozen
 *  bytes, context) and byte-for-byte a direct sentinel replacement — so a retry re-mails
 *  no one (I4). */
export function fillDeliveryTokens(
  input: string,
  ctx: DeliveryContext,
  surface: "html" | "text",
): string {
  let out = input;
  for (const t of DELIVERY_TOKENS) {
    const value = ctx[t.key];
    const filled = surface === "html" && t.escaping === "attr" ? escapeHtmlAttr(value) : value;
    out = out.split(t.sentinel).join(filled);
  }
  return out;
}

export interface TemplateValidation {
  errors: string[];
  warnings: string[];
}

/** Check a template for the variables an email can't do without (errors) and for
 *  likely mistakes (warnings). Errors block the send; warnings are surfaced but
 *  allowed. The unsubscribe error is load-bearing: no email may ship without a way
 *  to leave (I2, §10). */
export function validateEmailTemplate(html: string): TemplateValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tokens = new Set<string>();
  for (const m of html.matchAll(TOKEN)) {
    const t = m[1];
    if (t) {
      tokens.add(t);
    }
  }

  if (!tokens.has("post.body")) {
    errors.push("Every email must include {{ post.body }} to render the content of the post.");
  }
  if (!tokens.has("email.unsubscribeUrl")) {
    errors.push(
      "Every email must carry an unsubscribe link. Add {{ email.unsubscribeUrl }} to the template.",
    );
  }
  if (!tokens.has("email.viewInBrowserUrl")) {
    warnings.push("Add {{ email.viewInBrowserUrl }} so readers can open the post in a browser.");
  }
  for (const t of tokens) {
    if (!KNOWN_VARS.has(t)) {
      warnings.push(`{{ ${t} }} is not a known variable and will render empty.`);
    }
  }
  if (/<script[\s/>]/i.test(html)) {
    warnings.push("A <script> tag won't run in email and may get the message filtered.");
  }
  return { errors, warnings };
}

// --- CSS inlining (css-inline, WASM) ---------------------------------------------
// initWasm is async (it instantiates the module); cache the promise so it runs once
// per isolate and callers just await inlineEmailCss.
let inlinerReady: Promise<void> | null = null;

/** Inline the `<style>` rules onto elements and keep un-inlinable `@media` rules in a
 *  `<style>` block. Deterministic: same input → same output (holds I5). */
export async function inlineEmailCss(html: string): Promise<string> {
  if (!inlinerReady) {
    inlinerReady = initWasm(wasmModule);
  }
  await inlinerReady;
  return inline(html, { keepAtRules: true });
}

// --- branding resolution ---------------------------------------------------------

/** Everything the render path needs from settings to fill a template: the template
 *  itself plus the publication identity that a template may show inside the email. */
export interface EmailBranding {
  template: string;
  name: string;
  tagline: string;
  logoUrl: string;
  address: string;
}

/** Pull the display name out of a `Name <addr@host>` From header (or ""). */
function fromDisplayName(fromAddress: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/.exec(fromAddress);
  return m?.[1] ? m[1].trim() : "";
}

/** Resolve the branding the email carries from stored settings + deploy config. A
 *  blank template falls back to the built-in default; a blank name falls back to the
 *  From display name so the email is never nameless. */
export function resolveBranding(settings: AppSettings, config: Config): EmailBranding {
  const p = settings.publication;
  return {
    template: settings.emailTemplate.trim() ? settings.emailTemplate : DEFAULT_EMAIL_TEMPLATE,
    name: p.name || fromDisplayName(config.fromAddress),
    tagline: p.tagline,
    logoUrl: p.logo ? `${config.mediaPublicBase}/${BRANDING_LOGO_KEY}?v=${p.logo.version}` : "",
    address: p.address,
  };
}

/** Neutral branding (the default template, empty identity) — for tests and the dev
 *  seed, which don't need real settings to exercise the render path. */
export function defaultBranding(): EmailBranding {
  return { template: DEFAULT_EMAIL_TEMPLATE, name: "", tagline: "", logoUrl: "", address: "" };
}

/** The built-in template — a signed sign-off (logo, name, tagline) over a "Powered by
 *  Kestrel · Unsubscribe · View in browser" footer. Authored with a `<style>` block;
 *  the render path inlines it. Sent out of the box when the operator sets no template. */
export const DEFAULT_EMAIL_TEMPLATE = `<style>
  .email {
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #18181b;
  }
  .email h1,
  .email h2,
  .email h3 {
    font-family: Georgia, 'Times New Roman', serif;
    line-height: 1.2;
  }
  .email a {
    color: #3355cc;
  }
  .email .rule {
    border: 0;
    border-top: 1px solid #e4e4e7;
    margin: 28px 0;
  }
  .signoff td {
    vertical-align: middle;
  }
  .signoff .logo-cell {
    padding-right: 14px;
  }
  .signoff .logo {
    display: block;
    border-radius: 9px;
  }
  .signoff .name {
    font: 600 17px/1.2 Georgia, 'Times New Roman', serif;
  }
  .signoff .tagline {
    font-size: 13px;
    color: #52525b;
    margin-top: 2px;
  }
  .footer {
    margin-top: 22px;
    font-size: 12px;
    line-height: 1.7;
    color: #8a8a93;
  }
  .footer a {
    color: #8a8a93;
    text-decoration: underline;
  }
  @media (prefers-color-scheme: dark) {
    .email {
      color: #ededed !important;
    }
    .email a {
      color: #93c5fd !important;
    }
    .email .rule {
      border-color: #2e2e33 !important;
    }
    .signoff .name {
      color: #ededed !important;
    }
    .signoff .tagline {
      color: #a1a1aa !important;
    }
    .footer {
      color: #a1a1aa !important;
    }
    .footer a {
      color: #a1a1aa !important;
    }
  }
</style>

<div class="email">
  {{ post.body }}

  <hr class="rule" />

  <table class="signoff" role="presentation" cellpadding="0" cellspacing="0">
    <tr>
      <td class="logo-cell">
        <img class="logo" src="{{ publication.logoUrl }}" alt="{{ publication.name }}" width="44" height="44" />
      </td>
      <td>
        <div class="name">{{ publication.name }}</div>
        <div class="tagline">{{ publication.tagline }}</div>
      </td>
    </tr>
  </table>

  <div class="footer">
    Powered by Kestrel ·
    <a href="{{ email.unsubscribeUrl }}">Unsubscribe</a> ·
    <a href="{{ email.viewInBrowserUrl }}">View in browser</a>
  </div>
</div>`;
