// @ts-nocheck
// The Settings page: publication identity, sending, confirmation wording, test
// recipients, and the deployment reflection.

import { api } from "../api";
import { parseFromName, renderSidebarBrand } from "../brand";
import { copyText } from "../build_ref";
import { esc, toast } from "../helpers";
import { icon } from "../icons";
import { busy, renderError } from "../notice";
import { inUseChip, remakeIdentity, savedToast, withRemakeConfirm } from "../remake";
import { savebar } from "../savebar";
import { app } from "../shell";
import { appState } from "../state";
import { mountSampleEmailPreview } from "./template";

// Runtime preferences (editable) + a read-only reflection of the deploy-time
// config. Secrets never come down this wire (see routes/settings.ts).
const PROVIDER_LABELS = { fake: "Fake (dev, dead-end)", ses: "Amazon SES", resend: "Resend" };

export async function renderSettings() {
  app.innerHTML = `<div class="settings"><div class="page-head"><h1>Settings</h1><p class="set-lede set-page-lede">Your publication's identity, the email each post is sent inside, how mail is sent, and the ways readers subscribe. Facts set when Kestrel was deployed are shown read-only.</p></div><div id="settingsBody" class="muted">Loading…</div></div>`;
  const body = document.getElementById("settingsBody");
  let data;
  try {
    data = await api("/api/settings");
  } catch (e) {
    renderError(body, e.message, renderSettings);
    return;
  }
  const s = data.settings;
  const d = data.deployment;
  const p = s.publication || { name: "", tagline: "", logoUrl: "" };
  // The From display name as the email actually resolves it ("" for a bare address —
  // see resolveBranding); fromName adds a visible placeholder for the inbox-row From.
  const fromDisplay = parseFromName(d.fromAddress) || "";
  const fromName = fromDisplay || "Your publication";

  // Live, in-memory state. The save bar tracks the PERSISTED identity fields (name,
  // tagline, address) + test recipients against the saved baseline. The logo is
  // immediate (its own endpoints); the email template has its own Save (it validates
  // and can warn), so it doesn't feed the bar.
  const ce = s.confirmationEmail || {};
  const ceDefault = s.confirmationEmailDefault || {};
  const state = {
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
  };
  let baseline = {
    name: state.name,
    tagline: state.tagline,
    address: state.address,
    recipients: [...state.recipients],
    confirmation: { ...state.confirmation },
  };

  const monogram = (v) => (String(v || fromName).trim()[0] || "K").toUpperCase();
  const bareAddress = (from) => {
    const m = String(from || "").match(/<([^>]+)>/);
    return m ? m[1] : String(from || "");
  };

  // Subscribe URL + embeds: paste into your own site; both post to the public
  // /subscribe and start the double opt-in — never an auto-confirm (I1).
  const appOrigin = d.appOrigin || location.origin;
  const subscribeUrl = `${appOrigin}/subscribe`;
  const embedAction = `${esc(appOrigin)}/subscribe`;
  const buildEmbed = (mode, nameRaw) => {
    const name = esc(nameRaw || fromName);
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

  const chip = (kind, label) => `<span class="set-chip ${kind}">${icon(kind)}${label}</span>`;
  const secHead = (title, chipHtml, extra = "") =>
    `<div class="set-sec-head"><h2 class="set-sec-title">${title}</h2>${chipHtml}${extra}<span class="set-rule"></span></div>`;

  // Which identity fields the template renders (SPEC §9): the note under the card says
  // which reach the email, and the chip says whether scheduled posts are using them.
  const inUse = data.inUse || { sends: [], retry_after: null, identityFields: [] };
  const identityNote = (() => {
    const names = { name: "name", tagline: "tagline", address: "mailing address", logoUrl: "logo" };
    const all = ["name", "tagline", "address", "logoUrl"];
    const used = all.filter((f) => (inUse.identityFields || []).includes(f));
    const unused = all.filter((f) => !used.includes(f));
    const list = (fs) =>
      fs.length === 1
        ? names[fs[0]]
        : `${fs
            .slice(0, -1)
            .map((f) => names[f])
            .join(", ")}, and ${names[fs[fs.length - 1]]}`;
    if (!used.length) {
      return "The email template doesn’t use your name, tagline, address, or logo, so a change here reaches no scheduled email.";
    }
    const first = unused.length
      ? `Your ${list(used)} ride inside every email; the template doesn’t use your ${list(unused)}.`
      : "Your name, tagline, address, and logo ride inside every email.";
    return `${first} Saving a change to those while posts are scheduled applies it to their emails too, after you confirm: the same result as canceling each, saving, and scheduling it again, without the steps. Sent emails never change.`;
  })();

  const identitySection = `
    <section class="set-sec">
      ${secHead("Publication identity", chip("editable", "Editable"), inUseChip(inUse, true))}
      <div class="set-card">
        <div class="set-id-grid">
          <div class="set-logo-slot">
            <div class="set-logo-tile${state.logoUrl ? " has-img" : ""}" id="logoTile" role="button" tabindex="0" aria-label="Upload logo"${state.logoUrl ? ` style="background-image:url('${esc(state.logoUrl)}')"` : ""}>
              <span class="set-logo-ph" id="logoPh"${state.logoUrl ? " hidden" : ""}>${icon("upload")}Upload</span>
            </div>
            <input type="file" id="logoInput" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>
            <div class="set-logo-actions">
              <button type="button" id="logoReplace">${state.logoUrl ? "Replace" : "Upload"}</button>
              <button type="button" class="danger-subtle" id="logoRemove"${state.logoUrl ? "" : " hidden"}>Remove</button>
            </div>
            <p class="field-hint">PNG, JPEG, WebP, GIF, or SVG, up to 512&nbsp;KB. Saves immediately.</p>
            <div class="field-error" id="logoError" role="alert" hidden><span class="field-error-ico" aria-hidden="true">!</span><span></span></div>
          </div>
          <div class="set-id-fields">
            <div class="set-field">
              <label for="setName">Name</label>
              <input id="setName" value="${esc(state.name)}" placeholder="${esc(fromName)}" maxlength="120" autocomplete="off">
              <p class="field-hint">Blank falls back to the email “From” name (“${esc(fromName)}”).</p>
            </div>
            <div class="set-field">
              <label for="setTagline">Tagline</label>
              <input id="setTagline" value="${esc(state.tagline)}" placeholder="A one-line description" maxlength="200" autocomplete="off">
              <p class="field-hint">A short line under the name on your public pages.</p>
            </div>
            <div class="set-field">
              <label for="setAddress">Mailing address</label>
              <input id="setAddress" value="${esc(state.address)}" placeholder="123 Main St, City, ST 00000" maxlength="300" autocomplete="off">
              <p class="field-hint">A physical postal address for the email footer. Bulk or commercial mail usually requires one.</p>
            </div>
          </div>
        </div>
        <div class="set-note">${icon("info")}<span>${esc(identityNote)}</span></div>
      </div>
    </section>`;

  const templateSection = `
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

  const senderSection = `
    <section class="set-sec">
      ${secHead("Email sender", chip("readonly", "Read-only · set at deploy"))}
      <div class="set-card sunken">
        <div class="set-ro-note">${icon("readonly")}<span>The sender is fixed at deploy via environment secrets, so it can’t be edited here. Change it in the <a class="set-link" href="#/docs">setup guide</a>, then redeploy. Credentials are never shown.</span></div>
        <div class="set-preview-bar" style="background:transparent">
          <span class="set-preview-lbl">Inbox preview</span>
          <span class="set-preview-dot">How readers see the sender</span>
        </div>
        <div class="set-inbox">
          <div class="set-inbox-avatar">${esc(monogram(fromName))}</div>
          <div class="set-inbox-body">
            <div class="set-inbox-top"><span class="set-inbox-from">${esc(fromName)}</span><span class="set-inbox-time">9:02 AM</span></div>
            <div class="set-inbox-subj">Your latest post — a sample subject line</div>
            <div class="set-inbox-snip">The opening lines of your post show here as the inbox preview…</div>
            <div class="set-inbox-addr">${esc(bareAddress(d.fromAddress))}</div>
          </div>
        </div>
        <div class="set-kv" style="border-top:1px solid var(--line)">
          <div class="set-kv-k">From address</div><div class="set-kv-v"><span class="mono">${esc(d.fromAddress)}</span></div>
          <div class="set-kv-k">Sending domain</div><div class="set-kv-v"><span class="mono">${esc(d.sendingDomain)}</span></div>
          <div class="set-kv-k">Email provider</div><div class="set-kv-v">${esc(PROVIDER_LABELS[d.provider] || d.provider)}</div>
        </div>
      </div>
    </section>`;

  const recipSection = `
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

  const subscribeSection = `
    <section class="set-sec">
      ${secHead("Ways to subscribe", chip("copyout", "Copy-out"))}
      <div class="set-card set-card-pad">
        <div class="set-field">
          <label>Public subscribe page</label>
          <div class="pub-row">
            <code class="pub-val">${esc(subscribeUrl)}</code>
            <button class="ghost" data-copy="${esc(subscribeUrl)}">Copy</button>
            <a class="ghost-link" href="${esc(subscribeUrl)}" target="_blank" rel="noopener">Open&nbsp;↗</a>
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
  const confirmationSection = `
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
            <div class="set-inbox-avatar" id="cePvAvatar">${esc(monogram(state.name))}</div>
            <div class="set-inbox-body">
              <div class="set-inbox-top"><span class="set-inbox-from" id="cePvFrom">${esc(state.name || fromName)}</span><span class="set-inbox-time">now</span></div>
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
              <input id="ceSubject" value="${esc(state.confirmation.subject)}" maxlength="200" autocomplete="off">
            </div>
            <div class="set-field">
              <label for="ceMessage">Message</label>
              <textarea id="ceMessage" rows="3" maxlength="1000">${esc(state.confirmation.body)}</textarea>
              <p class="field-hint">The line above the confirm button. Keep it short — this is a one-click step, not a letter.</p>
            </div>
            <div class="set-field">
              <label for="ceButton">Button label</label>
              <input id="ceButton" value="${esc(state.confirmation.buttonLabel)}" maxlength="80" autocomplete="off">
              <p class="field-hint set-ce-lock">${icon("readonly")}<span>Kestrel fills in the confirmation link — you set the words, never the URL.</span></p>
            </div>
            <div class="set-field">
              <label for="ceFooter">Reassurance line</label>
              <input id="ceFooter" value="${esc(state.confirmation.reassurance)}" maxlength="400" autocomplete="off">
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
  const instanceSection = `
    <section class="set-sec">
      ${secHead("Instance", chip("readonly", "Read-only · set at deploy"))}
      <div class="set-card sunken">
        <div class="set-ro-note">${icon("info")}<span>Deploy-time infrastructure, shown for reference. These live in your Worker config and never pass through the API. See the <a class="set-link" href="#/docs">setup guide</a> to change them.</span></div>
        <div class="set-kv">
          <div class="set-kv-k">App origin</div><div class="set-kv-v"><span class="mono">${esc(d.appOrigin)}</span></div>
          <div class="set-kv-k">Archive URL base</div><div class="set-kv-v"><span class="mono">${esc(archiveBase)}</span>${archiveIsDefault ? '<span class="set-pill">default: app origin</span>' : ""}</div>
          <div class="set-kv-k">Image URL base</div><div class="set-kv-v"><span class="mono">${esc(d.mediaPublicBase)}</span></div>
          <div class="set-kv-k">Auth mode</div><div class="set-kv-v">${d.authMode === "access" ? "Cloudflare Access" : "Local dev token"}</div>
          <div class="set-kv-k">Cloudflare Access</div><div class="set-kv-v">${d.accessConfigured ? `<span class="set-pill ok">${icon("check")}Configured</span>` : '<span class="set-pill">Not configured</span>'}</div>
        </div>
      </div>
    </section>`;

  body.innerHTML =
    identitySection +
    templateSection +
    senderSection +
    recipSection +
    subscribeSection +
    confirmationSection +
    instanceSection;

  // Keep the cached config + sidebar brand in step after a save (the sidebar brand
  // reads the same publication identity).
  const applySettings = (settings) => {
    appState.appConfig = { ...(appState.appConfig || {}), settings };
    renderSidebarBrand();
  };

  const nameEl = document.getElementById("setName");
  const taglineEl = document.getElementById("setTagline");
  // The shared bottom save bar (Save + Discard). Its callbacks are the hoisted
  // saveSettings / discardSettings below; refreshDirty just slides it up or down.
  const bar = savebar.attach({ onSave: saveSettings, onDiscard: discardSettings });

  // --- dirty tracking: the persisted identity fields (name, tagline, address) +
  // recipients. The email template is edited on its own page, so it isn't tracked here.
  const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const sameCopy = (a, b) =>
    a.subject === b.subject &&
    a.body === b.body &&
    a.buttonLabel === b.buttonLabel &&
    a.reassurance === b.reassurance;
  const isDirty = () =>
    state.name !== baseline.name ||
    state.tagline !== baseline.tagline ||
    state.address !== baseline.address ||
    !sameList(state.recipients, baseline.recipients) ||
    !sameCopy(state.confirmation, baseline.confirmation);
  const refreshDirty = () => {
    bar.setDirty(isDirty());
  };

  // --- email template: a read-only compact preview of the current template plus a
  // link to the Template page, where editing lives (so each surface has one save).
  // The identity fields repaint it live (see onIdentityInput).
  const templatePreview = mountSampleEmailPreview(
    document.getElementById("tplPreview"),
    () => state.template,
    () => ({
      name: state.name || fromName,
      tagline: state.tagline,
      logoUrl: state.logoUrl,
      address: state.address,
    }),
  );
  document.getElementById("tplEditLink").onclick = () => {
    location.hash = "#/template";
  };

  // --- logo: immediate upload / remove (their own endpoints), updated in place so a
  // logo change doesn't wipe an in-progress template edit.
  const logoInput = document.getElementById("logoInput");
  const logoTile = document.getElementById("logoTile");
  const logoPh = document.getElementById("logoPh");
  const logoReplace = document.getElementById("logoReplace");
  const logoRemove = document.getElementById("logoRemove");
  const applyLogoUi = () => {
    const has = !!state.logoUrl;
    logoTile.classList.toggle("has-img", has);
    logoTile.style.backgroundImage = has ? `url('${state.logoUrl}')` : "";
    logoPh.hidden = has;
    logoRemove.hidden = !has;
    logoReplace.textContent = has ? "Replace" : "Upload";
    templatePreview.repaint();
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
  const logoError = document.getElementById("logoError");
  const showLogoError = (msg) => {
    logoError.lastElementChild.textContent = msg || "";
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
          return api(`/api/settings/logo${q}`, { method: "POST", body: fd });
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
      if (err.status === 409 && err.data?.error === "remake_too_close") {
        showLogoError(err.message);
      } else {
        toast(err.message);
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
            return api(`/api/settings/logo${q}`, { method: "DELETE" });
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
        if (err.status === 409 && err.data?.error === "remake_too_close") {
          showLogoError(err.message);
        } else {
          toast(err.message);
        }
      }
    });

  // --- embed snippet: a Plain/Styled toggle drives the code, the hint, the rendered
  // preview, and the Copy payload. The name tracks the live identity field.
  const embedCodeEl = document.getElementById("embedCode");
  const embedHintEl = document.getElementById("embedHint");
  const embedPreviewEl = document.getElementById("embedPreview");
  const EMBED_HINTS = {
    styled: "Self-contained — inline styles, ready to paste anywhere.",
    plain: "Minimal markup, no styles — style it to match your site.",
  };
  let embedMode = "plain";
  const renderEmbedPreview = (mode, name) => {
    if (mode === "styled") {
      return (
        `<form class="set-pf-styled">` +
        `<span class="l">Subscribe to ${esc(name)}</span>` +
        `<div class="rowf"><input type="email" placeholder="you@example.com" disabled><button type="button" class="sub-btn" tabindex="-1">Subscribe</button></div>` +
        `<p class="set-pf-fine">Double opt-in — we’ll email a confirmation link.</p>` +
        `</form>`
      );
    }
    return (
      `<form class="set-pf-plain">` +
      `<label>Subscribe to ${esc(name)}</label>` +
      `<input type="email" placeholder="you@example.com" disabled>` +
      `<button type="button" tabindex="-1">Subscribe</button>` +
      `</form>`
    );
  };
  const rebuildEmbed = () => {
    const name = state.name || fromName;
    embedCodeEl.textContent = buildEmbed(embedMode, name);
    embedHintEl.textContent = EMBED_HINTS[embedMode];
    embedPreviewEl.innerHTML = renderEmbedPreview(embedMode, name);
  };
  const setEmbed = (mode) => {
    embedMode = mode === "styled" ? "styled" : "plain";
    for (const b of body.querySelectorAll("[data-embed]")) {
      b.classList.toggle("active", b.dataset.embed === embedMode);
    }
    rebuildEmbed();
  };
  for (const b of body.querySelectorAll("[data-embed]")) {
    b.onclick = () => setEmbed(b.dataset.embed);
  }
  document.getElementById("embedCopy").onclick = () =>
    copyText(buildEmbed(embedMode, state.name || fromName));

  // --- live identity fields: repaint everything that shows the name/tagline/address.
  const addressEl = document.getElementById("setAddress");
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
  const recipChips = document.getElementById("recipChips");
  const recipInput = document.getElementById("recipInput");
  const renderRecipChips = () => {
    if (!state.recipients.length) {
      recipChips.innerHTML =
        '<span class="set-recip-empty">No default recipients yet — add one below.</span>';
      return;
    }
    recipChips.innerHTML = state.recipients
      .map(
        (addr, i) =>
          `<span class="set-recip-chip">${esc(addr)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(addr)}">${icon("x")}</button></span>`,
      )
      .join("");
  };
  recipChips.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-rm]");
    if (!b) {
      return;
    }
    state.recipients.splice(Number(b.dataset.rm), 1);
    renderRecipChips();
    refreshDirty();
  });
  const addRecip = () => {
    const v = recipInput.value.trim().toLowerCase();
    if (!v) {
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
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
  document.getElementById("recipAdd").onclick = addRecip;
  recipInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addRecip();
    }
  });

  // --- copy buttons (subscribe URL).
  for (const b of body.querySelectorAll("[data-copy]")) {
    b.onclick = () => copyText(b.dataset.copy);
  }

  // --- confirmation email: Preview | Edit toggle + live preview. The fields carry
  // only words; the preview resolves a blank required field to the built-in default
  // (ceDefault, from the API) exactly as the send does, so it's never wordless.
  const ceEls = {
    subject: document.getElementById("ceSubject"),
    message: document.getElementById("ceMessage"),
    button: document.getElementById("ceButton"),
    footer: document.getElementById("ceFooter"),
  };
  const cePv = {
    avatar: document.getElementById("cePvAvatar"),
    from: document.getElementById("cePvFrom"),
    subject: document.getElementById("cePvSubject"),
    body: document.getElementById("cePvBody"),
    button: document.getElementById("cePvButton"),
    foot: document.getElementById("cePvFoot"),
    mast: document.getElementById("cePvMast"),
    mastLogo: document.getElementById("cePvMastLogo"),
    mastName: document.getElementById("cePvMastName"),
    mastTag: document.getElementById("cePvMastTag"),
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
        cePv.mastLogo.innerHTML = `<img src="${esc(state.logoUrl)}" alt="">`;
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
  const ceSetMode = (edit) => {
    document.getElementById("ceEditBody").hidden = !edit;
    document.getElementById("cePreviewBody").hidden = edit;
    document.getElementById("ceTabEdit").setAttribute("aria-pressed", String(edit));
    document.getElementById("ceTabPreview").setAttribute("aria-pressed", String(!edit));
    if (edit) {
      ceEls.subject.focus();
    }
  };
  document.getElementById("ceTabPreview").onclick = () => ceSetMode(false);
  document.getElementById("ceTabEdit").onclick = () => ceSetMode(true);
  document.getElementById("ceToPreview").onclick = () => ceSetMode(false);
  document.getElementById("ceReset").onclick = () => {
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
      const payload = {
        publication: { name: state.name, tagline: state.tagline, address: state.address },
        testRecipients: state.recipients,
        confirmationEmail: state.confirmation,
      };
      const r = await withRemakeConfirm(
        (ack) =>
          api("/api/settings", {
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
      if (err.status === 409 && err.data?.error === "remake_too_close") {
        bar.showError(err.message);
      } else {
        toast(err.message);
      }
    }
  }
  function discardSettings() {
    state.name = baseline.name;
    state.tagline = baseline.tagline;
    state.address = baseline.address;
    state.recipients = [...baseline.recipients];
    state.confirmation = { ...baseline.confirmation };
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
  renderRecipChips();
  setEmbed("plain");
  templatePreview.repaint();
  repaintConfirmation();
  refreshDirty();
}
