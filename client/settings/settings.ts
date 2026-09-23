// The Settings page: publication identity, sending, notifications, confirmation wording,
// test recipients, and the deployment reflection.

import { isValidEmail, normalizeEmail } from "../../shared/email";
import type {
  ConfirmationEmailCopy,
  LogoResponse,
  NotificationStatusKind,
  NotificationTestResponse,
  SettingsPatchBody,
  SettingsResponse,
  SettingsSavedResponse,
  SettingsView,
} from "../../shared/settings";
import { api } from "../api";
import { parseFromName, renderSidebarBrand } from "../brand";
import { mount } from "../lifecycle";
import { appState } from "../state";
import { $, $$ } from "../ui/dom";
import { fmt } from "../ui/format";
import { escapeHtml, type Html, html, setHtml } from "../ui/html";
import { type IconName, icon } from "../ui/icons";
import { savebar } from "../ui/savebar";
import { busy, copyText, renderError, toast } from "../ui/widgets";
import {
  inUseChip,
  isRemakeTooClose,
  remakeIdentity,
  savedToast,
  withRemakeConfirm,
} from "./remake";
import { mountSampleEmailPreview } from "./template";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Runtime preferences (editable) + a read-only reflection of the deploy-time
// config. Secrets never come down this wire (see routes/settings.ts).
const PROVIDER_LABELS: Record<string, string> = {
  fake: "Fake (dev, dead-end)",
  ses: "Amazon SES",
  resend: "Resend",
};

/** The persisted fields the save bar tracks against their saved baseline. */
interface SettingsBaseline {
  name: string;
  tagline: string;
  address: string;
  recipients: string[];
  confirmation: ConfirmationEmailCopy;
  /** Where notifications about sends go (SPEC §8); "" for none. */
  notifyTo: string;
}

/** The page's live, in-memory state: the baseline fields plus what saves on its own. */
interface SettingsFormState extends SettingsBaseline {
  logoUrl: string;
  template: string;
}

type EmbedMode = "plain" | "styled";

// A bare attribute is markup, not text: spelled once as markup so it can be interpolated.
const HIDDEN = html` hidden`;

export async function renderSettings(root: HTMLElement, signal: AbortSignal): Promise<void> {
  setHtml(
    root,
    html`<div class="settings"><div class="page-head"><h1>Settings</h1><p class="set-lede set-page-lede">Your publication's identity, the email each post is sent inside, how mail is sent, and the ways readers subscribe. Facts set when Kestrel was deployed are shown read-only.</p></div><div id="settingsBody" class="muted">Loading…</div></div>`,
  );
  const body = $("#settingsBody", root);
  let data: SettingsResponse;
  try {
    data = await api<SettingsResponse>("/api/settings", { signal });
  } catch (e) {
    renderError(body, message(e), () => mount(renderSettings));
    return;
  }
  const s = data.settings;
  const d = data.deployment;
  const p = s.publication;
  // The From display name as the email actually resolves it ("" for a bare address —
  // see resolveBranding); fromName adds a visible placeholder for the inbox-row From.
  const fromDisplay = parseFromName(d.fromAddress) || "";
  const fromName = fromDisplay || "Your publication";

  // Live, in-memory state. The save bar tracks the PERSISTED identity fields (name,
  // tagline, address) + test recipients against the saved baseline. The logo is
  // immediate (its own endpoints); the email template has its own Save (it validates
  // and can warn), so it doesn't feed the bar.
  const ce = s.confirmationEmail;
  const ceDefault = s.confirmationEmailDefault;
  const state: SettingsFormState = {
    name: p.name || "",
    tagline: p.tagline || "",
    address: p.address || "",
    logoUrl: p.logoUrl || "",
    recipients: [...(s.testRecipients || [])],
    template: s.emailTemplate || "",
    // The confirmation email's words (SPEC §7); the layout, masthead, and confirm link
    // are Kestrel's.
    confirmation: {
      subject: ce.subject || "",
      body: ce.body || "",
      buttonLabel: ce.buttonLabel || "",
      reassurance: ce.reassurance || "",
    },
    notifyTo: s.notifications.to || "",
  };
  let baseline: SettingsBaseline = {
    name: state.name,
    tagline: state.tagline,
    address: state.address,
    recipients: [...state.recipients],
    confirmation: { ...state.confirmation },
    notifyTo: state.notifyTo,
  };

  const monogram = (v: string) => (String(v || fromName).trim()[0] || "K").toUpperCase();
  const bareAddress = (from: string) => {
    const m = String(from || "").match(/<([^>]+)>/);
    return m?.[1] ? m[1] : String(from || "");
  };

  // Subscribe URL + embeds: paste into your own site; both post to the public
  // /subscribe and start the double opt-in — never an auto-confirm (I1). The snippet is
  // HTML the publisher pastes into their own page, so it is text here (shown in a code
  // block and copied), escaped for the page it will land in.
  const appOrigin = d.appOrigin || location.origin;
  const subscribeUrl = `${appOrigin}/subscribe`;
  const embedAction = `${escapeHtml(appOrigin)}/subscribe`;
  const buildEmbed = (mode: EmbedMode, nameRaw: string): string => {
    const name = escapeHtml(nameRaw || fromName);
    if (mode === "styled") {
      return (
        `<form action="${embedAction}" method="post" style="max-width:420px;font:15px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif">\n` +
        `  <div style="font-weight:600;margin-bottom:6px">Subscribe to ${name}</div>\n` +
        `  <div style="display:flex;gap:8px;flex-wrap:wrap">\n` +
        `    <input type="email" name="email" required placeholder="you@example.com" aria-label="Email address" style="flex:1 1 200px;padding:10px 12px;border:1px solid #d4d4d8;border-radius:8px;font:inherit">\n` +
        `    <button type="submit" style="padding:10px 18px;border:0;border-radius:8px;background:#18181b;color:#fff;font:inherit;font-weight:600;cursor:pointer">Subscribe</button>\n` +
        `  </div>\n` +
        `  <p style="margin:8px 0 0;font-size:13px;color:#71717a">Double opt-in — we'll email a confirmation link. Unsubscribe anytime.</p>\n` +
        `</form>`
      );
    }
    return (
      `<form action="${embedAction}" method="post">\n` +
      `  <label>\n` +
      `    Subscribe to ${name}\n` +
      `    <input type="email" name="email" placeholder="you@example.com" required>\n` +
      `  </label>\n` +
      `  <button type="submit">Subscribe</button>\n` +
      `</form>`
    );
  };

  const chip = (kind: IconName, label: string): Html =>
    html`<span class="set-chip ${kind}">${icon(kind)}${label}</span>`;
  const secHead = (title: string, chipHtml: Html, extra: Html | null = null): Html =>
    html`<div class="set-sec-head"><h2 class="set-sec-title">${title}</h2>${chipHtml}${extra}<span class="set-rule"></span></div>`;

  // The note under the card: where the identity shows up and, only while posts are
  // scheduled, that a save reaches them too (SPEC §9). The confirmation dialog carries the
  // rest, at the moment it matters, so the standing note stays one or two short lines.
  const inUse = data.inUse;
  const identityNote = (() => {
    if (!(inUse.identityFields || []).length) {
      return "Your email template doesn’t show any of these.";
    }
    const shown = "Shown in every email.";
    const n = inUse.sends.length;
    if (!n) {
      return shown;
    }
    const reach = `Saving a change updates ${n} scheduled email${n === 1 ? "" : "s"} too; you’ll confirm first.`;
    const wait = inUse.retry_after
      ? ` One sends at ${fmt(inUse.retry_after)}, so saving waits until it has sent.`
      : "";
    return `${shown} ${reach}${wait}`;
  })();

  // The logo tile's background image is set from the DOM (applyLogoUi), not written into
  // the markup: a URL has no place inside a style attribute the tag would escape as text.
  const identitySection = html`
    <section class="set-sec">
      ${secHead("Publication identity", chip("editable", "Editable"))}
      <div class="set-card">
        <div class="set-id-grid">
          <div class="set-logo-slot">
            <div class="set-logo-tile${state.logoUrl ? " has-img" : ""}" id="logoTile" role="button" tabindex="0" aria-label="Upload logo">
              <span class="set-logo-ph" id="logoPh"${state.logoUrl ? HIDDEN : null}>${icon("upload")}Upload</span>
            </div>
            <input type="file" id="logoInput" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>
            <div class="set-logo-actions">
              <button type="button" id="logoReplace">${state.logoUrl ? "Replace" : "Upload"}</button>
              <button type="button" class="danger-subtle" id="logoRemove"${state.logoUrl ? null : HIDDEN}>Remove</button>
            </div>
            <p class="field-hint">PNG, JPEG, WebP, GIF, or SVG, up to 512&nbsp;KB. Saves immediately.</p>
            <div class="field-error" id="logoError" role="alert" hidden><span class="field-error-ico" aria-hidden="true">!</span><span></span></div>
          </div>
          <div class="set-id-fields">
            <div class="set-field">
              <label for="setName">Name</label>
              <input id="setName" value="${state.name}" placeholder="${fromName}" maxlength="120" autocomplete="off">
              <p class="field-hint">Blank falls back to the email “From” name (“${fromName}”).</p>
            </div>
            <div class="set-field">
              <label for="setTagline">Tagline</label>
              <input id="setTagline" value="${state.tagline}" placeholder="A one-line description" maxlength="200" autocomplete="off">
              <p class="field-hint">A short line under the name on your public pages.</p>
            </div>
            <div class="set-field">
              <label for="setAddress">Mailing address</label>
              <input id="setAddress" value="${state.address}" placeholder="123 Main St, City, ST 00000" maxlength="300" autocomplete="off">
              <p class="field-hint">A physical postal address for the email footer. Bulk or commercial mail usually requires one.</p>
            </div>
          </div>
        </div>
        <div class="set-note">${icon("info")}<span>${identityNote}</span></div>
      </div>
    </section>`;

  const templateSection = html`
    <section class="set-sec">
      ${secHead("Email template", chip("editable", "Editable"), inUseChip(inUse))}
      <p class="set-lede">The template controls the look and feel of the emails you send. Edit it on the Template page.</p>
      <div class="set-preview set-tpl-sample">
        <div class="set-preview-bar">
          <span class="set-preview-lbl">Sample email</span>
          <span class="set-preview-dot">Current template</span>
        </div>
        <iframe class="set-email-frame" id="tplPreview" title="Sample email preview" scrolling="no"></iframe>
      </div>
      <div class="row" style="margin-top:12px"><button type="button" class="primary" id="tplEditLink">Edit template →</button></div>
    </section>`;

  const senderSection = html`
    <section class="set-sec">
      ${secHead("Email sender", chip("readonly", "Read-only · set at deploy"))}
      <div class="set-card sunken">
        <div class="set-ro-note">${icon("readonly")}<span>The sender is fixed at deploy via environment secrets, so it can’t be edited here. Change it in the <a class="set-link" href="#/docs">setup guide</a>, then redeploy. Credentials are never shown.</span></div>
        <div class="set-preview-bar" style="background:transparent">
          <span class="set-preview-lbl">Inbox preview</span>
          <span class="set-preview-dot">How readers see the sender</span>
        </div>
        <div class="set-inbox">
          <div class="set-inbox-avatar">${monogram(fromName)}</div>
          <div class="set-inbox-body">
            <div class="set-inbox-top"><span class="set-inbox-from">${fromName}</span><span class="set-inbox-time">9:02 AM</span></div>
            <div class="set-inbox-subj">Your latest post — a sample subject line</div>
            <div class="set-inbox-snip">The opening lines of your post show here as the inbox preview…</div>
            <div class="set-inbox-addr">${bareAddress(d.fromAddress)}</div>
          </div>
        </div>
        <div class="set-kv" style="border-top:1px solid var(--line)">
          <div class="set-kv-k">From address</div><div class="set-kv-v"><span class="mono">${d.fromAddress}</span></div>
          <div class="set-kv-k">Sending domain</div><div class="set-kv-v"><span class="mono">${d.sendingDomain}</span></div>
          <div class="set-kv-k">Email provider</div><div class="set-kv-v">${PROVIDER_LABELS[d.provider] || d.provider}</div>
        </div>
      </div>
    </section>`;

  // Notifications (SPEC §8): where they go is a preference; how they get there, and from
  // whom, is deploy config, shown read-only beside it with how the last one went.
  const notifySection = html`
    <section class="set-sec">
      ${secHead("Notifications", chip("editable", "Editable"))}
      <p class="set-lede">Kestrel emails you when a send goes out, and right away if a send runs into a problem.</p>
      <div class="set-card">
        <div class="set-recip">
          <div class="set-field" style="margin:0">
            <label for="notifyTo">Send notifications to</label>
            <input type="email" id="notifyTo" value="${state.notifyTo}" placeholder="you@example.com" autocomplete="off">
            <p class="field-hint">One address. Leave blank for no notifications.</p>
          </div>
          <div class="row"><button type="button" class="ghost" id="notifyTest">Send a test notification</button><span class="field-hint" id="notifyTestHint"></span></div>
        </div>
        <div class="set-kv" style="border-top:1px solid var(--line)">
          <div class="set-kv-k">Sent through</div><div class="set-kv-v">${notifyChannelLabel(d.notifyChannel, PROVIDER_LABELS[d.provider] || d.provider)}</div>
          <div class="set-kv-k">From address</div><div class="set-kv-v"><span class="mono">${d.notifyFrom}</span></div>
          <div class="set-kv-k">Last notification</div><div class="set-kv-v" id="notifyStatus">${notificationStatusHtml(data.notificationStatus)}</div>
        </div>
        <div class="set-note">${icon("readonly")}<span>The channel and its sender are set at deploy. ${d.notifyChannel === "provider" ? "Notifications go through your newsletter's own provider, so one about the provider refusing your account cannot reach you; Cloudflare's email avoids that. " : ""}See the <a class="set-link" href="#/docs">setup guide</a>.</span></div>
      </div>
    </section>`;

  const recipSection = html`
    <section class="set-sec">
      ${secHead("Default test recipients", chip("editable", "Editable"))}
      <div class="set-card">
        <div class="set-recip">
          <p class="field-hint" style="margin:0">Pre-filled into <strong>Send test email</strong> so you can proof a post against your own inboxes before scheduling. These are your addresses, and they don’t go through the subscribe/consent flow.</p>
          <div class="set-chips" id="recipChips"></div>
          <div class="set-recip-add">
            <input type="email" id="recipInput" placeholder="you@example.com" autocomplete="off">
            <button type="button" id="recipAdd">Add inbox</button>
          </div>
        </div>
      </div>
    </section>`;

  const subscribeSection = html`
    <section class="set-sec">
      ${secHead("Ways to subscribe", chip("copyout", "Copy-out"))}
      <div class="set-card set-card-pad">
        <div class="set-field">
          <label>Public subscribe page</label>
          <div class="pub-row">
            <code class="pub-val">${subscribeUrl}</code>
            <button class="ghost" data-copy="${subscribeUrl}">Copy</button>
            <a class="ghost-link" href="${subscribeUrl}" target="_blank" rel="noopener">Open&nbsp;↗</a>
          </div>
          <p class="field-hint">The double opt-in page Kestrel hosts. Share it directly, or embed the form below.</p>
        </div>
        <div class="set-embed-head" style="margin-top:18px">
          <label style="margin:0">Embeddable subscribe form</label>
          <div class="seg" role="group" aria-label="Snippet style">
            <button type="button" class="seg-btn active" data-embed="plain">Plain HTML</button>
            <button type="button" class="seg-btn" data-embed="styled">Styled</button>
          </div>
        </div>
        <p class="field-hint" id="embedHint" style="margin:0 0 10px"></p>
        <div class="set-embed-preview">
          <div class="set-embed-cap">Rendered preview</div>
          <div id="embedPreview"></div>
        </div>
        <div class="set-embed" style="margin-top:14px"><pre><code id="embedCode"></code></pre></div>
        <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="ghost" id="embedCopy">Copy code</button></div>
      </div>
    </section>`;

  // The double opt-in confirmation email (SPEC §7): a preview-first section with a
  // Preview | Edit segmented toggle. Words only — Kestrel owns the layout and inserts
  // the confirm link, so the fields can never break double opt-in. The rendered card
  // is byte-honest to the transactional layout in src/emails/system.ts, in both themes
  // (the card's dark palette lives in styles.css, tracking the dashboard theme).
  const confirmationSection = html`
    <section class="set-sec">
      ${secHead("Confirmation email", chip("editable", "Editable"))}
      <p class="set-lede">The email that asks a new subscriber to confirm. Edit the wording as you see fit. Kestrel adds the confirmation link.</p>
      <div class="set-preview">
        <div class="set-preview-bar set-ce-bar">
          <div class="set-ce-modetog" role="group" aria-label="Confirmation email view">
            <button type="button" class="set-ce-modebtn" id="ceTabPreview" aria-pressed="true">${icon("preview")}Preview</button>
            <button type="button" class="set-ce-modebtn" id="ceTabEdit" aria-pressed="false">${icon("editable")}Edit</button>
          </div>
        </div>
        <div id="cePreviewBody">
          <div class="set-inbox">
            <div class="set-inbox-avatar" id="cePvAvatar">${monogram(state.name)}</div>
            <div class="set-inbox-body">
              <div class="set-inbox-top"><span class="set-inbox-from" id="cePvFrom">${state.name || fromName}</span><span class="set-inbox-time">now</span></div>
              <div class="set-inbox-subj" id="cePvSubject"></div>
            </div>
          </div>
          <div class="set-ce-stage">
            <div class="set-ce-card">
              <div class="set-ce-mast" id="cePvMast" hidden>
                <div class="set-ce-mast-logo" id="cePvMastLogo"></div>
                <div>
                  <div class="set-ce-mast-name" id="cePvMastName"></div>
                  <div class="set-ce-mast-tag" id="cePvMastTag"></div>
                </div>
              </div>
              <p class="set-ce-msg" id="cePvBody"></p>
              <p class="set-ce-btnrow"><a class="set-ce-btn" id="cePvButton" href="#" onclick="return false"></a></p>
              <p class="set-ce-foot" id="cePvFoot"></p>
            </div>
          </div>
        </div>
        <div id="ceEditBody" hidden>
          <div class="set-ce-edit">
            <div class="set-field">
              <label for="ceSubject">Subject line</label>
              <input id="ceSubject" value="${state.confirmation.subject}" maxlength="200" autocomplete="off">
            </div>
            <div class="set-field">
              <label for="ceMessage">Message</label>
              <textarea id="ceMessage" rows="3" maxlength="1000">${state.confirmation.body}</textarea>
              <p class="field-hint">The line above the confirm button. Keep it short — this is a one-click step, not a letter.</p>
            </div>
            <div class="set-field">
              <label for="ceButton">Button label</label>
              <input id="ceButton" value="${state.confirmation.buttonLabel}" maxlength="80" autocomplete="off">
              <p class="field-hint set-ce-lock">${icon("readonly")}<span>Kestrel fills in the confirmation link — you set the words, never the URL.</span></p>
            </div>
            <div class="set-field">
              <label for="ceFooter">Reassurance line</label>
              <input id="ceFooter" value="${state.confirmation.reassurance}" maxlength="400" autocomplete="off">
              <p class="field-hint">The quiet footer for anyone who didn’t sign up. Leave blank to omit it.</p>
            </div>
          </div>
          <div class="set-ce-editfoot">
            <button type="button" class="ghost" id="ceReset">Reset to Kestrel default</button>
            <span class="grow"></span>
            <button type="button" class="ghost" id="ceToPreview">See preview →</button>
          </div>
        </div>
      </div>
    </section>`;

  const archiveBase = `${d.archiveOrigin || ""}${d.archiveBasePath || ""}`;
  const archiveIsDefault = d.archiveOrigin === d.appOrigin;
  const instanceSection = html`
    <section class="set-sec">
      ${secHead("Instance", chip("readonly", "Read-only · set at deploy"))}
      <div class="set-card sunken">
        <div class="set-ro-note">${icon("info")}<span>Deploy-time infrastructure, shown for reference. These live in your Worker config and never pass through the API. See the <a class="set-link" href="#/docs">setup guide</a> to change them.</span></div>
        <div class="set-kv">
          <div class="set-kv-k">App origin</div><div class="set-kv-v"><span class="mono">${d.appOrigin}</span></div>
          <div class="set-kv-k">Archive URL base</div><div class="set-kv-v"><span class="mono">${archiveBase}</span>${archiveIsDefault ? html`<span class="set-pill">default: app origin</span>` : null}</div>
          <div class="set-kv-k">Image URL base</div><div class="set-kv-v"><span class="mono">${d.mediaPublicBase}</span></div>
          <div class="set-kv-k">Auth mode</div><div class="set-kv-v">${d.authMode === "access" ? "Cloudflare Access" : "Local dev token"}</div>
          <div class="set-kv-k">Cloudflare Access</div><div class="set-kv-v">${d.accessConfigured ? html`<span class="set-pill ok">${icon("check")}Configured</span>` : html`<span class="set-pill">Not configured</span>`}</div>
        </div>
      </div>
    </section>`;

  setHtml(
    body,
    html`${identitySection}${templateSection}${senderSection}${notifySection}${recipSection}${subscribeSection}${confirmationSection}${instanceSection}`,
  );

  // Keep the cached config + sidebar brand in step after a save (the sidebar brand
  // reads the same publication identity): this page's own response, with the saved half.
  const applySettings = (settings: SettingsView) => {
    appState.appConfig = { ...data, settings };
    renderSidebarBrand();
  };

  const nameEl = $<HTMLInputElement>("#setName");
  const taglineEl = $<HTMLInputElement>("#setTagline");
  // The shared bottom save bar (Save + Discard). Its callbacks are the hoisted
  // saveSettings / discardSettings below; refreshDirty just slides it up or down.
  const bar = savebar.attach({ onSave: saveSettings, onDiscard: discardSettings }, signal);

  // --- dirty tracking: the persisted identity fields (name, tagline, address) +
  // recipients. The email template is edited on its own page, so it isn't tracked here.
  const sameList = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);
  const sameCopy = (a: ConfirmationEmailCopy, b: ConfirmationEmailCopy) =>
    a.subject === b.subject &&
    a.body === b.body &&
    a.buttonLabel === b.buttonLabel &&
    a.reassurance === b.reassurance;
  const isDirty = () =>
    state.name !== baseline.name ||
    state.tagline !== baseline.tagline ||
    state.address !== baseline.address ||
    !sameList(state.recipients, baseline.recipients) ||
    !sameCopy(state.confirmation, baseline.confirmation) ||
    state.notifyTo !== baseline.notifyTo;
  // Looked up before refreshDirty, which reaches them through refreshNotifyTest.
  const notifyToEl = $<HTMLInputElement>("#notifyTo");
  const notifyTest = $<HTMLButtonElement>("#notifyTest");
  const notifyTestHint = $("#notifyTestHint");
  const notifyStatus = $("#notifyStatus");
  const refreshDirty = () => {
    bar.setDirty(isDirty());
    refreshNotifyTest();
  };

  // --- email template: a read-only compact preview of the current template plus a
  // link to the Template page, where editing lives (so each surface has one save).
  // The identity fields repaint it live (see onIdentityInput).
  const templatePreview = mountSampleEmailPreview(
    $<HTMLIFrameElement>("#tplPreview"),
    () => state.template,
    () => ({
      name: state.name || fromName,
      tagline: state.tagline,
      logoUrl: state.logoUrl,
      address: state.address,
    }),
  );
  $("#tplEditLink").onclick = () => {
    location.hash = "#/template";
  };

  // --- logo: immediate upload / remove (their own endpoints), updated in place so a
  // logo change doesn't wipe an in-progress template edit.
  const logoInput = $<HTMLInputElement>("#logoInput");
  const logoTile = $("#logoTile");
  const logoPh = $("#logoPh");
  const logoReplace = $<HTMLButtonElement>("#logoReplace");
  const logoRemove = $<HTMLButtonElement>("#logoRemove");
  const applyLogoUi = () => {
    const has = !!state.logoUrl;
    logoTile.classList.toggle("has-img", has);
    logoTile.style.backgroundImage = has ? `url('${state.logoUrl}')` : "";
    logoPh.hidden = has;
    logoRemove.hidden = !has;
    logoReplace.textContent = has ? "Replace" : "Upload";
    // Both previews that render the logo, so an upload or a removal reaches the
    // confirmation email's masthead at once rather than on the next identity edit.
    templatePreview.repaint();
    repaintConfirmation();
  };
  logoReplace.onclick = () => logoInput.click();
  logoTile.addEventListener("click", () => logoInput.click());
  logoTile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      logoInput.click();
    }
  });
  // A refused logo change (a scheduled send about to fire) is said beneath the tile,
  // field validation's home (DESIGN §2, ④): the logo has no save bar state of its own.
  const logoError = $("#logoError");
  const logoErrorText = $("span:last-of-type", logoError);
  const showLogoError = (msg: string) => {
    logoErrorText.textContent = msg;
    logoError.hidden = !msg;
  };
  logoInput.onchange = async () => {
    const file = logoInput.files?.[0];
    logoInput.value = "";
    if (!file) {
      return;
    }
    if (file.size > 512 * 1024) {
      toast("That image is over 512 KB — pick a smaller one.");
      return;
    }
    showLogoError("");
    try {
      // The logo is part of the identity, so an upload that reaches scheduled emails
      // asks first (withRemakeConfirm); the file is held and re-sent with the ids.
      const r = await withRemakeConfirm(
        (ack) => {
          const fd = new FormData();
          fd.append("file", file);
          const q = ack ? `?remake=${encodeURIComponent(ack.join(","))}` : "";
          return api<LogoResponse>(`/api/settings/logo${q}`, { method: "POST", body: fd });
        },
        remakeIdentity("Upload", "Uploading"),
      );
      if (!r) {
        return; // declined: the logo stays as it was
      }
      state.logoUrl = r.settings.publication.logoUrl || "";
      applySettings(r.settings);
      applyLogoUi();
      toast(savedToast("Logo updated", r.remade));
    } catch (err) {
      if (isRemakeTooClose(err)) {
        showLogoError(message(err));
      } else {
        toast(message(err));
      }
    }
  };
  logoRemove.onclick = () =>
    busy(logoRemove, "Removing…", async () => {
      showLogoError("");
      try {
        const r = await withRemakeConfirm(
          (ack) => {
            const q = ack ? `?remake=${encodeURIComponent(ack.join(","))}` : "";
            return api<LogoResponse>(`/api/settings/logo${q}`, { method: "DELETE" });
          },
          remakeIdentity("Remove", "Removing"),
        );
        if (!r) {
          return;
        }
        state.logoUrl = r.settings.publication.logoUrl || "";
        applySettings(r.settings);
        applyLogoUi();
        toast(savedToast("Logo removed", r.remade));
      } catch (err) {
        if (isRemakeTooClose(err)) {
          showLogoError(message(err));
        } else {
          toast(message(err));
        }
      }
    });

  // --- embed snippet: a Plain/Styled toggle drives the code, the hint, the rendered
  // preview, and the Copy payload. The name tracks the live identity field.
  const embedCodeEl = $("#embedCode");
  const embedHintEl = $("#embedHint");
  const embedPreviewEl = $("#embedPreview");
  const EMBED_HINTS: Record<EmbedMode, string> = {
    styled: "Self-contained — inline styles, ready to paste anywhere.",
    plain: "Minimal markup, no styles — style it to match your site.",
  };
  let embedMode: EmbedMode = "plain";
  const renderEmbedPreview = (mode: EmbedMode, name: string): Html => {
    if (mode === "styled") {
      return html`<form class="set-pf-styled"><span class="l">Subscribe to ${name}</span><div class="rowf"><input type="email" placeholder="you@example.com" disabled><button type="button" class="sub-btn" tabindex="-1">Subscribe</button></div><p class="set-pf-fine">Double opt-in — we’ll email a confirmation link.</p></form>`;
    }
    return html`<form class="set-pf-plain"><label>Subscribe to ${name}</label><input type="email" placeholder="you@example.com" disabled><button type="button" tabindex="-1">Subscribe</button></form>`;
  };
  const rebuildEmbed = () => {
    const name = state.name || fromName;
    embedCodeEl.textContent = buildEmbed(embedMode, name);
    embedHintEl.textContent = EMBED_HINTS[embedMode];
    setHtml(embedPreviewEl, renderEmbedPreview(embedMode, name));
  };
  const setEmbed = (mode: string) => {
    embedMode = mode === "styled" ? "styled" : "plain";
    for (const b of $$("[data-embed]", body)) {
      b.classList.toggle("active", b.dataset.embed === embedMode);
    }
    rebuildEmbed();
  };
  for (const b of $$("[data-embed]", body)) {
    b.onclick = () => setEmbed(b.dataset.embed ?? "");
  }
  $("#embedCopy").onclick = () => copyText(buildEmbed(embedMode, state.name || fromName));

  // --- live identity fields: repaint everything that shows the name/tagline/address.
  const addressEl = $<HTMLInputElement>("#setAddress");
  const onIdentityInput = () => {
    state.name = nameEl.value.trim();
    state.tagline = taglineEl.value.trim();
    state.address = addressEl.value.trim();
    templatePreview.repaint();
    rebuildEmbed();
    repaintConfirmation(); // the confirmation preview shows the From name + monogram
    refreshDirty();
  };
  nameEl.addEventListener("input", onIdentityInput);
  taglineEl.addEventListener("input", onIdentityInput);
  addressEl.addEventListener("input", onIdentityInput);

  // --- test recipients: removable chips + an add row.
  const recipChips = $("#recipChips");
  const recipInput = $<HTMLInputElement>("#recipInput");
  const renderRecipChips = () => {
    if (!state.recipients.length) {
      setHtml(
        recipChips,
        html`<span class="set-recip-empty">No default recipients yet — add one below.</span>`,
      );
      return;
    }
    setHtml(
      recipChips,
      html`${state.recipients.map(
        (addr, i) =>
          html`<span class="set-recip-chip">${addr}<button type="button" data-rm="${i}" aria-label="Remove ${addr}">${icon("x")}</button></span>`,
      )}`,
    );
  };
  recipChips.addEventListener("click", (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-rm]") : null;
    if (!b) {
      return;
    }
    state.recipients.splice(Number(b.dataset.rm), 1);
    renderRecipChips();
    refreshDirty();
  });
  const addRecip = () => {
    const v = normalizeEmail(recipInput.value);
    if (!v) {
      return;
    }
    if (!isValidEmail(v)) {
      toast("That doesn’t look like an email address.");
      return;
    }
    if (state.recipients.includes(v)) {
      toast("That inbox is already in the list.");
      recipInput.value = "";
      return;
    }
    state.recipients.push(v);
    recipInput.value = "";
    renderRecipChips();
    refreshDirty();
  };
  $("#recipAdd").onclick = addRecip;
  recipInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addRecip();
    }
  });

  // --- notifications: the address rides the save bar; the test goes to the SAVED address
  // only (the server never takes one from the request), so it waits for a save. Its
  // outcome is the channel's latest word, so the status line takes it in place.
  notifyToEl.addEventListener("input", () => {
    state.notifyTo = notifyToEl.value.trim().toLowerCase();
    refreshDirty();
  });
  function refreshNotifyTest() {
    const reason = !baseline.notifyTo
      ? "Save an address to send a test."
      : state.notifyTo !== baseline.notifyTo
        ? "Save first: the test goes to the saved address."
        : "";
    notifyTest.disabled = Boolean(reason);
    notifyTestHint.textContent = reason;
  }
  notifyTest.onclick = () =>
    busy(notifyTest, "Sending…", async () => {
      try {
        const r = await api<NotificationTestResponse>("/api/settings/notifications/test", {
          method: "POST",
        });
        toast(
          r.channel === "fake"
            ? `Test notification recorded for ${r.to} (no email provider configured — nothing is delivered)`
            : `Test notification sent to ${r.to}`,
        );
        setHtml(
          notifyStatus,
          notificationStatusHtml({
            lastSent: { kind: "test", subject: "", at: Date.now() },
            lastFailure: null,
          }),
        );
      } catch (err) {
        toast(message(err));
        setHtml(
          notifyStatus,
          notificationStatusHtml({
            lastSent: null,
            lastFailure: { kind: "test", subject: "", at: Date.now(), error: message(err) },
          }),
        );
      }
    });

  // --- copy buttons (subscribe URL).
  for (const b of $$("[data-copy]", body)) {
    b.onclick = () => copyText(b.dataset.copy ?? "");
  }

  // --- confirmation email: Preview | Edit toggle + live preview. The fields carry
  // only words; the preview resolves a blank required field to the built-in default
  // (ceDefault, from the API) exactly as the send does, so it's never wordless.
  const ceEls = {
    subject: $<HTMLInputElement>("#ceSubject"),
    message: $<HTMLTextAreaElement>("#ceMessage"),
    button: $<HTMLInputElement>("#ceButton"),
    footer: $<HTMLInputElement>("#ceFooter"),
  };
  const cePv = {
    avatar: $("#cePvAvatar"),
    from: $("#cePvFrom"),
    subject: $("#cePvSubject"),
    body: $("#cePvBody"),
    button: $("#cePvButton"),
    foot: $("#cePvFoot"),
    mast: $("#cePvMast"),
    mastLogo: $("#cePvMastLogo"),
    mastName: $("#cePvMastName"),
    mastTag: $("#cePvMastTag"),
  };
  const repaintConfirmation = () => {
    const c = state.confirmation;
    const subject = c.subject.trim() || ceDefault.subject || "";
    const bodyText = c.body.trim() || ceDefault.body || "";
    const button = c.buttonLabel.trim() || ceDefault.buttonLabel || "Confirm";
    const name = state.name || fromName;
    cePv.avatar.textContent = monogram(state.name);
    cePv.from.textContent = name;
    cePv.subject.textContent = subject;
    cePv.body.textContent = bodyText;
    cePv.button.textContent = button;
    cePv.foot.textContent = c.reassurance;
    cePv.foot.hidden = !c.reassurance.trim();
    // The publication masthead (logo + name + tagline) up top. Mirrors masthead() in
    // src/emails/system.ts exactly: it uses the identity as the email resolves it (name
    // = publication name or the From display name, "" if neither), omits the logo cell
    // when there's no logo (rather than showing a monogram the email won't have), and
    // degrades to nothing when there's neither a name nor a logo.
    const mastName = state.name || fromDisplay;
    const hasLogo = Boolean(state.logoUrl);
    const showMast = hasLogo || Boolean(mastName);
    cePv.mast.hidden = !showMast;
    if (showMast) {
      cePv.mastLogo.hidden = !hasLogo;
      if (hasLogo) {
        setHtml(cePv.mastLogo, html`<img src="${state.logoUrl}" alt="">`);
      }
      cePv.mastName.textContent = mastName;
      cePv.mastName.hidden = !mastName;
      cePv.mastTag.textContent = state.tagline;
      cePv.mastTag.hidden = !state.tagline;
    }
  };
  const onConfirmationInput = () => {
    state.confirmation.subject = ceEls.subject.value;
    state.confirmation.body = ceEls.message.value;
    state.confirmation.buttonLabel = ceEls.button.value;
    state.confirmation.reassurance = ceEls.footer.value;
    repaintConfirmation();
    refreshDirty();
  };
  for (const el of Object.values(ceEls)) {
    el.addEventListener("input", onConfirmationInput);
  }
  const ceEditBody = $("#ceEditBody");
  const cePreviewBody = $("#cePreviewBody");
  const ceTabEdit = $<HTMLButtonElement>("#ceTabEdit");
  const ceTabPreview = $<HTMLButtonElement>("#ceTabPreview");
  const ceSetMode = (edit: boolean) => {
    ceEditBody.hidden = !edit;
    cePreviewBody.hidden = edit;
    ceTabEdit.setAttribute("aria-pressed", String(edit));
    ceTabPreview.setAttribute("aria-pressed", String(!edit));
    if (edit) {
      ceEls.subject.focus();
    }
  };
  ceTabPreview.onclick = () => ceSetMode(false);
  ceTabEdit.onclick = () => ceSetMode(true);
  $("#ceToPreview").onclick = () => ceSetMode(false);
  $("#ceReset").onclick = () => {
    ceEls.subject.value = ceDefault.subject || "";
    ceEls.message.value = ceDefault.body || "";
    ceEls.button.value = ceDefault.buttonLabel || "";
    ceEls.footer.value = ceDefault.reassurance || "";
    onConfirmationInput();
  };
  // Keep the fields + preview in step with a save-adopted or discarded baseline.
  const applyConfirmationFields = () => {
    ceEls.subject.value = state.confirmation.subject;
    ceEls.message.value = state.confirmation.body;
    ceEls.button.value = state.confirmation.buttonLabel;
    ceEls.footer.value = state.confirmation.reassurance;
    repaintConfirmation();
  };

  // --- save / discard. Wired into the shared save bar above; the controller runs
  // saveSettings inside busy() on its Save button, so these stay plain callbacks.
  async function saveSettings() {
    try {
      // An identity change the template renders reaches every scheduled email, so the
      // server may ask for the acknowledgement first (withRemakeConfirm); a save that
      // touches only recipients or the confirmation wording never does.
      const payload: SettingsPatchBody = {
        publication: { name: state.name, tagline: state.tagline, address: state.address },
        testRecipients: state.recipients,
        confirmationEmail: state.confirmation,
        notifications: { to: state.notifyTo },
      };
      const r = await withRemakeConfirm(
        (ack) =>
          api<SettingsSavedResponse>("/api/settings", {
            method: "PUT",
            json: ack ? { ...payload, remake: ack } : payload,
          }),
        remakeIdentity("Save", "Saving"),
      );
      if (!r) {
        return; // declined: the edits stay, the bar stays up
      }
      // Adopt the server's normalized result (trim, lowercase, dedupe) as baseline.
      const ns = r.settings;
      state.name = ns.publication.name;
      state.tagline = ns.publication.tagline;
      state.address = ns.publication.address;
      state.recipients = [...ns.testRecipients];
      state.confirmation = { ...ns.confirmationEmail };
      state.notifyTo = ns.notifications.to;
      notifyToEl.value = state.notifyTo;
      nameEl.value = state.name;
      taglineEl.value = state.tagline;
      addressEl.value = state.address;
      applyConfirmationFields();
      baseline = {
        name: state.name,
        tagline: state.tagline,
        address: state.address,
        recipients: [...state.recipients],
        confirmation: { ...state.confirmation },
        notifyTo: state.notifyTo,
      };
      applySettings(ns);
      renderRecipChips();
      rebuildEmbed();
      templatePreview.repaint();
      refreshDirty(); // clean now — slides the bar away
      toast(savedToast("Settings saved", r.remade));
    } catch (err) {
      // A failed save leaves the edits in place (still dirty → bar stays up). A send
      // about to fire is the bar's blocking error, naming when to try again (DESIGN §5).
      if (isRemakeTooClose(err)) {
        bar.showError(message(err));
      } else {
        toast(message(err));
      }
    }
  }
  function discardSettings() {
    state.name = baseline.name;
    state.tagline = baseline.tagline;
    state.address = baseline.address;
    state.recipients = [...baseline.recipients];
    state.confirmation = { ...baseline.confirmation };
    state.notifyTo = baseline.notifyTo;
    notifyToEl.value = state.notifyTo;
    nameEl.value = state.name;
    taglineEl.value = state.tagline;
    addressEl.value = state.address;
    applyConfirmationFields();
    renderRecipChips();
    rebuildEmbed();
    templatePreview.repaint();
    refreshDirty();
  }

  // --- initial paint.
  applyLogoUi();
  renderRecipChips();
  setEmbed("plain");
  templatePreview.repaint();
  repaintConfirmation();
  refreshDirty();
}

/** How the deploy-time notification channel reads to the publisher. */
function notifyChannelLabel(
  channel: SettingsResponse["deployment"]["notifyChannel"],
  provider: string,
): string {
  switch (channel) {
    case "cloudflare":
      return "Cloudflare Email, separate from your newsletter's provider";
    case "provider":
      return `Your email provider (${provider})`;
    default:
      return "No email provider configured — nothing is delivered";
  }
}

const NOTIFICATION_KINDS: Record<NotificationStatusKind, string> = {
  finished: "went out",
  refused: "provider refusing",
  stuck: "in flight too long",
  wedged: "waiting to be resolved",
  missed: "missed fire time",
  test: "test",
};

/** What a status line is about: the send and what happened, or just "test notification". */
function aboutNotification(n: { kind: NotificationStatusKind; subject: string }): string {
  return n.kind === "test" ? "test notification" : `${n.subject} (${NOTIFICATION_KINDS[n.kind]})`;
}

/** The last delivered notification, and a newer failure when the channel has stopped working. */
function notificationStatusHtml(status: SettingsResponse["notificationStatus"]): Html {
  const { lastSent, lastFailure } = status;
  if (lastFailure) {
    return html`<span class="set-pill danger">Not delivered</span> <span class="muted">${fmt(lastFailure.at)}, ${aboutNotification(lastFailure)}: ${lastFailure.error}</span>`;
  }
  if (lastSent) {
    return html`<span class="set-pill ok">${icon("check")}Delivered</span> <span class="muted">${fmt(lastSent.at)}, ${aboutNotification(lastSent)}</span>`;
  }
  return html`<span class="muted">None yet</span>`;
}
