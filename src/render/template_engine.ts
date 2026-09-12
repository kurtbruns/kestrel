/**
 * The email template: a publisher-authored HTML layout with a `<style>` block and
 * logic-less `{{ variables }}`, filled and CSS-inlined at render time (SPEC §8).
 *
 * Three responsibilities live here, all pure except the inliner:
 *  - `fillEmailTemplate` substitutes `{{ }}` tokens from a fixed context (logic-less:
 *    a token is only ever replaced by its value, so nothing executes).
 *  - `validateEmailTemplate` reports errors (which the route rejects) and warnings —
 *    above all, every email MUST keep an unsubscribe link, so a template without one
 *    is an error (§7/§9, I2).
 *  - `inlineEmailCss` inlines the `<style>` rules onto elements, because mail clients
 *    strip/ignore `<style>` (Outlook especially); `@media` rules can't be inlined and
 *    are kept in a `<style>` block. Backed by css-inline (WASM), initialized once.
 *
 * The default template ships so a fresh install sends a sensible issue out of the box.
 */

import { initWasm, inline } from "@css-inline/css-inline-wasm";
import wasmModule from "@css-inline/css-inline-wasm/index_bg.wasm";
import type { AppSettings } from "../db/settings";
import { BRANDING_LOGO_KEY } from "../db/settings";
import type { Config } from "../env";
import { escapeHtmlAttr } from "../lib/html";

/** The variables a template may reference. Keep in step with `TemplateContext`. */
export const EMAIL_TEMPLATE_VARIABLES = [
  "post.body",
  "post.subject",
  "publication.name",
  "publication.tagline",
  "publication.logoUrl",
  "publication.address",
  "footer.unsubscribeUrl",
  "footer.viewInBrowserUrl",
] as const;

const KNOWN_VARS = new Set<string>(EMAIL_TEMPLATE_VARIABLES);

/** The values the render path binds each variable to. `post.body` is raw HTML (the
 *  rendered, already-sanitized Markdown); everything else is a plain string. */
export interface TemplateContext {
  "post.body": string;
  "post.subject": string;
  "publication.name": string;
  "publication.tagline": string;
  "publication.logoUrl": string;
  "publication.address": string;
  "footer.unsubscribeUrl": string;
  "footer.viewInBrowserUrl": string;
}

const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Substitute `{{ token }}` placeholders. `post.body` is inserted raw; every other
 *  value is attribute-safe-escaped, so a stray `<`, `"`, or `&` in a name/URL can't
 *  break the surrounding markup. An unknown token renders empty (validation warns). */
export function fillEmailTemplate(html: string, ctx: TemplateContext): string {
  return html.replace(TOKEN, (_m, key: string) => {
    if (key === "post.body") {
      return ctx["post.body"] ?? "";
    }
    const value = (ctx as unknown as Record<string, string | undefined>)[key];
    return value === undefined ? "" : escapeHtmlAttr(value);
  });
}

export interface TemplateValidation {
  errors: string[];
  warnings: string[];
}

/** Check a template for the variables an email can't do without (errors) and for
 *  likely mistakes (warnings). Errors block the send; warnings are surfaced but
 *  allowed. The unsubscribe error is load-bearing: no email may ship without a way
 *  to leave (I2, §9). */
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
    errors.push("Add {{ post.body }} — without it the issue's content won't appear.");
  }
  if (!tokens.has("footer.unsubscribeUrl")) {
    errors.push("Add {{ footer.unsubscribeUrl }} — every email must carry an unsubscribe link.");
  }
  if (!tokens.has("footer.viewInBrowserUrl")) {
    warnings.push(
      "Consider {{ footer.viewInBrowserUrl }} so readers can open the issue in a browser.",
    );
  }
  for (const t of tokens) {
    if (!KNOWN_VARS.has(t)) {
      warnings.push(`Unknown variable {{ ${t} }} — it will render empty.`);
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
    <a href="{{ footer.unsubscribeUrl }}">Unsubscribe</a> ·
    <a href="{{ footer.viewInBrowserUrl }}">View in browser</a>
  </div>
</div>`;
