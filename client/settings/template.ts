// The email template page: the sample preview, the example menu, and the template
// editor.

import type {
  SettingsPatchBody,
  SettingsResponse,
  SettingsSavedResponse,
  TemplateTestResponse,
} from "../../shared/settings";
import { api } from "../api";
import { parseFromName } from "../brand";
import { withNoProviderNote } from "../deployment";
import { app } from "../shell";
import { appState } from "../state";
import { $, $$ } from "../ui/dom";
import { parseAddresses } from "../ui/format";
import { highlightTemplate } from "../ui/highlight";
import { escapeHtml, type Html, html, setHtml, unsafeHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { savebar } from "../ui/savebar";
import { busy, copyText, modal, renderError, toast } from "../ui/widgets";
import { inUseChip, REMAKE_TEMPLATE, savedToast, withRemakeConfirm } from "./remake";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// The Template page's "Start from example" menu binds its outside-click dismissal
// exactly once for the app's lifetime (see renderTemplate); this guards against
// re-binding — and so leaking a listener — on every visit to the page.
let exampleMenuDismissBound = false;

// The one layout each post ships inside, authored as an HTML template with
// logic-less {{ }} placeholders over a fixed variable context. Logic-less means a
// token is only ever swapped for its value — nothing executes — which is why this
// is a template editor, not a WYSIWYG. This pass is a MOCK: edits repaint the
// preview only, nothing persists. The real layout engine (rendered once and frozen
// per send, I3/I5) and saved template variables come later; conceptually both run
// through the single render path (SPEC §5, I5) this preview stands in for.

interface TemplateVar {
  token: string;
  desc: string;
}
interface TemplateVarGroup {
  group: string;
  vars: TemplateVar[];
}
// The variables a template can drop in, grouped for the reference panel.
const EMAIL_TEMPLATE_VARS: TemplateVarGroup[] = [
  {
    group: "Post",
    vars: [
      {
        token: "{{ post.body }}",
        desc: "Your post's Markdown, rendered to HTML — the body slot.",
      },
      { token: "{{ post.subject }}", desc: "The post's subject line." },
    ],
  },
  {
    group: "Publication",
    vars: [
      { token: "{{ publication.name }}", desc: "Publication name (from Identity, above)." },
      { token: "{{ publication.tagline }}", desc: "Your tagline." },
      { token: "{{ publication.logoUrl }}", desc: "Absolute URL of your logo, if set." },
      {
        token: "{{ publication.address }}",
        desc: "Your mailing address, for the compliance footer.",
      },
    ],
  },
  {
    group: "Email",
    vars: [
      { token: "{{ email.sentTo }}", desc: "The recipient's address (filled per send)." },
      { token: "{{ email.unsubscribeUrl }}", desc: "Their one-click unsubscribe link." },
      { token: "{{ email.viewInBrowserUrl }}", desc: "The archived post's permanent URL." },
    ],
  },
];

// Two starting points; the publisher edits the HTML freely from there. Identity sits
// at the FOOT (a sign-off), so the email stays faithful to today's masthead-free top.
// The example templates are authored with a <style> block + classes — clean to read
// and edit. A real send can't rely on a <style> block (Gmail/Outlook strip or ignore
// it), so the real engine (a later step) would INLINE these rules at render time:
// author with a stylesheet, inline on the way out — the standard email pattern, and
// what src/render/template.ts already does by hand (inline base + a <style> block
// only for what inline can't express, like dark mode). The preview renders the
// template as-is in an isolated iframe, so a <style> block behaves exactly as a mail
// client — or the view-in-browser page — would show it.
interface TemplateExample {
  label: string;
  html: string;
}
type ExampleKey = "signed" | "signedAddress" | "plain";
const EMAIL_TEMPLATE_EXAMPLES: Record<ExampleKey, TemplateExample> = {
  signed: {
    label: "Signed",
    html: `<style>
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
</div>`,
  },
  signedAddress: {
    label: "Signed + address",
    html: `<style>
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
  .footer .address {
    margin-top: 6px;
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
    <div class="address">{{ publication.address }}</div>
  </div>
</div>`,
  },
  plain: {
    label: "Plain",
    html: `<style>
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
  .footer {
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

  <div class="footer">
    Powered by Kestrel ·
    <a href="{{ email.unsubscribeUrl }}">Unsubscribe</a> ·
    <a href="{{ email.viewInBrowserUrl }}">View in browser</a>
  </div>
</div>`,
  },
};
const isExampleKey = (k: string): k is ExampleKey => Object.hasOwn(EMAIL_TEMPLATE_EXAMPLES, k);

// Sample post body for the preview — representative prose inside a called-out slot,
// so it's unmistakable where a real post's rendered Markdown lands. Its typography
// comes from the template's own .email rules (the callout frame + label are a
// preview device, not part of the email). In a real send {{ post.body }} is the
// rendered Markdown.
const EMAIL_TEMPLATE_SAMPLE_BODY =
  '<div style="position:relative;border:1px dashed #93a7e6;border-radius:8px;padding:20px 14px 8px;margin:0 0 6px">' +
  "<span style=\"position:absolute;top:-8px;left:10px;font:650 10px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#3355cc;background:#fff;padding:0 6px\">Your post’s Markdown renders here</span>" +
  '<h2 style="margin:0 0 10px">Lorem ipsum,</h2>' +
  '<p style="margin:0">Dolor sit amet, consectetur adipiscing elit. Proin sed ex ipsum. Suspendisse vulputate nisi et odio dapibus, quis pellentesque felis sollicitudin. Proin vel cursus enim. Phasellus sollicitudin malesuada elementum. Suspendisse euismod eros turpis, ut mollis est imperdiet ut. Sed luctus accumsan erat, at eleifend purus eleifend quis.</p>' +
  "</div>";

// Fill logic-less {{ token }} placeholders from a flat context. {{ post.body }} is
// raw HTML (the rendered Markdown); every other value is escaped, so a stray < or "
// in a name can't break the surrounding markup. An unknown token renders empty. A string
// builder by nature: the template is the publisher's own HTML, filled in and vouched for
// at the preview's boundary (mountSampleEmailPreview).
function fillEmailTemplate(template: string, ctx: Record<string, string>): string {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) =>
    key === "post.body" ? ctx["post.body"] || "" : escapeHtml(ctx[key] ?? ""),
  );
}

// A neutral placeholder logo (a monogram tile) for the preview when no real logo is
// set, so a signed sign-off still renders. Fully URL-encoded so it carries no raw
// <,>," and survives the template's attribute escaping.
function sampleLogoDataUri(name: string): string {
  const ch = (String(name || "").trim()[0] || "K").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" rx="9" fill="#e4e4e7"/><text x="22" y="29" font-family="Georgia, serif" font-size="20" font-weight="700" fill="#52525b" text-anchor="middle">${ch}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The identity a sample preview binds: the live or loaded publication fields. */
export interface TemplateIdentity {
  name: string;
  tagline: string;
  logoUrl: string;
  address: string;
}

// Sample values the template preview binds — mirrors the render path's context, with
// email.* standing in for per-recipient values.
function templateSampleCtx(id: TemplateIdentity): Record<string, string> {
  return {
    "post.body": EMAIL_TEMPLATE_SAMPLE_BODY,
    "post.subject": "The starlings are back",
    "publication.name": id.name || "Your publication",
    "publication.tagline": id.tagline || "Your tagline",
    "publication.logoUrl": id.logoUrl || sampleLogoDataUri(id.name),
    "publication.address": id.address || "123 Main Street, City, State Zip Code",
    "email.sentTo": "you@example.com",
    "email.unsubscribeUrl": "#unsubscribe",
    "email.viewInBrowserUrl": "#view-in-browser",
  };
}

// The isolated preview document: a white (dark in dark mode) email canvas whose
// reading column is capped at the email measure (~640px, matching view-in-browser),
// so a template's own <style> applies as a mail client would and never leaks out.
const TEMPLATE_FRAME_DOC =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<style>html,body{margin:0}body{background:#fff}" +
  "@media (prefers-color-scheme:dark){body{background:#18181b}}" +
  ".kestrel-email{max-width:640px;margin:0 auto;padding:26px 20px;box-sizing:border-box}" +
  ".kestrel-email img{max-width:100%}</style></head>" +
  '<body><div class="kestrel-email"></div></body></html>';

/** A mounted sample-email preview; call `repaint` after the template or identity changes. */
export interface SampleEmailPreview {
  repaint(): void;
}

/**
 * Mount a sample-email preview into an <iframe>, kept sized to its content. getTemplate()
 * returns the current template HTML; getIdentity() the live identity. Shared by the
 * Template page (live editor preview) and Settings (a read-only one).
 */
export function mountSampleEmailPreview(
  iframe: HTMLIFrameElement,
  getTemplate: () => string,
  getIdentity: () => TemplateIdentity,
): SampleEmailPreview {
  let ready = false;
  const size = () => {
    try {
      // Measure the BODY, which is content-sized. documentElement.scrollHeight is floored
      // at the iframe's own height, so it can grow but never shrink — which is what left
      // the frame too tall after 375 → 640 and clipped the footer at 640 → 375.
      const h = iframe.contentDocument?.body?.scrollHeight;
      if (h) {
        iframe.style.height = `${Math.max(200, h)}px`;
      }
    } catch {}
  };
  const repaint = () => {
    const doc = iframe.contentDocument;
    const slot = ready && doc ? doc.querySelector(".kestrel-email") : null;
    if (!slot) {
      return;
    }
    // Set as markup (not srcdoc per keystroke): flicker-free, and any <script> stays
    // inert. The publisher's own template, filled with sample values, in its own frame.
    setHtml(slot, unsafeHtml(fillEmailTemplate(getTemplate(), templateSampleCtx(getIdentity()))));
    size();
  };
  iframe.addEventListener("load", () => {
    ready = true;
    repaint();
    // Keep the frame fitted to its content through every change: an edit, the width
    // toggle's animated reflow, or a logo/font finishing loading. The body is
    // content-sized and size() only touches the outer iframe, so this can't loop.
    try {
      const doc = iframe.contentDocument;
      if (doc?.body && typeof ResizeObserver !== "undefined") {
        new ResizeObserver(size).observe(doc.body);
      }
    } catch {}
  });
  iframe.srcdoc = TEMPLATE_FRAME_DOC;
  return { repaint };
}

// The grouped variable reference (a <details> body), shared by both surfaces.
function templateVarsHtml(): Html {
  return html`${EMAIL_TEMPLATE_VARS.map(
    (g) =>
      html`<div class="set-tpl-vargroup"><h4>${g.group}</h4>${g.vars.map(
        (v) =>
          html`<div class="set-tpl-var"><code>${v.token}</code><span class="set-tpl-var-desc">${v.desc}</span></div>`,
      )}</div>`,
  )}`;
}

/** What a save of the template reports: the advisory warnings and the sends it re-made. */
interface TemplateSaved {
  warnings: string[];
  remade: SettingsSavedResponse["remade"];
}

/**
 * The Email template page (top-level "Template" nav item). The one layout each post
 * is sent inside: a live sample-email preview over an HTML editor (with starter
 * examples, a variable reference, and its own validated Save). Editing lives here,
 * not in Settings, so each surface has a single, unambiguous save.
 */
export async function renderTemplate(): Promise<void> {
  setHtml(
    app,
    html`<div class="tpl-page"><div class="page-head"><div class="page-head-row"><h1>Email template</h1><span id="tplInUse"></span></div><p class="set-lede set-page-lede">The template controls the look and feel of the emails you send. You write it as HTML with a <code>&lt;style&gt;</code> block and <code>{{ variables }}</code> Kestrel fills in; your post’s Markdown is rendered into <code>{{ post.body }}</code>.</p></div><div id="tplBody" class="muted">Loading…</div></div>`,
  );
  const bodyEl = $("#tplBody");
  let data: SettingsResponse;
  try {
    data = await api<SettingsResponse>("/api/settings");
  } catch (e) {
    renderError(bodyEl, message(e), renderTemplate);
    return;
  }
  const s = data.settings;
  const d = data.deployment;
  const p = s.publication;
  const identity: TemplateIdentity = {
    name: p.name || parseFromName(d.fromAddress) || "",
    tagline: p.tagline || "",
    logoUrl: p.logoUrl || "",
    address: p.address || "",
  };
  let templateBaseline = s.emailTemplate || "";
  const defaultRecipients = Array.isArray(s.testRecipients) ? s.testRecipients : [];
  // Standing: whether scheduled posts are using this template (SPEC §9, DESIGN §3).
  setHtml($("#tplInUse"), inUseChip(data.inUse));

  setHtml(
    bodyEl,
    html`
    <div class="set-preview set-tpl-sample">
      <div class="set-preview-bar">
        <span class="set-preview-titles">
          <span class="set-preview-lbl">Sample email</span>
          <span class="set-preview-dot">A preview with sample content, showing the layout used for a sent email</span>
        </span>
        <span class="set-preview-actions">
          <span class="set-wtog" role="group" aria-label="Preview width">
            <button type="button" class="wtog-btn" data-w="640" aria-pressed="true">640</button>
            <button type="button" class="wtog-btn" data-w="375" aria-pressed="false">375</button>
          </span>
          <button type="button" class="secondary" id="tplTest">${icon("send")}<span id="tplTestLbl">Send test email</span></button>
        </span>
      </div>
      <div class="set-email-stage" id="tplStage">
        <iframe class="set-email-frame" id="tplPreview" title="Sample email preview" scrolling="no"></iframe>
      </div>
      <div class="set-preview-cap">Your post’s Markdown fills the body, and the <code>{{ email.* }}</code> values are set for each recipient when the post sends. Email clients render differently, so send yourself a test to see it in a real inbox.</div>
    </div>

    <div class="set-card">
      <div class="set-card-pad">
        <div class="set-tpl-block">
          <div class="set-tpl-editor-head">
            <div class="set-tpl-tools">
              <div class="set-menu" id="tplExamples">
                <button type="button" class="ghost set-menu-btn" id="tplExamplesBtn" aria-haspopup="true" aria-expanded="false"><span>Start from example</span><span class="set-menu-caret"></span></button>
                <div class="set-menu-list" id="tplExamplesList" role="menu" hidden>
                  <button type="button" role="menuitem" data-example="plain"><span class="set-menu-name">Plain</span><span class="set-menu-desc">Just the body and the required footer links.</span></button>
                  <button type="button" role="menuitem" data-example="signed"><span class="set-menu-name">Signed</span><span class="set-menu-desc">Adds a sign-off with your logo, name, and tagline.</span></button>
                  <button type="button" role="menuitem" data-example="signedAddress"><span class="set-menu-name">Signed + address</span><span class="set-menu-desc">Adds your postal mailing address — what bulk-mail rules require.</span></button>
                </div>
              </div>
              <button type="button" class="set-icon-btn" id="tplLineNums" aria-pressed="false" title="Show line numbers" aria-label="Show line numbers">${icon("lines")}</button>
              <button type="button" class="ghost" id="tplCopyAll" title="Copy the whole template to the clipboard">${icon("copyout")}<span id="tplCopyLbl">Copy</span></button>
            </div>
            <div class="set-tpl-required" aria-label="Required variables">
              <span class="set-req-lbl">Required</span>
              <span class="set-req-pill" id="reqBody"><span class="dot"></span>{{ post.body }}</span>
              <span class="set-req-pill" id="reqUnsub"><span class="dot"></span>{{ email.unsubscribeUrl }}</span>
            </div>
          </div>
          <div class="set-tpl-editor-wrap" id="tplEditorWrap">
            <div class="set-tpl-gutter" id="tplGutter" aria-hidden="true">1</div>
            <pre class="set-tpl-hl" id="tplHl" aria-hidden="true"><code></code></pre>
            <textarea id="tplEditor" class="set-tpl-editor" spellcheck="false" wrap="off" aria-label="Email template HTML"></textarea>
          </div>
          <div class="set-tpl-msgs" id="tplMsgs" hidden></div>
        </div>
      </div>
      <div class="set-note">${icon("info")}<span>Kestrel uses this one template for every post, starting from a sensible default. Saving a change while posts are scheduled applies it to their emails too, after you confirm, so nothing scheduled goes out on an older look; their content stays as it was. Sent emails are archived exactly as they went out and never change. Save and Discard are in the bar at the bottom of the page.</span></div>
    </div>

    <div class="set-card set-tpl-varcard">
      <div class="set-card-pad">
        <div class="set-tpl-varhead">
          <h3 class="set-tpl-vartitle">Variables</h3>
          <p class="field-hint">Kestrel replaces these variables with real values when you send an email. Type a variable exactly as shown, or it renders as empty. Double-click a variable to select it, then copy.</p>
        </div>
        <div class="set-tpl-vars-body">${templateVarsHtml()}</div>
      </div>
    </div>`,
  );

  const tplEditor = $<HTMLTextAreaElement>("#tplEditor");
  const preview = mountSampleEmailPreview(
    $<HTMLIFrameElement>("#tplPreview"),
    () => tplEditor.value,
    () => identity,
  );
  const tplMsgsEl = $("#tplMsgs");
  const tplTestEl = $<HTMLButtonElement>("#tplTest");
  const tplTestLbl = $("#tplTestLbl");
  const isDirty = () => tplEditor.value !== templateBaseline;

  // Syntax-highlight overlay (issue #123): a transparent <textarea> over a highlighted
  // <pre>, plus a line-number gutter, kept in scroll sync. Vanilla, no dependency.
  const tplHl = $("#tplHl");
  const tplHlCode = $("code", tplHl);
  const tplGutter = $("#tplGutter");
  const paintEditor = () => {
    const src = tplEditor.value;
    // Trailing newline so the last line renders and the overlay height matches the textarea.
    setHtml(tplHlCode, html`${highlightTemplate(src)}\n`);
    let g = "";
    const lines = src.split("\n").length;
    for (let i = 1; i <= lines; i++) {
      g += `${i}\n`;
    }
    tplGutter.textContent = g;
  };
  const syncScroll = () => {
    tplHl.scrollTop = tplEditor.scrollTop;
    tplHl.scrollLeft = tplEditor.scrollLeft;
    tplGutter.scrollTop = tplEditor.scrollTop;
  };
  tplEditor.addEventListener("scroll", syncScroll);

  // The two blocking-required tokens, predicted live in the toolbar pills: green when
  // present, red when missing — so a rejected save is visible before you press Save.
  const reqBodyEl = $("#reqBody");
  const reqUnsubEl = $("#reqUnsub");
  const paintReq = () => {
    reqBodyEl.className = `set-req-pill ${/\{\{\s*post\.body\s*\}\}/.test(tplEditor.value) ? "ok" : "bad"}`;
    reqUnsubEl.className = `set-req-pill ${/\{\{\s*email\.unsubscribeUrl\s*\}\}/.test(tplEditor.value) ? "ok" : "bad"}`;
  };

  // Save + Discard live in the shared bottom save bar (onSave/onDiscard below); the
  // page never renders its own Save button. A rejected save (e.g. a template missing
  // {{ email.unsubscribeUrl }}, a 400) is a blocking error, so it shows IN the bar
  // (which stays up, right beside Save). Warnings are advisory and describe the
  // template that was just saved, so they stay inline under the editor.
  const bar = savebar.attach({ onSave: onSaveTemplate, onDiscard: revertTemplate });

  function refreshDirty() {
    paintEditor();
    paintReq();
    syncScroll();
    bar.setDirty(isDirty());
    // A test always sends the SAVED template (what will ship, I5). When there are
    // unsaved edits the button says so plainly: it saves first, then sends.
    tplTestLbl.textContent = isDirty() ? "Save & send test" : "Send test email";
    tplTestEl.title = isDirty()
      ? "Saves your changes first, then sends — a test always reflects the saved template that will ship."
      : "Sends a sample post through the saved template so you can see it in a real inbox.";
  }
  // Advisory warnings for the template that was just saved; blocking errors go to the
  // save bar instead (bar.showError), so the bar owns the blocking state and this owns
  // the post-save advisory state.
  function showWarnings(msgs: string[]) {
    if (!msgs.length) {
      tplMsgsEl.hidden = true;
      setHtml(tplMsgsEl, html``);
      return;
    }
    tplMsgsEl.hidden = false;
    tplMsgsEl.className = "set-tpl-msgs warn";
    setHtml(tplMsgsEl, html`${msgs.map((m) => html`<div>${m}</div>`)}`);
  }
  function revertTemplate() {
    tplEditor.value = templateBaseline;
    showWarnings([]);
    preview.repaint();
    refreshDirty();
  }
  // Persist the current editor content, confirming first when the save would apply to
  // scheduled emails (withRemakeConfirm). Returns the warnings and what was re-made, or
  // null when the publisher declined the confirmation (nothing was saved; the page stays
  // dirty). THROWS on a rejected template (no unsubscribe link → 400) or a send about to
  // fire (409 remake_too_close), so callers decide what to do. Shared by the save bar's
  // Save and Save-&-send-test.
  async function saveTemplate(): Promise<TemplateSaved | null> {
    const value = tplEditor.value;
    const r = await withRemakeConfirm((ack) => {
      const body: SettingsPatchBody = ack
        ? { emailTemplate: value, remake: ack }
        : { emailTemplate: value };
      return api<SettingsSavedResponse>("/api/settings", { method: "PUT", json: body });
    }, REMAKE_TEMPLATE);
    if (!r) {
      return null;
    }
    // The server may resolve "" to the default — reflect what was actually stored.
    templateBaseline = r.settings.emailTemplate;
    tplEditor.value = templateBaseline;
    // The cached config the sidebar reads: this page's own response, with the saved half.
    appState.appConfig = { ...data, settings: r.settings };
    preview.repaint();
    refreshDirty(); // clean now — slides the bar away
    return { warnings: Array.isArray(r.warnings) ? r.warnings : [], remade: r.remade || [] };
  }
  // The shared save bar's Save button (run inside busy() by the controller). Persists,
  // surfaces warnings inline; a rejected save keeps the bar up and shows why in it.
  async function onSaveTemplate() {
    try {
      const saved = await saveTemplate();
      if (!saved) {
        return; // declined: the edits stay, the bar stays up
      }
      showWarnings(saved.warnings);
      toast(
        savedToast(
          saved.warnings.length ? "Template saved with warnings" : "Template saved",
          saved.remade,
        ),
      );
    } catch (err) {
      // The bar owns the blocking error (it stays up and says why). No toast — a
      // bottom-center toast would sit on top of the bar and hide the very message.
      bar.showError(message(err));
    }
  }

  const loadExample = (key: string) => {
    const ex = EMAIL_TEMPLATE_EXAMPLES[isExampleKey(key) ? key : "signed"];
    tplEditor.value = ex.html;
    showWarnings([]);
    preview.repaint();
    refreshDirty();
  };
  tplEditor.addEventListener("input", () => {
    preview.repaint();
    refreshDirty();
  });
  // Examples: a "Start from example" dropdown menu (a compact, secondary action —
  // loading one is destructive, so it isn't a permanent fixture on the page).
  const exBtn = $<HTMLButtonElement>("#tplExamplesBtn");
  const exList = $("#tplExamplesList");
  const closeExamples = () => {
    exList.hidden = true;
    exBtn.setAttribute("aria-expanded", "false");
  };
  exBtn.onclick = (e) => {
    e.stopPropagation();
    const willOpen = exList.hidden;
    exList.hidden = !willOpen;
    exBtn.setAttribute("aria-expanded", String(willOpen));
  };
  for (const b of $$<HTMLButtonElement>("[data-example]", exList)) {
    b.onclick = () => {
      loadExample(b.dataset.example ?? "");
      closeExamples();
    };
  }
  // Outside-click dismissal, bound ONCE for the app's lifetime (not per visit, which
  // leaked a listener + a detached wrapper each time). It resolves the menu live by id,
  // so it's inert whenever the Template page isn't mounted, and it can't race the open
  // click — that click's target is inside #tplExamples, so it's ignored here.
  if (!exampleMenuDismissBound) {
    exampleMenuDismissBound = true;
    document.addEventListener("click", (e) => {
      const wrap = document.getElementById("tplExamples");
      const list = document.getElementById("tplExamplesList");
      const inside = e.target instanceof Node && wrap?.contains(e.target);
      if (wrap && list && !list.hidden && !inside) {
        list.hidden = true;
        document.getElementById("tplExamplesBtn")?.setAttribute("aria-expanded", "false");
      }
    });
  }

  // Preview width toggle (640 / 375) — proof both inbox measures; 640 is the default.
  const frameEl = $<HTMLIFrameElement>("#tplPreview");
  for (const wb of $$<HTMLButtonElement>(".wtog-btn", bodyEl)) {
    wb.onclick = () => {
      for (const o of $$<HTMLButtonElement>(".wtog-btn", bodyEl)) {
        o.setAttribute("aria-pressed", String(o === wb));
      }
      frameEl.style.maxWidth = `${wb.dataset.w}px`;
      preview.repaint();
    };
  }

  // Line numbers: hidden by default; the toolbar toggle shows them and the choice is
  // remembered per browser (a lightweight convenience — safe to lose).
  const editorWrap = $("#tplEditorWrap");
  const lineNumsBtn = $<HTMLButtonElement>("#tplLineNums");
  const setLineNums = (on: boolean) => {
    editorWrap.classList.toggle("show-lines", on);
    lineNumsBtn.setAttribute("aria-pressed", String(on));
    syncScroll();
  };
  let lineNumsOn = false;
  try {
    lineNumsOn = localStorage.getItem("kestrel.tpl.lineNums") === "1";
  } catch {}
  setLineNums(lineNumsOn);
  lineNumsBtn.onclick = () => {
    lineNumsOn = !lineNumsOn;
    setLineNums(lineNumsOn);
    try {
      localStorage.setItem("kestrel.tpl.lineNums", lineNumsOn ? "1" : "0");
    } catch {}
  };

  // Copy the whole template to the clipboard.
  const copyAllBtn = $<HTMLButtonElement>("#tplCopyAll");
  const copyAllLbl = $("#tplCopyLbl");
  copyAllBtn.onclick = async () => {
    await copyText(tplEditor.value);
    copyAllBtn.classList.add("copied");
    copyAllLbl.textContent = "Copied";
    setTimeout(() => {
      copyAllBtn.classList.remove("copied");
      copyAllLbl.textContent = "Copy";
    }, 1100);
  };

  // --- send a test of the saved template (edit → test → iterate) ---
  // A test renders a sample post through the SAVED template — what will actually
  // ship (I5). So if the editor is dirty we save first (a "Save & send test" flow);
  // a rejected save (e.g. missing unsubscribe) stops the send, honestly. We never
  // render unsaved editor content, which would test something that won't ship.
  tplTestEl.onclick = () => {
    const dirty = isDirty();
    const m = modal(
      html`<h3>Send a test email</h3><p class="hint">Delivers a sample post rendered through your <strong>saved</strong> template, so you can see it in a real inbox. One address per line.</p>${
        dirty
          ? html`<p class="hint" style="color:var(--warn-fg)"><strong>Unsaved changes:</strong> sending will save your template first, so the test reflects what will actually ship.</p>`
          : null
      }<label for="tplTestTo">Recipients</label><textarea id="tplTestTo" rows="3" placeholder="you@example.com"></textarea><p class="hint" id="tplTestHint" hidden></p><div class="actions"><button type="button" id="ttCancel">Cancel</button><button type="button" class="primary" id="ttGo">${
        dirty ? "Save & send test" : "Send test"
      }</button></div>`,
    );
    const to = $<HTMLTextAreaElement>("#tplTestTo", m.el);
    to.focus();
    // Pre-fill from the saved default test recipients (don't clobber typed input).
    if (defaultRecipients.length && !to.value.trim()) {
      to.value = defaultRecipients.join("\n");
      const hint = $("#tplTestHint", m.el);
      hint.textContent = "Pre-filled from your default test recipients (Settings).";
      hint.hidden = false;
    }
    const go = $<HTMLButtonElement>("#ttGo", m.el);
    $("#ttCancel", m.el).onclick = m.close;
    go.onclick = () =>
      busy(go, isDirty() ? "Saving…" : "Sending…", async () => {
        const addrs = parseAddresses(to.value);
        if (!addrs.length) {
          toast("Enter at least one email address");
          return;
        }
        // Honest unsaved-changes handling: persist first so the test renders what ships.
        // A rejected save shows in the bar and stops the send.
        if (isDirty()) {
          try {
            const saved = await saveTemplate();
            if (!saved) {
              m.close(); // declined the re-make: nothing saved, so nothing to test yet
              return;
            }
            showWarnings(saved.warnings);
          } catch (err) {
            // The save failed, so the test can't send what would ship. The bar shows
            // why (and stays up); closing the dialog returns you to it. No toast — it
            // would overlay the bar and hide the reason.
            bar.showError(message(err));
            m.close();
            return;
          }
        }
        try {
          const r = await api<TemplateTestResponse>("/api/settings/template/test", {
            method: "POST",
            json: { to: addrs },
          });
          m.close();
          toast(
            withNoProviderNote(
              r.sent === r.total
                ? `Test sent to ${r.sent} address${r.sent === 1 ? "" : "es"}`
                : `Sent ${r.sent}/${r.total} — some failed`,
            ),
          );
        } catch (e) {
          toast(message(e));
        }
      });
  };
  tplEditor.value = templateBaseline;
  preview.repaint();
  refreshDirty();
}
