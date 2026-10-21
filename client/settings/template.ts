// The email template page: the sample preview, the example menu, and the template
// editor.

import { emailLogoHtml } from "../../shared/email_logo";
import { publicationName } from "../../shared/publication";
import {
  ADDRESS_NOT_PRINTED,
  type SettingsPatchBody,
  type SettingsResponse,
  type SettingsSavedResponse,
  type TemplateTestResponse,
} from "../../shared/settings";
import { api, describeError } from "../api";
import { notConnectedTestLine, providerNotConnected, withNoProviderNote } from "../deployment";
import { mount, setTitle } from "../lifecycle";
import { appState } from "../state";
import { copyFace, copyWith } from "../ui/copy";
import { $, $$ } from "../ui/dom";
import { EMAIL_FRAME_SANDBOX, openLinksInNewTab } from "../ui/email_frame";
import { invalidAddressesMessage, notSentMessage, parseAddresses } from "../ui/format";
import { highlightTemplate } from "../ui/highlight";
import { escapeHtml, type Html, html, setHtml, unsafeHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { savebar } from "../ui/savebar";
import { busy, modal, openMenu, renderError, toast } from "../ui/widgets";
import { addressDocsLink } from "./identity";
import {
  expireRemakeWait,
  inUseChip,
  REMAKE_TEMPLATE,
  remakeWaitHtml,
  savedToast,
  withRemakeConfirm,
} from "./remake";

const message = describeError;

// The one layout each post ships inside, authored as an HTML template with
// logic-less {{ }} placeholders over a fixed variable context. Logic-less means a
// token is only ever swapped for its value — nothing executes — which is why this
// is a template editor, not a WYSIWYG. Edits commit through the shared save bar. A
// send renders the saved template through the single render path (SPEC §5, I5) and
// freezes the result at schedule (I3); the sample here only fills the placeholders
// with sample values in the browser, so it shows the layout, and a test email is the
// real render.

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
        token: "{{ .Post.Body }}",
        desc: "Your post’s Markdown, rendered to HTML.",
      },
      { token: "{{ .Post.Subject }}", desc: "The post’s subject line." },
    ],
  },
  {
    group: "Publication",
    vars: [
      { token: "{{ .Publication.Name }}", desc: "Publication name (from Identity, above)." },
      { token: "{{ .Publication.Tagline }}", desc: "Your tagline." },
      {
        token: "{{ .Publication.Logo }}",
        desc: "Your logo as an image, or nothing when no logo is set.",
      },
      { token: "{{ .Publication.LogoURL }}", desc: "Absolute URL of your logo, or empty." },
      {
        token: "{{ .Publication.Address }}",
        desc: "Your mailing address, if you’ve added one in Settings; empty otherwise. Keep it in the footer if you send promotional email.",
      },
    ],
  },
  {
    group: "Email",
    vars: [
      { token: "{{ .Email.SentTo }}", desc: "The recipient’s address (filled per send)." },
      { token: "{{ .Email.UnsubscribeURL }}", desc: "Their one-click unsubscribe link." },
      { token: "{{ .Email.ViewInBrowserURL }}", desc: "The web version’s permanent URL." },
    ],
  },
  {
    group: "Email only",
    vars: [
      {
        token: "{{ if .IsEmail }} … {{ end }}",
        desc: "Reports whether this is the email or the web version. Put your unsubscribe link and address inside; the web version leaves them out.",
      },
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
  /** The line under its name in the "Start from example" menu. */
  description: string;
  html: string;
}
type ExampleKey = "signed" | "plain";
export const EMAIL_TEMPLATE_EXAMPLES: Record<ExampleKey, TemplateExample> = {
  signed: {
    label: "Signed",
    description:
      "Your post, then your logo, name, and tagline as a sign-off. Your mailing address sits in the footer once you add one.",
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
  .signoff .logo {
    display: block;
    border-radius: 9px;
    margin-right: 14px;
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
  {{ .Post.Body }}

  <hr class="rule" />

  <table class="signoff" role="presentation" cellpadding="0" cellspacing="0">
    <tr>
      <td class="logo-cell">{{ .Publication.Logo }}</td>
      <td>
        <div class="name">{{ .Publication.Name }}</div>
        <div class="tagline">{{ .Publication.Tagline }}</div>
      </td>
    </tr>
  </table>

  <div class="footer">
    Powered by Kestrel{{ if .IsEmail }} ·
    <a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a> ·
    <a href="{{ .Email.ViewInBrowserURL }}">View in browser</a>
    <div class="address">{{ .Publication.Address }}</div>{{ end }}
  </div>
</div>`,
  },
  plain: {
    label: "Plain",
    description:
      "Just your post and the footer links. Your mailing address sits in the footer once you add one.",
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
    .footer {
      color: #a1a1aa !important;
    }
    .footer a {
      color: #a1a1aa !important;
    }
  }
</style>

<div class="email">
  {{ .Post.Body }}

  <hr class="rule" />

  <div class="footer">
    Powered by Kestrel{{ if .IsEmail }} ·
    <a href="{{ .Email.UnsubscribeURL }}">Unsubscribe</a> ·
    <a href="{{ .Email.ViewInBrowserURL }}">View in browser</a>
    <div class="address">{{ .Publication.Address }}</div>{{ end }}
  </div>
</div>`,
  },
};
const isExampleKey = (k: string): k is ExampleKey => Object.hasOwn(EMAIL_TEMPLATE_EXAMPLES, k);

// Sample post body for the preview — representative prose inside a called-out slot,
// so it's unmistakable where a real post's rendered Markdown lands. Its typography
// comes from the template's own .email rules (the callout frame + label are a
// preview device, not part of the email). In a real send {{ .Post.Body }} is the
// rendered Markdown.
const EMAIL_TEMPLATE_SAMPLE_BODY =
  '<div style="position:relative;border:1px dashed #93a7e6;border-radius:8px;padding:20px 14px 8px;margin:0 0 6px">' +
  "<span style=\"position:absolute;top:-8px;left:10px;font:650 10px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.04em;text-transform:uppercase;color:#3355cc;background:#fff;padding:0 6px\">Your post’s Markdown renders here</span>" +
  '<h2 style="margin:0 0 10px">Lorem ipsum,</h2>' +
  '<p style="margin:0">Dolor sit amet, consectetur adipiscing elit. Proin sed ex ipsum. Suspendisse vulputate nisi et odio dapibus, quis pellentesque felis sollicitudin. Proin vel cursus enim. Phasellus sollicitudin malesuada elementum. Suspendisse euismod eros turpis, ut mollis est imperdiet ut. Sed luctus accumsan erat, at eleifend purus eleifend quis.</p>' +
  "</div>";

// Fill logic-less {{ token }} placeholders from a flat context. {{ .Post.Body }} (the
// rendered Markdown) and {{ .Publication.Logo }} (built with its own escaping) are raw
// HTML; every other value is escaped, so a stray < or "
// in a name can't break the surrounding markup. An unknown token renders empty, and the
// region tags ({{ if .IsEmail }}, {{ end }}) render nothing: the sample is the email, which
// carries the region's content. A string
// builder by nature: the template is the publisher's own HTML, filled in and vouched for
// at the preview's boundary (mountSampleEmailPreview).
const RAW_TOKENS = new Set([".Post.Body", ".Publication.Logo"]);
function fillEmailTemplate(template: string, ctx: Record<string, string>): string {
  const unmarked = String(template).replace(/\{\{\s*(?:if\b[^}]*|end)\s*\}\}/g, "");
  return unmarked.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) =>
    RAW_TOKENS.has(key) ? ctx[key] || "" : escapeHtml(ctx[key] ?? ""),
  );
}

/** The identity a sample preview binds: the live or loaded publication fields. */
export interface TemplateIdentity {
  name: string;
  tagline: string;
  logoUrl: string;
  address: string;
}

// Sample values the template preview binds — mirrors the render path's context, with
// .Email.* standing in for per-recipient values. The logo is the real one or none, never
// a stand-in: the preview shows the sign-off the email will carry.
function templateSampleCtx(id: TemplateIdentity): Record<string, string> {
  const name = id.name || "Your publication";
  return {
    ".Post.Body": EMAIL_TEMPLATE_SAMPLE_BODY,
    ".Post.Subject": "The starlings are back",
    ".Publication.Name": name,
    ".Publication.Tagline": id.tagline || "Your tagline",
    ".Publication.LogoURL": id.logoUrl,
    ".Publication.Logo": emailLogoHtml(id.logoUrl, name),
    ".Publication.Address": id.address,
    ".Email.SentTo": "you@example.com",
    ".Email.UnsubscribeURL": "#unsubscribe",
    ".Email.ViewInBrowserURL": "#view-in-browser",
  };
}

/** A template filled with the preview's sample values: what the sample email shows. */
export function sampleEmailHtml(template: string, id: TemplateIdentity): string {
  return fillEmailTemplate(template, templateSampleCtx(id));
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
 * Template page (live editor preview) and Settings (a read-only one). The frame takes the
 * Preview tab's sandbox: the template is HTML Claude may write too (`PUT /api/settings`),
 * and markup set into a same-origin frame runs an inline handler (`onerror`) though it
 * leaves a `<script>` inert, so without the sandbox a template could act as the
 * publisher (SPEC §5).
 */
export function mountSampleEmailPreview(
  iframe: HTMLIFrameElement,
  getTemplate: () => string,
  getIdentity: () => TemplateIdentity,
): SampleEmailPreview {
  // Before the srcdoc below: a sandbox applies from the frame's next navigation.
  iframe.setAttribute("sandbox", EMAIL_FRAME_SANDBOX);
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
    // Set as markup (not srcdoc per keystroke): flicker-free. A <script> stays inert and
    // the frame's sandbox stops an inline handler. The publisher's own template, filled
    // with sample values, in its own frame.
    setHtml(slot, unsafeHtml(sampleEmailHtml(getTemplate(), getIdentity())));
    openLinksInNewTab(slot.ownerDocument);
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
export async function renderTemplate(root: HTMLElement, signal: AbortSignal): Promise<void> {
  setTitle(signal, "Template");
  setHtml(
    root,
    html`<div class="tpl-page"><div class="page-head"><div class="page-head-row"><h1>Email template</h1><span id="tplInUse"></span></div><p class="set-lede set-page-lede">The template controls the look and feel of the emails you send. You write it as HTML with a <code>&lt;style&gt;</code> block and <code>{{ variables }}</code> Kestrel fills in; your post’s Markdown is rendered into <code>{{ .Post.Body }}</code>.<span id="tplWait"></span></p></div><div id="tplBody" class="muted">Loading…</div></div>`,
  );
  const bodyEl = $("#tplBody", root);
  let data: SettingsResponse;
  try {
    data = await api<SettingsResponse>("/api/settings", { signal });
  } catch (e) {
    renderError(bodyEl, message(e), () => mount(renderTemplate));
    return;
  }
  const s = data.settings;
  const d = data.deployment;
  const p = s.publication;
  const identity: TemplateIdentity = {
    name: publicationName(p.name || "", d.from_address),
    tagline: p.tagline || "",
    logoUrl: p.logo_url || "",
    address: p.address || "",
  };
  let templateBaseline = s.email_template || "";
  const defaultRecipients = Array.isArray(s.test_recipients) ? s.test_recipients : [];
  // Standing: whether scheduled posts are using this template (SPEC §9, DESIGN §8).
  setHtml($("#tplInUse"), inUseChip(data.in_use));
  // While one is about to send, the lede says saving has to wait for it (DESIGN §11: not
  // on the chip), until it no longer does.
  setHtml($("#tplWait"), html`${remakeWaitHtml(data.in_use)}`);
  expireRemakeWait(root, data.in_use, signal);

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
      <div class="set-preview-cap">Your post’s Markdown fills the body, and the <code>{{ .Email.* }}</code> values are set for each recipient when the post sends. Email clients render differently, so send yourself a test to see it in a real inbox.</div>
    </div>

    <div class="set-card">
      <div class="set-card-pad">
        <div class="set-tpl-block">
          <div class="set-tpl-editor-head">
            <div class="set-tpl-tools">
              <button type="button" class="ghost set-menu-btn" id="tplExamplesBtn" aria-haspopup="menu" aria-expanded="false"><span>Start from example</span><span class="set-menu-caret"></span></button>
              <button type="button" class="set-icon-btn" id="tplLineNums" aria-pressed="false" title="Show line numbers" aria-label="Show line numbers">${icon("lines")}</button>
              <button type="button" class="ghost" id="tplCopyAll" title="Copy the whole template to the clipboard" aria-label="Copy the whole template">${copyFace()}</button>
            </div>
            <div class="set-tpl-required" aria-label="Required variables">
              <span class="set-req-lbl">Required</span>
              <span class="set-req-pill" id="reqBody"><span class="dot"></span>{{ .Post.Body }}</span>
              <span class="set-req-pill" id="reqUnsub"><span class="dot"></span>{{ .Email.UnsubscribeURL }}</span>
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
          <p class="field-hint">Kestrel replaces these variables with real values when you send an email. Type a variable exactly as shown, or it renders as empty.</p>
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

  // Syntax-highlight overlay: a transparent <textarea> over a highlighted
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
    reqBodyEl.className = `set-req-pill ${/\{\{\s*\.Post\.Body\s*\}\}/.test(tplEditor.value) ? "ok" : "bad"}`;
    reqUnsubEl.className = `set-req-pill ${/\{\{\s*\.Email\.UnsubscribeURL\s*\}\}/.test(tplEditor.value) ? "ok" : "bad"}`;
  };

  // Save + Discard live in the shared bottom save bar (onSave/onDiscard below); the
  // page never renders its own Save button. A rejected save (e.g. a template missing
  // {{ .Email.UnsubscribeURL }}, a 400) is a blocking error, so it shows IN the bar
  // (which stays up, right beside Save). Warnings are advisory and describe the
  // template that was just saved, so they stay inline under the editor.
  const bar = savebar.attach({ onSave: onSaveTemplate, onDiscard: revertTemplate }, signal);

  function refreshDirty() {
    paintEditor();
    paintReq();
    syncScroll();
    bar.setDirty(isDirty());
    // A test always sends the SAVED template (what will ship, I5). When there are
    // unsaved edits the button says so plainly: it saves first, then sends.
    tplTestLbl.textContent = isDirty() ? "Save & send test" : "Send test email";
    tplTestEl.title = isDirty()
      ? "Saves your changes first, then sends: a test always reflects the saved template that will ship."
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
    // The mailing-address warning is the API's plain text; the editor links the docs after it.
    setHtml(
      tplMsgsEl,
      html`${msgs.map((m) => html`<div>${m}${m === ADDRESS_NOT_PRINTED ? html` ${addressDocsLink()}` : null}</div>`)}`,
    );
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
    const r = await withRemakeConfirm(
      (ack) => {
        const body: SettingsPatchBody = ack
          ? { email_template: value, remake: ack }
          : { email_template: value };
        return api<SettingsSavedResponse>("/api/settings", { method: "PUT", json: body });
      },
      REMAKE_TEMPLATE,
      signal,
    );
    if (!r) {
      return null;
    }
    // The server may resolve "" to the default — reflect what was actually stored.
    templateBaseline = r.settings.email_template;
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
  // loading one is destructive, so it isn't a permanent fixture on the page). The shared
  // menu gives it the keyboard and focus a menu owes (DESIGN §11) and closes with the page.
  const exBtn = $<HTMLButtonElement>("#tplExamplesBtn");
  exBtn.onclick = () =>
    openMenu(
      exBtn,
      Object.entries(EMAIL_TEMPLATE_EXAMPLES).map(([key, ex]) => ({
        label: ex.label,
        description: ex.description,
        onClick: () => loadExample(key),
      })),
      signal,
      { align: "start" },
    );

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

  // Copy the whole template to the clipboard, said on the button (ui/copy.ts).
  const copyAllBtn = $<HTMLButtonElement>("#tplCopyAll");
  copyAllBtn.onclick = () => copyWith(copyAllBtn, tplEditor.value);

  // --- send a test of the saved template (edit → test → iterate) ---
  // A test renders a sample post through the SAVED template — what will actually
  // ship (I5). So if the editor is dirty we save first (a "Save & send test" flow);
  // a rejected save (e.g. missing unsubscribe) stops the send, honestly. We never
  // render unsaved editor content, which would test something that won't ship.
  tplTestEl.onclick = () => {
    // While no provider is connected the server would refuse a test, so the dialog leaves
    // out the recipients and keeps only the standing line (DESIGN §4), and says nothing of
    // saving first, since nothing will be sent.
    const notConnected = providerNotConnected();
    const dirty = !notConnected && isDirty();
    const m = modal(
      html`<h3>Send a test email</h3><p class="hint">Delivers a sample post rendered through your <strong>saved</strong> template, so you can see it in a real inbox. One address per line.</p>${notConnectedTestLine()}${
        dirty
          ? html`<p class="hint" style="color:var(--warn-fg)"><strong>Unsaved changes:</strong> sending will save your template first, so the test reflects what will actually ship.</p>`
          : null
      }${notConnected ? null : html`<label for="tplTestTo">Recipients</label><textarea id="tplTestTo" rows="3" placeholder="you@example.com"></textarea><p class="hint" id="tplTestHint" hidden></p>`}<div class="actions"><button type="button" id="ttCancel">Cancel</button><button type="button" class="primary" id="ttGo">${
        dirty ? "Save & send test" : "Send test"
      }</button></div>`,
      signal,
    );
    const go = $<HTMLButtonElement>("#ttGo", m.el);
    $("#ttCancel", m.el).onclick = m.close;
    go.disabled = notConnected;
    if (notConnected) {
      $("#ttCancel", m.el).focus();
      return;
    }
    const to = $<HTMLTextAreaElement>("#tplTestTo", m.el);
    to.focus();
    // Pre-fill from the saved default test recipients (don't clobber typed input).
    if (defaultRecipients.length && !to.value.trim()) {
      to.value = defaultRecipients.join("\n");
      const hint = $("#tplTestHint", m.el);
      hint.textContent = "Pre-filled from your default test recipients (Settings).";
      hint.hidden = false;
    }
    go.onclick = () =>
      busy(go, isDirty() ? "Saving…" : "Sending…", async () => {
        m.clearError();
        const { valid: addrs, invalid } = parseAddresses(to.value);
        const notAddresses = invalidAddressesMessage(invalid);
        if (notAddresses) {
          m.error(notAddresses, to);
          return;
        }
        if (!addrs.length) {
          m.error("Enter at least one email address", to);
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
          if (r.failed.length) {
            // The dialog stays open with only the addresses that didn't get it, so Send again
            // tries those and no one gets a second copy.
            to.value = r.failed.join("\n");
            m.error(notSentMessage(r.sent, r.total, r.not_sent));
            return;
          }
          m.close();
          toast(withNoProviderNote(`Test sent to ${r.sent} address${r.sent === 1 ? "" : "es"}`));
        } catch (e) {
          m.error(message(e));
        }
      });
  };
  tplEditor.value = templateBaseline;
  preview.repaint();
  refreshDirty();
}
