// Kestrel editor — a small vanilla SPA over the same HTTP API Claude uses.
// Auth is edge-centric: in production Cloudflare Access gates this surface, so the
// browser's Access session cookie authenticates every same-origin call and there is
// nothing to paste. In local dev there is no edge, so the editor mints a dev token
// on boot (/api/dev/token) and sends it as a bearer. Either way the boot probe
// (/api/whoami) tells us who we are and which mode we're in; the identity chip and
// the failure handling follow from that.

const TOKEN_KEY = "kestrel_token";
let token = localStorage.getItem(TOKEN_KEY) || "";
let session = null; // { principal: { kind, email? }, auth: { mode } } once booted
// The last GET /api/settings payload ({ settings, deployment }), fetched at boot so
// the sidebar brand and the dashboard's publication/setup cards can read the
// origins and the From-address fallback without re-fetching on every render.
let appConfig = null;
let statusTimer = null; // countdown interval, cleared on navigation
let editorPollTimer = null; // freshness poll while the editor is open, cleared on navigation
let progressTimer = null; // live in-flight /progress poll (watch view + active-send widget), cleared on navigation
// Bumped on every navigation (route()). The recursive-setTimeout pollers below capture it
// when they schedule and bail after their await if it changed: clearing progressTimer stops
// the *next* tick, but a poll whose fetch is already in flight when the user navigates would
// otherwise resolve afterward and repaint (or swap) the view they just opened — and clobber
// that new view's own poll timer. The generation check is the guard that in-flight poll can't.
let navGeneration = 0;
// The Template page's "Start from example" menu binds its outside-click dismissal
// exactly once for the app's lifetime (see renderTemplate); this guards against
// re-binding — and so leaking a listener — on every visit to the page.
let exampleMenuDismissBound = false;
// Autosave uses two timers (see scheduleAutosave): save after a short idle pause,
// but never let an edit sit unsaved longer than the hard cap even while typing.
let autosaveIdleTimer = null;
let autosaveCapTimer = null;
const IDLE_MS = 5000; // quiet pause before a background save
const MAX_MS = 30000; // hard cap: no edit stays unsaved longer than this
function clearAutosaveTimers() {
  if (autosaveIdleTimer) {
    clearTimeout(autosaveIdleTimer);
    autosaveIdleTimer = null;
  }
  if (autosaveCapTimer) {
    clearTimeout(autosaveCapTimer);
    autosaveCapTimer = null;
  }
}
// Current-editor state, reset on navigation; the mounted editor re-establishes it.
let isEditorDirty = false; // has unsaved edits — drives the nav guards
let editorSaveFailed = false; // the last save errored — the leave guard then prompts instead of silently flushing
let editorConflict = false; // the draft changed elsewhere (out-of-date banner up) — like a save failure, the leave guard prompts
let editorHash = null; // hash the editor is mounted at, so the leave guard knows where to return
let editorLeaveFlush = null; // save-and-go on SPA navigation away from a dirty editor
let editorManualSave = null; // ⌘S / Ctrl-S handler for the mounted editor
const LEAVE_MSG = "You have unsaved changes. Leave without saving?";

const app = document.getElementById("app");
const identity = document.getElementById("identity");
const toasts = document.getElementById("toasts");

// Mobile nav drawer: the hamburger slides the sidebar in; the scrim or any nav
// click closes it. On desktop the sidebar is always in view and these are inert.
const navToggle = document.getElementById("navToggle");
const navScrim = document.getElementById("navScrim");
function setNavOpen(open) {
  document.body.classList.toggle("nav-open", open);
  navToggle?.setAttribute("aria-expanded", open ? "true" : "false");
  if (navScrim) {
    navScrim.hidden = !open;
  }
}
navToggle?.addEventListener("click", () =>
  setNavOpen(!document.body.classList.contains("nav-open")),
);
navScrim?.addEventListener("click", () => setNavOpen(false));
document.querySelector(".sidebar")?.addEventListener("click", (e) => {
  if (e.target.closest("a")) {
    setNavOpen(false);
  }
});

// Collapsible sidebar. The effective width mode lives in data-nav on <html> ("full"
// vs "rail"); CSS keys off it. By default the mode follows the viewport width (the
// <head> guard in index.html sets it before first paint). The footer chevron toggles a
// manual override, but that override is deliberately session-only — held in memory, not
// stored — so a plain reload always drops back to the width-based default. That gives a
// one-keystroke way back to "auto" and avoids a saved preference getting stuck fighting
// the width across sizes. The chevron is hidden below 540, where the sidebar is an
// off-canvas overlay driven by the hamburger instead.
const navCollapse = document.getElementById("navCollapse");
// null = follow the width; "collapsed" / "expanded" = manual override for this load.
let navOverride = null;
function computeNavMode() {
  if (window.innerWidth < 540) {
    return "full";
  }
  if (navOverride === "collapsed") {
    return "rail";
  }
  if (navOverride === "expanded") {
    return "full";
  }
  return window.innerWidth <= 1024 ? "rail" : "full";
}
function applyNavMode() {
  const mode = computeNavMode();
  document.documentElement.dataset.nav = mode;
  if (!navCollapse) {
    return;
  }
  const expanded = mode !== "rail";
  const label = expanded ? "Collapse sidebar" : "Expand sidebar";
  navCollapse.setAttribute("aria-expanded", expanded ? "true" : "false");
  navCollapse.setAttribute("aria-label", label);
  navCollapse.setAttribute("title", label);
}
navCollapse?.addEventListener("click", () => {
  navOverride = document.documentElement.dataset.nav !== "rail" ? "collapsed" : "expanded";
  applyNavMode();
});
// Track the responsive default as the window resizes (rAF-coalesced). A session
// override still wins at 540 and up; below it, the phone overlay takes over. The
// nav-resizing class suppresses the sidebar's own transitions for the duration, so a
// breakpoint cross (rail → phone drawer) snaps instead of animating a stray slide.
let navResizeRaf = 0;
let navResizeSettle = 0;
window.addEventListener("resize", () => {
  document.body.classList.add("nav-resizing");
  clearTimeout(navResizeSettle);
  navResizeSettle = setTimeout(() => {
    document.body.classList.remove("nav-resizing");
  }, 200);
  if (navResizeRaf) {
    return;
  }
  navResizeRaf = requestAnimationFrame(() => {
    navResizeRaf = 0;
    applyNavMode();
  });
});
applyNavMode();

// ---- Material Symbols icon paths (viewBox 0 -960 960 960) ----
const ICONS = {
  heading: "M360-280v-400h80v160h160v-160h80v400h-80v-160H440v160h-80Z",
  bold: "M272-200v-560h221q65 0 120 40t55 111q0 51-23 78.5T602-491q25 11 55.5 41t30.5 90q0 89-65 124.5T501-200H272Zm121-112h104q48 0 58.5-24.5T566-372q0-11-10.5-35.5T494-432H393v120Zm0-228h93q33 0 48-17t15-38q0-24-17-39t-44-15h-95v109Z",
  italic: "M200-200v-100h160l120-360H320v-100h400v100H580L460-300h140v100H200Z",
  quote:
    "m228-240 92-160q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 23-5.5 42.5T458-480L320-240h-92Zm360 0 92-160q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 23-5.5 42.5T818-480L680-240h-92ZM362.5-517.5Q380-535 380-560t-17.5-42.5Q345-620 320-620t-42.5 17.5Q260-585 260-560t17.5 42.5Q295-500 320-500t42.5-17.5Zm360 0Q740-535 740-560t-17.5-42.5Q705-620 680-620t-42.5 17.5Q620-585 620-560t17.5 42.5Q655-500 680-500t42.5-17.5ZM680-560Zm-360 0Z",
  code: "M320-240 80-480l240-240 57 57-184 184 183 183-56 56Zm320 0-57-57 184-184-183-183 56-56 240 240-240 240Z",
  link: "M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z",
  ul: "M360-200v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360ZM200-160q-33 0-56.5-23.5T120-240q0-33 23.5-56.5T200-320q33 0 56.5 23.5T280-240q0 33-23.5 56.5T200-160Zm0-240q-33 0-56.5-23.5T120-480q0-33 23.5-56.5T200-560q33 0 56.5 23.5T280-480q0 33-23.5 56.5T200-400Zm-56.5-263.5Q120-687 120-720t23.5-56.5Q167-800 200-800t56.5 23.5Q280-753 280-720t-23.5 56.5Q233-640 200-640t-56.5-23.5Z",
  ol: "M120-80v-60h100v-30h-60v-60h60v-30H120v-60h120q17 0 28.5 11.5T280-280v40q0 17-11.5 28.5T240-200q17 0 28.5 11.5T280-160v40q0 17-11.5 28.5T240-80H120Zm0-280v-110q0-17 11.5-28.5T160-510h60v-30H120v-60h120q17 0 28.5 11.5T280-560v70q0 17-11.5 28.5T240-450h-60v30h100v60H120Zm60-280v-180h-60v-60h120v240h-60Zm180 440v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360Z",
  indent:
    "M120-120v-80h720v80H120Zm320-160v-80h400v80H440Zm0-160v-80h400v80H440Zm0-160v-80h400v80H440ZM120-760v-80h720v80H120Zm0 440v-320l160 160-160 160Z",
  paperclip:
    "M720-330q0 104-73 177T470-80q-104 0-177-73t-73-177v-370q0-75 52.5-127.5T400-880q75 0 127.5 52.5T580-700v350q0 46-32 78t-78 32q-46 0-78-32t-32-78v-370h80v370q0 13 8.5 21.5T470-320q13 0 21.5-8.5T500-350v-350q-1-42-29.5-71T400-800q-42 0-71 29t-29 71v370q-1 71 49 120.5T470-160q70 0 119-49.5T640-330v-390h80v390Z",
  info: "M440-280h80v-240h-80v240Zm68.5-331.5Q520-623 520-640t-11.5-28.5Q497-680 480-680t-28.5 11.5Q440-657 440-640t11.5 28.5Q463-600 480-600t28.5-11.5ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z",
};
const icon = (name) =>
  `<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

// The Kestrel falcon mark (the product's own mark), used to identify the reference
// room — distinct from a publication's own logo, which lives in the sidebar brand.
const KESTREL_PATH =
  "M290.028 216.064C285.698 218.264 280.838 219.394 275.978 219.344C281.268 225.044 284.128 232.924 283.708 240.694C283.278 248.844 279.388 256.514 274.268 262.874C269.148 269.244 262.808 274.494 256.608 279.814C237.148 296.474 218.248 314.404 195.328 325.854C178.568 334.224 160.148 338.864 143.458 347.374C140.148 349.064 136.898 350.904 133.418 352.224C129.938 353.544 126.178 354.324 122.498 353.794C121.718 353.684 120.938 353.504 120.228 353.184C119.508 352.864 118.848 352.374 118.408 351.734C117.918 351.024 117.708 350.154 117.718 349.304C117.728 348.454 117.948 347.614 118.268 346.824C118.567 346.054 118.967 345.339 119.371 344.618L119.418 344.534C128.788 327.894 140.118 312.454 150.358 296.344C160.598 280.224 169.848 263.174 174.428 244.634C176.258 237.264 177.328 229.644 176.738 222.074C176.138 214.504 173.808 206.964 169.308 200.854C164.588 194.434 157.728 189.874 150.538 186.434C139.628 181.204 127.768 178.284 115.858 176.154C93.9183 172.224 71.6083 170.884 49.4083 168.944C45.8483 168.634 42.2483 168.294 38.8783 167.124C34.7683 165.704 31.0683 163.004 28.7383 159.334C26.4183 155.664 25.5583 151.024 26.7483 146.844C27.6583 143.624 29.7283 140.784 32.3583 138.724C34.9883 136.654 38.1683 135.324 41.4383 134.634C44.7183 133.944 48.0983 133.874 51.4383 134.154C53.2683 134.304 55.0883 134.554 56.8983 134.824C72.2383 137.094 87.3783 140.484 102.548 143.644C115.468 146.334 128.498 148.864 141.688 149.224C154.878 149.574 168.338 147.654 180.178 141.824C196.548 133.764 208.758 118.514 215.298 101.474C224.258 78.094 223.028 52.174 220.398 27.284C219.788 21.484 219.108 15.614 220.058 9.854C220.178 9.124 220.328 8.38398 220.658 7.71398C220.988 7.05398 221.528 6.45399 222.228 6.19399C222.858 5.95399 223.568 6.01399 224.218 6.22399C224.858 6.43399 225.448 6.77399 226.028 7.12399C262.588 29.154 290.508 63.614 310.198 101.484C312.188 105.314 314.108 109.204 315.408 113.314C316.708 117.434 317.358 121.814 316.768 126.084C316.348 129.114 315.268 132.104 313.318 134.454C310.668 137.634 306.688 139.354 302.778 140.744C298.878 142.124 294.808 143.324 291.488 145.804C286.998 149.174 284.328 154.834 284.598 160.444C292.098 161.904 299.448 164.114 306.508 167.014C312.788 169.594 318.998 172.854 323.418 178.014C327.088 182.294 329.288 187.614 331.438 192.844C332.158 194.584 332.878 196.344 333.328 198.184C333.778 200.014 333.958 201.944 333.578 203.794C333.138 205.934 331.948 207.914 330.248 209.294C329.898 208.024 329.258 206.834 328.408 205.834C326.958 204.154 324.928 203.054 322.798 202.454C318.258 201.174 313.328 202.114 309.018 204.044C304.708 205.974 300.898 208.834 297.068 211.584C294.808 213.204 292.508 214.804 290.028 216.064Z";
const kestrelMark = () =>
  `<svg viewBox="0 0 360 360" aria-hidden="true"><path d="${KESTREL_PATH}"/></svg>`;

// Every entry in the reference room's Docs list carries the same Material "article"
// glyph — it inherits the row color, so it reads muted until a doc is the open one
// (then it and its underlined title go to the active fg). The icon marks these as
// docs, distinct from the icon-less "On this page" section links below them.
const ARTICLE_ICON =
  '<svg class="toc-h-mark" viewBox="0 -960 960 960" aria-hidden="true"><path d="M280-280h280v-80H280v80Zm0-160h400v-80H280v80Zm0-160h400v-80H280v80Zm-80 480q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h560q33 0 56.5 23.5T840-760v560q0 33-23.5 56.5T760-120H200Zm0-80h560v-560H200v560Zm0-560v560-560Z"/></svg>';

// The reference room shell shared by Overview / Docs / API: a top bar (a rail-width
// "← Dashboard", the Kestrel mark, and the surface switch) over a two-column grid
// whose left column — the contents rail — lines up exactly under "← Dashboard".
// Pass railHtml = null for a surface with no contents rail (Overview).
function roomShell(active, railHtml, mainHtml) {
  const tab = (view, label) =>
    `<a href="#/${view}" data-room="${view}" data-text="${esc(label)}"${active === view ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
  const body =
    railHtml == null
      ? `<div class="room-body norail"><div class="room-main">${mainHtml}</div></div>`
      : `<div class="room-body"><nav class="room-rail" aria-label="Contents"><div class="rail-inner">${railHtml}</div></nav><div class="room-main">${mainHtml}</div></div>`;
  return `<div class="room">
    <header class="room-bar">
      <a class="room-back" href="#/dashboard"><span aria-hidden="true">←</span>&nbsp;Dashboard</a>
      <div class="room-nav">
        <span class="room-brand">${kestrelMark()}<span>Kestrel</span></span>
        <nav class="room-switch" aria-label="Reference">${tab("start", "Overview")}${tab("docs", "Docs")}${tab("reference", "API")}</nav>
        <a class="room-close" href="#/dashboard" title="Back to publication" aria-label="Back to publication"><span aria-hidden="true">✕</span></a>
      </div>
    </header>
    ${body}
  </div>`;
}

// ---- auth ----
function setToken(t) {
  token = (t || "").trim();
  try {
    // Clearing (empty token) removes the key rather than storing "", so the next
    // boot takes the "no token → mint" path instead of probing with a dead value.
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* private mode */
  }
}
// The dev token goes in Authorization; in Access mode there is no token and the
// session cookie authenticates instead, so we send no header.
function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Renders the topbar identity chip from `session`, and handles an auth failure by
// steering to the right recovery: re-login (Access) vs. re-mint (dev).
function renderIdentity() {
  if (!identity) {
    return;
  }
  const mode = session?.auth?.mode;
  const p = session?.principal || {};
  if (mode === "access") {
    const who = p.email || (p.kind === "service" ? "Service token" : "Signed in");
    identity.innerHTML =
      `<span class="who" title="${esc(who)}">${esc(who)}</span>` +
      `<a class="ghost" href="/cdn-cgi/access/logout" title="Sign out">` +
      `<svg class="signout-icon" aria-hidden="true"><use href="#i-signout"/></svg>` +
      `<span class="signout-label">Sign out</span></a>`;
  } else {
    identity.innerHTML = `<span class="who dev" title="Local dev — auth is bypassed on localhost">Local dev</span>`;
  }
}

// ---- publication identity (sidebar brand) ----
// The publication's name / tagline / logo come from the settings surface
// (settings.publication). Each field falls back sensibly when unset: the name from
// the From: display name (the read-only deployment reflection) and a neutral initial
// tile for the logo.
function parseFromName(fromAddress) {
  if (!fromAddress) {
    return null;
  }
  // "Display Name <addr@domain>" → "Display Name"; a bare address has no display name.
  const m = String(fromAddress).match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = m?.[1] ? m[1].trim() : "";
  return name || null;
}
function derivePublication(data) {
  const s = data?.settings || {};
  const d = data?.deployment || {};
  const p = s.publication || {}; // the publication identity, edited in Settings
  return {
    name: p.name || parseFromName(d.fromAddress) || "Your publication",
    tagline: p.tagline || "",
    logoUrl: p.logoUrl || null,
  };
}
function renderSidebarBrand() {
  const pub = derivePublication(appConfig);
  const nameEl = document.getElementById("brandName");
  const tagEl = document.getElementById("brandTagline");
  const logoEl = document.getElementById("brandLogo");
  if (nameEl) {
    nameEl.textContent = pub.name;
  }
  if (tagEl) {
    tagEl.textContent = pub.tagline;
    tagEl.hidden = !pub.tagline;
  }
  if (logoEl) {
    if (pub.logoUrl) {
      logoEl.innerHTML = `<img src="${esc(pub.logoUrl)}" alt="">`;
      logoEl.classList.remove("brand-logo-placeholder");
    } else {
      // Neutral placeholder tile: the publication's initial on the accent.
      logoEl.textContent = (pub.name.trim()[0] || "K").toUpperCase();
      logoEl.classList.add("brand-logo-placeholder");
    }
  }
}

// Create a draft and jump into the editor — shared by the Posts list, the Dashboard,
// and the setup checklist so the "New post" affordance behaves identically everywhere.
function createNewPost(btn) {
  return busy(btn, "Creating…", async () => {
    try {
      const { post } = await api("/posts", { method: "POST", json: { subject: "Untitled" } });
      location.hash = `#/edit/${post.id}`;
    } catch (err) {
      toast(err.message);
    }
  });
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy to clipboard");
  }
}
// The canonical archive URL for a slug, from the read-only deployment reflection
// (mirrors src/render/render.ts archiveUrl; falls back to this origin if unset).
function archiveUrlFor(deployment, slug) {
  const origin = deployment?.archiveOrigin || location.origin;
  const base = deployment?.archiveBasePath || "";
  return `${origin}${base}/${slug}`;
}

// True when no real email provider is configured — internally the dev `fake` transport,
// which records a send but never delivers. Read from the same read-only deployment
// reflection the sidebar and Settings already consume (appConfig.deployment), fetched
// once at boot. Dev-only by construction: deployed environments require SES/Resend, so
// this is structurally absent in production. The user-facing copy avoids the internal
// "fake transport" term (see docs/DESIGN.md §2); a later issue will make this notice
// environment-aware and link to the setup docs.
function noEmailProvider() {
  return (appConfig?.deployment?.provider || "") === "fake";
}
// Suffix a send/test/schedule confirmation so it never reads as a real send when no
// provider is set up. Tense-neutral ("nothing is delivered") so it fits a test that
// already ran, a send now queued, and a schedule that will fire later alike.
function withNoProviderNote(msg) {
  return noEmailProvider() ? `${msg} (no email provider configured — nothing is delivered)` : msg;
}

// Access sessions expire at the edge (the request never reaches the app), so the
// only recovery is a fresh document load that re-triggers the Access login. In dev
// this shouldn't happen, but a reload re-mints, so the same affordance is safe.
function showReauth() {
  // No identity yet — hide the publication chrome so the wall stands alone.
  document.body.classList.add("signed-out");
  app.innerHTML =
    `<div class="card auth-wall"><h2>Session expired</h2>` +
    `<p class="hint">Your access session ended. Sign in again to continue.</p>` +
    `<button id="reauth">Sign in</button></div>`;
  const b = document.getElementById("reauth");
  if (b) {
    b.onclick = () => location.reload();
  }
}

// ---- api ----
async function api(path, opts = {}) {
  const headers = Object.assign(authHeaders(), opts.headers || {});
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401) {
    showReauth();
    throw new Error("Not authorized — please sign in again.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || res.statusText);
    err.status = res.status; // callers (e.g. the editor's conflict handling) branch on this
    err.data = data;
    throw err;
  }
  return data;
}

// Like api(), but returns the raw response text instead of parsing JSON — for the
// endpoints that answer with HTML (the rendered preview). Keeps the same 401 →
// re-auth guard, which a bare fetch(authHeaders()) would skip.
async function apiText(path, opts = {}) {
  const headers = Object.assign(authHeaders(), opts.headers || {});
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401) {
    showReauth();
    throw new Error("Not authorized — please sign in again.");
  }
  if (!res.ok) {
    const err = new Error(res.statusText);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

// ---- helpers ----
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  toasts.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  // Linger long enough to read a sentence-length confirmation ("Test sent to 2
  // addresses") before it fades; the removal trails the fade-out transition.
  setTimeout(() => t.classList.remove("show"), 3600);
  setTimeout(() => t.remove(), 3900);
}
const esc = (s) =>
  s == null
    ? ""
    : String(s).replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
      );
const badge = (status) => `<span class="badge ${status}">${status}</span>`;
const fmt = (ms) =>
  ms
    ? new Date(ms).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

// Split a free-text recipient list (newlines or commas) into unique addresses.
// Server-side validation is authoritative; this just tidies the Send-test input.
function parseAddresses(text) {
  const seen = new Set(),
    out = [];
  for (const part of String(text || "").split(/[\n,]+/)) {
    const a = part.trim();
    if (!a?.includes("@")) {
      continue;
    }
    const key = a.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(a);
  }
  return out;
}

// Client-side slug (mirrors src/lib/slug.ts) for the linked Subject → Slug field.
function clientSlugify(s) {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
// A countdown that gets coarser the further out the fire time is: it ticks seconds
// only inside the last few minutes (the imminent / send-now cancel window), then
// counts down by the minute, by the hour within a day, and by whole days beyond —
// so a send scheduled days away reads "Sends in 2 days", not a ticking "47h 47m".
function untilStr(fireAt) {
  const d = fireAt - Date.now();
  if (d <= 0) {
    return "Sending now…";
  }
  const s = Math.floor(d / 1000);
  const min = Math.floor(s / 60);
  const hr = Math.floor(min / 60);
  if (s < 300) {
    return min > 0 ? `Sends in ${min}m ${String(s % 60).padStart(2, "0")}s` : `Sends in ${s}s`;
  }
  if (min < 60) {
    return `Sends in ${min}m`;
  }
  if (hr < 24) {
    const rm = min % 60;
    return rm > 0 ? `Sends in ${hr}h ${rm}m` : `Sends in ${hr}h`;
  }
  const days = Math.round(hr / 24);
  return `Sends in ${days} day${days === 1 ? "" : "s"}`;
}
function modal(html) {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("click", (e) => {
    if (e.target === back) {
      close();
    }
  });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", onEsc);
    }
  });
  return { el: back, close };
}
async function busy(btn, label, fn) {
  const orig = btn.textContent;
  btn.disabled = true;
  if (label) {
    btn.textContent = label;
  }
  try {
    return await fn();
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }
}
function renderError(container, msg, retryFn) {
  container.innerHTML = `<div class="error"><span>${esc(msg)}</span><button class="ghost" data-retry>Retry</button></div>`;
  const b = container.querySelector("[data-retry]");
  if (b) {
    b.onclick = retryFn;
  }
}

// ---- shared unsaved-changes bar ----
// One full-width banner fixed to the bottom of the viewport (markup in index.html),
// shared by every surface with an explicit save + a revertible baseline: Settings
// and the Template page. A page attaches once on mount, then drives it — setDirty()
// slides it up while there are unsaved changes, showError() keeps it up after a
// rejected save and says why (right beside Save). route() detaches it on every
// navigation, so a page owns the bar only while it's mounted. The post editor keeps
// its own autosave + conflict model (see renderEditor) and deliberately does not use
// this — a "Save / Discard against a baseline" bar doesn't fit continuous autosave.
const savebar = (() => {
  const el = document.getElementById("savebar");
  const msgEl = el.querySelector(".savebar-msg");
  const saveBtn = document.getElementById("savebarSave");
  const discardBtn = document.getElementById("savebarDiscard");
  // Bumped on every attach/detach so a stale async handler (a save that resolves
  // after the user navigated away) can never drive a bar a new page now owns.
  let token = 0;

  const setMsg = (text) => {
    msgEl.innerHTML = `<span class="savebar-dot"></span><span></span>`;
    msgEl.lastChild.textContent = text;
  };
  const reveal = () => {
    el.hidden = false;
    // Arm the slide-up: un-hide, then force a reflow so the off-screen base transform
    // is the established start state before .show flips it (a hidden → .show toggle in
    // one tick wouldn't transition). A synchronous reflow works even when the tab is
    // backgrounded and requestAnimationFrame is paused.
    void el.offsetHeight;
    el.classList.add("show");
  };

  function detach() {
    token++;
    el.classList.remove("show", "is-error");
    el.hidden = true;
    saveBtn.onclick = null;
    discardBtn.onclick = null;
    // Drop the bottom padding the page reserved for the (fixed) bar.
    document.body.classList.remove("has-savebar");
  }

  // Mount the bar for the current page; returns the handle the page drives. onSave
  // runs inside busy() on the shared Save button, so the page's callback is a plain
  // async function (it should call handle.setDirty(false) on success, or
  // handle.showError(msg) on a rejected save).
  function attach({ onSave, onDiscard, saveLabel = "Save changes", discardLabel = "Discard" }) {
    const mine = ++token;
    saveBtn.textContent = saveLabel;
    discardBtn.textContent = discardLabel;
    el.classList.remove("show", "is-error");
    setMsg("You have unsaved changes.");
    el.hidden = true; // revealed on the first setDirty(true) / showError()
    // Reserve bottom room on the content for the whole time this page is mounted, so
    // the last section never slides under the fixed bar (no shift as it toggles).
    document.body.classList.add("has-savebar");
    saveBtn.onclick = () => busy(saveBtn, "Saving…", () => Promise.resolve(onSave()));
    discardBtn.onclick = () => onDiscard();
    const alive = () => token === mine;
    return {
      setDirty(dirty) {
        if (!alive()) {
          return;
        }
        el.classList.remove("is-error");
        if (dirty) {
          setMsg("You have unsaved changes.");
          reveal();
        } else {
          el.classList.remove("show");
        }
      },
      showError(text) {
        if (!alive()) {
          return;
        }
        el.classList.add("is-error");
        setMsg(text);
        reveal();
      },
    };
  }

  return { attach, detach };
})();

// Keep an info tooltip within the viewport. The tip is a CSS pseudo-element
// anchored to the icon's left edge; pure CSS can't see the viewport, so before it
// shows we measure the icon and, if the (width-capped) tip would run off the right
// edge on a narrow screen, slide it left via --tip-x. Delegated so it survives view
// re-renders; with JS off the tip falls back to left:0. Vertical placement stays in
// CSS (the .tip-below variant) — which icons sit near the top is static, not dynamic.
const TIP_GUTTER = 8;
function positionInfoTip(el) {
  // Measure the rendered tip (laid out even while hidden) so this stays in step
  // with the CSS max-width/padding rather than duplicating them here.
  const tip = getComputedStyle(el, "::after");
  const tipW = parseFloat(tip.width) + parseFloat(tip.paddingLeft) + parseFloat(tip.paddingRight);
  if (!Number.isFinite(tipW)) {
    return;
  }
  const iconLeft = el.getBoundingClientRect().left;
  const vw = document.documentElement.clientWidth;
  // Slide left enough to clear the right gutter, but never so far that the left
  // edge crosses the gutter (very narrow screens) and never rightward (shift ≤ 0).
  const shift = Math.min(0, Math.max(vw - TIP_GUTTER - tipW - iconLeft, TIP_GUTTER - iconLeft));
  el.style.setProperty("--tip-x", `${Math.round(shift)}px`);
}
// Position before the tip shows on either trigger: pointer hover, or focus — the
// latter is how keyboard (Tab) and touch (tap focuses the span) reach it.
for (const type of ["pointerover", "focusin"]) {
  document.addEventListener(type, (e) => {
    const el = e.target.closest?.(".info");
    if (el) {
      positionInfoTip(el);
    }
  });
}
// Escape dismisses a focus-shown tip without tabbing away (the pointer tip just
// needs the mouse to leave).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.activeElement?.classList.contains("info")) {
    document.activeElement.blur();
  }
});

// The ⓘ affordance whose explanation shows as a tooltip. Focusable and
// role/aria-labelled so it's reachable by keyboard and touch (the tip shows on
// :focus, not only :hover) and read by screen readers — the aria-label mirrors the
// visible tip. `below` drops the tip under the icon (for icons near the page top).
function infoTip(tip, { below = false } = {}) {
  const t = esc(tip);
  return `<span class="info${below ? " tip-below" : ""}" role="img" tabindex="0" aria-label="${t}" data-tip="${t}">${icon("info")}</span>`;
}

// popover menu for row actions (⋯). A transparent full-screen overlay (behind
// the menu) closes it on an outside click — no document-listener race.
let menuEls = [];
function closeMenu() {
  menuEls.forEach((e) => {
    e.remove();
  });
  menuEls = [];
}
function openMenu(anchor, items) {
  closeMenu();
  const overlay = document.createElement("div");
  overlay.className = "menu-overlay";
  overlay.onclick = closeMenu;
  const m = document.createElement("div");
  m.className = "menu";
  items.forEach((it) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `menu-item${it.danger ? " danger-item" : ""}`;
    b.textContent = it.label;
    b.onclick = () => {
      closeMenu();
      it.onClick();
    };
    m.appendChild(b);
  });
  document.body.appendChild(overlay);
  document.body.appendChild(m);
  menuEls = [overlay, m];
  const r = anchor.getBoundingClientRect();
  m.style.top = `${r.bottom + window.scrollY + 4}px`;
  m.style.left = `${r.right + window.scrollX - m.offsetWidth}px`;
}

// ---- router ----
function route() {
  if (statusTimer) {
    clearInterval(statusTimer);
    statusTimer = null;
  }
  if (editorPollTimer) {
    clearInterval(editorPollTimer);
    editorPollTimer = null;
  }
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  // Invalidate any poll whose fetch is already in flight: clearing progressTimer only stops
  // the pending tick, not one mid-await, so a stale callback would resolve into the view we're
  // about to mount. Bumping the generation makes that callback bail (see navGeneration).
  navGeneration++;
  clearAutosaveTimers();
  isEditorDirty = false;
  editorSaveFailed = false;
  editorConflict = false;
  editorHash = null; // renderEditor re-establishes these when it mounts
  editorLeaveFlush = null;
  editorManualSave = null;
  savebar.detach(); // the mounting page re-attaches if it uses the shared save bar
  const hash = location.hash || "#/dashboard";
  const [, view, arg] = hash.split("/");
  // The editor wants the full width, and carries its own "← Posts" affordance, so
  // it hides the sidebar rather than living beside it (SPEC §10: admin-only chrome).
  document.body.classList.toggle("editor-mode", view === "edit");
  // The tool/help pages (Getting started, Docs, API) are about Kestrel itself, not
  // the publication, so they drop the publication sidebar for a slim tool bar.
  const toolMode = view === "start" || view === "docs" || view === "reference";
  document.body.classList.toggle("tool-mode", toolMode);
  // Mark the active nav item across both sidebar navs (primary + tools) so the
  // reader can see where they are (aria-current also styles it).
  document.querySelectorAll(".sidebar a[data-view]").forEach((a) => {
    if (a.dataset.view === view) {
      a.setAttribute("aria-current", "page");
    } else {
      a.removeAttribute("aria-current");
    }
  });
  // The reference room's surface switch is marked at render time (roomShell). Close
  // the mobile nav drawer on any navigation.
  setNavOpen(false);
  if (view === "edit" && arg) {
    return renderEditor(arg);
  }
  if (view === "drafts") {
    return renderDrafts();
  }
  if (view === "subscribers") {
    return renderSubscribers(arg);
  }
  if (view === "sent") {
    return arg ? renderSentRecord(arg) : renderSent();
  }
  if (view === "template") {
    return renderTemplate();
  }
  if (view === "settings") {
    return renderSettings();
  }
  if (view === "reference") {
    return renderReference();
  }
  if (view === "docs") {
    return renderDocs(arg);
  }
  if (view === "start") {
    return renderStart();
  }
  return renderDashboard();
}
// Navigating away from a dirty editor saves in the background rather than
// prompting — hashchange fires after the hash has already moved, so the flush
// captures the payload before route() tears down the DOM. The exception is when
// the last save FAILED: silently flushing could lose work, so we fall back to a
// confirm() (synchronous, unlike the modal helper) and, on cancel, restore the
// editor's hash and swallow the echo.
let revertingHash = false;
window.addEventListener("hashchange", () => {
  if (revertingHash) {
    revertingHash = false;
    return;
  }
  if (isEditorDirty && editorHash && location.hash !== editorHash) {
    if (editorSaveFailed || editorConflict) {
      // A silent flush would fail (or clobber) — prompt so the user decides.
      if (!confirm(LEAVE_MSG)) {
        revertingHash = true;
        location.hash = editorHash;
        return;
      }
    } else if (editorLeaveFlush) {
      editorLeaveFlush();
    }
  }
  route();
});
// Tab close / reload / external navigation: can't reliably finish an async save,
// so fall back to the browser's own generic unsaved-changes prompt.
window.addEventListener("beforeunload", (e) => {
  if (isEditorDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
// ⌘S / Ctrl-S saves the mounted editor (registered once; no-op elsewhere).
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && editorManualSave) {
    e.preventDefault();
    editorManualSave();
  }
});

// ---- shared list controls (toolbar · sortable headers · pager) ----
// One convention for the admin list views (Posts, Subscribers, Sends): a search-left
// / filters-right toolbar, clickable sortable column headers, and offset pagination —
// all driven by a small per-view `state` object whose reload() rebuilds the query and
// re-fetches. The hash only seeds the initial filter (dashboard deep-links); sort,
// page, and filter operate in place, matching the `page` envelope the endpoints return
// (see src/lib/list.ts).

// Build the query string for a list request from the view state. `sort`/`dir` are sent
// only once a column is chosen (state.sort set), so a view keeps its endpoint's bespoke
// default order (e.g. posts' scheduled-first) until the reader sorts.
function listQuery(state) {
  const p = new URLSearchParams();
  if (state.status) {
    p.set("status", state.status);
  }
  if (state.suppressed) {
    p.set("suppressed", state.suppressed);
  }
  const term = (state.search || "").trim();
  if (term) {
    p.set("search", term);
  }
  if (state.sort) {
    p.set("sort", state.sort);
    p.set("dir", state.dir);
  }
  p.set("limit", String(state.limit));
  p.set("offset", String(state.offset));
  return p.toString();
}

// A filter/search toolbar: search on the left, the status filter pinned right.
// `cfg.statuses` = [{value,label}]. `cfg.suppressible` (subscribers only) adds a
// separate "Suppressed only" toggle — suppression is a deliverability flag, not a
// consent status, so it's its own control (an independent axis you can combine with a
// status), never an option inside the status dropdown.
// `cfg.allValue` sets what the "All statuses" option means — normally "" (no status
// filter), but the Drafts view passes "draft,scheduled" so "All" stays scoped to the
// two draft-side statuses rather than reaching sent issues. Omit `cfg.statuses` for a
// search-only toolbar (the Sent list is single-status, so it carries no status filter).
function listToolbar(cfg) {
  const statusSel = cfg.statuses?.length
    ? `<select class="lt-status" aria-label="Filter by status">${[
        `<option value="${esc(cfg.allValue || "")}">All statuses</option>`,
      ]
        .concat(cfg.statuses.map((s) => `<option value="${s.value}">${esc(s.label)}</option>`))
        .join("")}</select>`
    : "";
  const suppressed = cfg.suppressible
    ? '<label class="lt-toggle"><input type="checkbox" class="lt-suppressed"><span>Suppressed</span></label>'
    : "";
  return `<div class="list-toolbar">
    <input class="lt-search" type="search" placeholder="${esc(cfg.searchPlaceholder || "Search…")}" aria-label="Search" autocomplete="off">
    <div class="lt-filters">${statusSel}${suppressed}</div>
  </div>`;
}

// Wire the toolbar controls (within `root`) to the view's reload, seeding their values
// from state so a deep-linked filter shows selected. Search is debounced; any change
// resets to the first page. Status and the suppression toggle are independent axes.
function wireToolbar(root, state, reload) {
  const search = root.querySelector(".lt-search");
  const status = root.querySelector(".lt-status");
  const suppressed = root.querySelector(".lt-suppressed");
  if (search) {
    search.value = state.search || "";
    let t = null;
    search.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.search = search.value;
        state.offset = 0;
        reload();
      }, 250);
    };
  }
  if (status) {
    status.value = state.status || "";
    status.onchange = () => {
      state.status = status.value;
      state.offset = 0;
      reload();
    };
  }
  if (suppressed) {
    suppressed.checked = state.suppressed === "only";
    suppressed.onchange = () => {
      state.suppressed = suppressed.checked ? "only" : "";
      state.offset = 0;
      reload();
    };
  }
}

// A table header cell. A sortable column (given a `key`) renders a button that toggles
// asc/desc and shows the active direction; other columns are plain labels. `cls` adds a
// column class (e.g. "num" for right-aligned numeric columns).
function th(label, key, state, cls) {
  const c = cls ? ` class="${cls}"` : "";
  if (!key) {
    return `<th${c}>${esc(label)}</th>`;
  }
  const active = state.sort === key;
  // A fixed-width slot always reserved (empty when unsorted) so the label doesn't
  // shift when the arrow appears; light ↑/↓ to match the app's other arrows.
  const arrow = active ? (state.dir === "asc" ? "↑" : "↓") : "";
  const klass = `${cls ? `${cls} ` : ""}sortable${active ? " sorted" : ""}`;
  return `<th class="${klass}"><button type="button" class="th-sort" data-sort="${key}">${esc(label)}<span class="th-arrow" aria-hidden="true">${arrow}</span></button></th>`;
}

// Wire the sortable headers inside a freshly-rendered table. Clicking a column sorts by
// it (default desc), or flips direction if it is already the sort key; resets to page 1.
function wireSort(container, state, reload) {
  container.querySelectorAll(".th-sort").forEach((b) => {
    b.onclick = () => {
      const key = b.dataset.sort;
      if (state.sort === key) {
        state.dir = state.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = key;
        state.dir = "desc";
      }
      state.offset = 0;
      reload();
    };
  });
}

// Offset pager: "a–b of N" with Prev/Next. Renders nothing when one page covers all.
function renderPager(el, state, page, reload) {
  // Page by the limit the server actually clamped to (page.limit), not the requested one.
  const limit = page?.limit ?? state.limit;
  if (!page || page.total <= limit) {
    el.innerHTML = "";
    return;
  }
  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + limit, page.total);
  const hasPrev = page.offset > 0;
  const hasNext = page.offset + limit < page.total;
  el.innerHTML = `<div class="pager"><button type="button" class="pager-prev"${hasPrev ? "" : " disabled"}>← Prev</button><span class="pager-range muted">${from}–${to} of ${page.total}</span><button type="button" class="pager-next"${hasNext ? "" : " disabled"}>Next →</button></div>`;
  if (hasPrev) {
    el.querySelector(".pager-prev").onclick = () => {
      state.offset = Math.max(0, page.offset - limit);
      reload();
    };
  }
  if (hasNext) {
    el.querySelector(".pager-next").onclick = () => {
      state.offset = page.offset + limit;
      reload();
    };
  }
}

// ---- drafts list (draft + scheduled) ----
// The writing side (#147): draft + scheduled only — a sent issue is a frozen record and
// lives in Sent. "All statuses" is scoped to those two, so it never reaches sent.
const DRAFT_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
];
const DRAFTS_SCOPE = "draft,scheduled";
async function renderDrafts() {
  // Default sort left empty so the server keeps its scheduled-first order until the
  // reader clicks a column header.
  const state = { status: DRAFTS_SCOPE, search: "", sort: "", dir: "desc", offset: 0, limit: 50 };
  app.innerHTML = `<div class="spread page-head"><h1>Drafts</h1><button class="primary" id="newPost">New post</button></div>
    ${listToolbar({ statuses: DRAFT_STATUSES, allValue: DRAFTS_SCOPE, searchPlaceholder: "Search subject…" })}
    <div id="list" class="muted">Loading…</div>
    <div id="postsPager"></div>`;
  document.getElementById("newPost").onclick = (e) => createNewPost(e.currentTarget);
  const listEl = document.getElementById("list");
  const pagerEl = document.getElementById("postsPager");

  async function load() {
    try {
      const data = await api(`/posts?${listQuery(state)}`);
      const posts = data.posts;
      if (!posts.length) {
        // "Filtered" = a real narrowing beyond the default drafts scope (a search, or a
        // single-status pick) — so a fresh, empty list still reads as an invitation.
        const filtered = state.search || (state.status && state.status !== DRAFTS_SCOPE);
        listEl.innerHTML = `<p class="muted">${
          filtered ? "No drafts match." : "No drafts yet — create your first draft."
        }</p>`;
        pagerEl.innerHTML = "";
        return;
      }
      listEl.innerHTML = `<div class="table-wrap"><table class="list-table"><colgroup><col><col class="c-status"><col class="c-date"><col class="c-date"><col class="c-act"></colgroup><thead><tr>${th("Title", "title", state)}${th("Status", null, state)}${th("Scheduled", "scheduled", state)}${th("Updated", "updated", state)}<th></th></tr></thead><tbody>${posts
        .map((p) => {
          // A post whose send is in flight is no longer an editable/cancelable draft —
          // show it as `sending` and route it to the live watch, not the editor (#162).
          const sending = p.active_send_status === "sending";
          const href = sending ? `#/sent/${p.active_send_id}` : `#/edit/${p.id}`;
          return `<tr class="clickable" data-id="${p.id}" data-target="${href}"><td><a href="${href}">${esc(p.subject) || "<em>untitled</em>"}</a></td><td>${sending ? badge("sending") : badge(p.status)}</td><td class="muted">${p.fire_at ? fmt(p.fire_at) : "—"}</td><td class="muted">${fmt(p.updated_at)}</td><td class="act"><button class="icon" data-menu="${p.id}" data-status="${sending ? "sending" : p.status}" data-target="${href}" aria-label="Post actions">⋯</button></td></tr>`;
        })
        .join("")}</tbody></table></div>`;
      wireSort(listEl, state, load);
      listEl.querySelectorAll("tr[data-id]").forEach((tr) => {
        tr.onclick = (e) => {
          if (e.target.tagName !== "A" && !e.target.closest("[data-menu]")) {
            location.hash = tr.dataset.target;
          }
        };
      });
      listEl.querySelectorAll("[data-menu]").forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          const st = b.dataset.status;
          const items = [
            {
              label: st === "sending" ? "Watch send" : "Open",
              onClick: () => (location.hash = b.dataset.target),
            },
          ];
          if (st === "draft") {
            items.push({
              label: "Delete draft",
              danger: true,
              onClick: () => confirmDelete(b.dataset.menu, load),
            });
          }
          openMenu(b, items);
        };
      });
      renderPager(pagerEl, state, data.page, load);
    } catch (e) {
      renderError(listEl, e.message, load);
    }
  }
  wireToolbar(app, state, load);
  load();
}

function confirmDelete(pid, reload = renderDrafts) {
  const m = modal(
    `<h3>Delete draft?</h3><p class="hint">This permanently deletes the draft and its revisions. This can't be undone.</p><div class="actions"><button type="button" id="dCancel">Cancel</button><button type="button" class="danger" id="dGo">Delete</button></div>`,
  );
  m.el.querySelector("#dCancel").onclick = m.close;
  m.el.querySelector("#dGo").onclick = () =>
    busy(m.el.querySelector("#dGo"), "Deleting…", async () => {
      try {
        await api(`/posts/${pid}`, { method: "DELETE" });
        m.close();
        toast("Draft deleted");
        reload();
      } catch (e) {
        toast(e.message);
      }
    });
}

// ---- editor ----
const TOOLBAR = [
  [
    ["heading", "Heading"],
    ["bold", "Bold (⌘B)"],
    ["italic", "Italic (⌘I)"],
  ],
  [
    ["quote", "Quote"],
    ["code", "Code"],
    ["link", "Link (⌘K)"],
  ],
  [
    ["ul", "Bulleted list"],
    ["ol", "Numbered list"],
    ["indent", "Indent"],
  ],
];

async function renderEditor(id) {
  clearAutosaveTimers();
  // Reload (and cancel-schedule / error-retry) re-enter renderEditor directly, without
  // going through route(), so clear the previous mount's freshness poll here too — an
  // orphaned interval would keep firing on a stale baseRevision closure and wrongly
  // flip editorConflict, silently blocking saves in the fresh editor.
  if (editorPollTimer) {
    clearInterval(editorPollTimer);
    editorPollTimer = null;
  }
  isEditorDirty = false;
  editorSaveFailed = false;
  editorConflict = false;
  editorHash = null; // fresh mount starts clean; the tracking block below re-establishes the hash
  editorLeaveFlush = null;
  editorManualSave = null;
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let post, markdown, scheduled;
  try {
    const data = await api(`/posts/${id}`);
    post = data.post;
    markdown = data.markdown;
    scheduled = data.scheduled;
    // A sent issue is a frozen record, not editable (#147/#148): it opens the sent
    // record view, never the editor. Redirect a stale #/edit link (or a post sent in
    // another tab / by Claude) there instead of a locked editor.
    if (post.status === "sent") {
      location.hash = data.sent ? `#/sent/${data.sent.id}` : "#/sent";
      return;
    }
    // A post whose send is in flight is no longer an editable/cancelable scheduled draft —
    // it's an active send. Send a direct #/edit link to the live watch, not a soft-locked
    // editor with a dead Cancel (#162).
    if (data.sending) {
      location.hash = `#/sent/${data.sending.id}`;
      return;
    }
  } catch (e) {
    renderError(app, e.message, () => renderEditor(id));
    return;
  }

  // The editor now only ever mounts a draft or a scheduled (frozen) post, so `locked`
  // means scheduled — signaled by the scheduled banner, not a status pill (#147).
  const locked = post.status !== "draft";
  // The revision this editor is based on, for optimistic concurrency (SPEC §4).
  // Advanced on each successful save; carried on every save so the server rejects
  // (409) rather than clobbers a newer save from another tab or from Claude.
  let baseRevision = post.current_revision;
  let warnedRevision = null; // newest revision we've surfaced, so we re-arm only on a genuinely newer one
  const toolbarHtml = TOOLBAR.map((group) =>
    group
      .map(
        ([kind, label]) =>
          `<button type="button" class="tb" data-fmt="${kind}" title="${label}" aria-label="${label}">${icon(kind)}</button>`,
      )
      .join(""),
  ).join(`<span class="sep"></span>`);
  const dis = locked ? "disabled" : "";

  app.innerHTML = `
    <div class="editor-head">
      <a href="#/drafts" class="back">← Drafts</a>
      <div class="editor-head-right">
        <button type="button" class="ghost" id="openBtn">Open in browser ↗</button>
      </div>
    </div>
    ${locked && scheduled ? `<div class="banner banner-scheduled"><span>Scheduled for <strong>${esc(fmt(scheduled.fire_at))}</strong> — cancelable until it sends.</span><span class="row"><button type="button" class="ghost" id="cancelSchedule">Cancel</button></span></div>` : ""}
    <div id="freshnessBanner" class="banner banner-conflict" role="alert" hidden></div>
    <div class="card">
      <div class="grid2">
        <div><label for="f-subject">Subject</label><input id="f-subject" value="${esc(post.subject)}" aria-describedby="f-subject-error" ${dis}><div class="field-error" id="f-subject-error" role="alert" hidden><span class="field-error-ico" aria-hidden="true">!</span><span>Add a subject before you schedule.</span></div></div>
        <div>
          <div class="label-row">
            <label for="f-slug">Slug</label>
            ${infoTip("The web address of this issue's archive page.")}
          </div>
          <input id="f-slug" value="${esc(post.slug)}" ${dis}>
          ${locked ? "" : `<label class="slug-auto-toggle"><input type="checkbox" id="f-slug-auto">Auto-generate from subject</label>`}
        </div>
      </div>

      <label for="f-markdown">Body</label>
      <div class="composer">
        <div class="composer-head">
          <div class="ctabs" role="tablist">
            <button type="button" class="ctab active" data-tab="write" data-text="Write" role="tab" aria-selected="true">Write</button>
            <button type="button" class="ctab" data-tab="preview" data-text="Preview" role="tab" aria-selected="false">Preview</button>
          </div>
          <div class="toolbar" role="toolbar" aria-label="Formatting"${locked ? " hidden" : ""}>${toolbarHtml}</div>
        </div>
        <div class="composer-body" id="composerBody">
          <textarea id="f-markdown" class="editor" placeholder="Type your issue in Markdown…" ${dis}>${esc(markdown)}</textarea>
          <iframe id="previewFrame" class="preview" sandbox="allow-same-origin" title="Email preview" hidden></iframe>
        </div>
        <div class="composer-foot" id="dropFoot" ${locked ? "hidden" : ""}>${icon("paperclip")}<span>Paste, drop, or click to add images</span></div>
        <input type="file" id="imgInput" accept="image/*" multiple hidden>
      </div>
      <div id="warnings"></div>

      <div class="actions-bar">
        ${
          locked
            ? `<span class="locked-note">Locked while scheduled — cancel the schedule to edit.</span>
               <div class="row"><button type="button" class="secondary" id="testBtn">${SET_ICON.send}<span>Send test email</span></button></div>`
            : `<div class="row">
                 <button type="button" class="ghost" id="saveBtn">Save draft</button>
                 <span class="save-status" id="saveStatus" aria-live="polite"></span>
               </div>
               <div class="row">
                 <button type="button" class="secondary" id="testBtn">${SET_ICON.send}<span>Send test email</span></button>
                 <button type="button" class="primary" id="scheduleBtn">Schedule</button>
               </div>`
        }
      </div>
    </div>`;

  const ta = document.getElementById("f-markdown");
  const toolbarEl = app.querySelector(".toolbar");
  const previewFrame = document.getElementById("previewFrame");
  const get = (k) => document.getElementById(`f-${k}`).value;
  const collect = () => ({ subject: get("subject"), slug: get("slug"), markdown: get("markdown") });

  // --- subject validation (SPEC §6: freeze() rejects a subjectless send) ---
  // Surfaced on the field, not by disabling the button. The old guard greyed out
  // Schedule and hung the reason in a `title` on the row — invisible to keyboard,
  // touch, and screen readers. Instead Schedule stays live and we validate on click:
  // an empty subject puts the input into an error state with the reason directly
  // beneath it (DESIGN §2, home ④), tied by aria-describedby and announced (role=alert).
  const subjectErrEl = document.getElementById("f-subject-error");
  function clearSubjectError() {
    document.getElementById("f-subject").classList.remove("is-invalid");
    if (subjectErrEl) {
      subjectErrEl.hidden = true;
    }
  }
  // Gates both send paths (the scheduled send and the in-modal Send now both open
  // from Schedule): true when a subject is present; otherwise shows the error, moves
  // focus to the field, and returns false so the modal never opens.
  function validateSubject() {
    const el = document.getElementById("f-subject");
    if (el.value.trim() === "") {
      el.classList.add("is-invalid");
      if (subjectErrEl) {
        subjectErrEl.hidden = false;
      }
      el.focus();
      return false;
    }
    clearSubjectError();
    return true;
  }

  // Auto-generate slug from subject. The slug stays editable throughout; the
  // checkbox reflects whether it's currently tracking the subject. Typing your
  // own slug takes manual control (unchecks); emptying the field, or ticking the
  // box, re-links and re-derives. The initial mode is inferred from the stored
  // slug, and an empty slug is never left behind.
  if (!locked) {
    const subjectEl = document.getElementById("f-subject");
    const slugEl = document.getElementById("f-slug");
    const autoEl = document.getElementById("f-slug-auto");
    const derive = () => clientSlugify(subjectEl.value);

    // Infer the starting mode: auto when the slug is empty, equals the derived
    // slug, or is a deduped variant of it (base-2, base-3, …). A hand-written
    // slug that has diverged starts as a custom (unchecked) slug.
    const base = derive();
    const v = slugEl.value.trim();
    autoEl.checked =
      v === "" || v === base || (base !== "" && new RegExp(`^${base}-\\d+$`).test(v));

    // Muted while it tracks the subject; normal color once it's a hand-set slug.
    const reflect = () => slugEl.classList.toggle("slug-auto", autoEl.checked);
    reflect();
    if (autoEl.checked && v === "") {
      slugEl.value = derive();
    }

    subjectEl.addEventListener("input", () => {
      if (autoEl.checked) {
        slugEl.value = derive();
      }
    });
    // Typing a slug takes manual control; clearing it re-links to the subject.
    slugEl.addEventListener("input", () => {
      autoEl.checked = slugEl.value.trim() === "";
      reflect();
    });
    // Ticking the box re-derives; unticking hands over the field ready to edit.
    autoEl.addEventListener("change", () => {
      reflect();
      if (autoEl.checked) {
        slugEl.value = derive();
      } else {
        slugEl.focus();
        slugEl.select();
      }
      markEdited(); // the checkbox mutates the slug without an input event
    });
    // Never leave an empty slug: on blur, fall back to the subject-derived one.
    slugEl.addEventListener("blur", () => {
      if (slugEl.value.trim() === "") {
        autoEl.checked = true;
        reflect();
        slugEl.value = derive();
        markEdited();
      }
    });

    // Clear the empty-subject error as soon as a real subject is typed; it re-fires
    // on the next Schedule click if the field is still empty (see validateSubject).
    subjectEl.addEventListener("input", () => {
      if (subjectEl.value.trim() !== "") {
        clearSubjectError();
      }
    });
  }

  // --- tabs ---
  const tabs = app.querySelectorAll(".ctab");
  function showTab(name) {
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle("active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
    });
    ta.hidden = name !== "write";
    previewFrame.hidden = name !== "preview";
    toolbarEl.classList.toggle("off", name !== "write");
  }
  async function showPreview() {
    showTab("preview");
    try {
      if (!locked) {
        await saveDraft(true);
      }
      previewFrame.srcdoc = await apiText(`/posts/${id}/preview`);
      previewFrame.onload = () => {
        try {
          previewFrame.style.height = `${previewFrame.contentDocument.body.scrollHeight + 24}px`;
        } catch (_) {}
      };
    } catch (e) {
      toast(e.message);
    }
  }
  tabs.forEach((t) => {
    t.onclick = () => (t.dataset.tab === "preview" ? showPreview() : showTab("write"));
  });

  // --- formatting toolbar ---
  function wrapSel(before, after, placeholder) {
    const s = ta.selectionStart,
      e = ta.selectionEnd,
      sel = ta.value.slice(s, e) || placeholder;
    ta.value = ta.value.slice(0, s) + before + sel + after + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = s + before.length;
    ta.selectionEnd = s + before.length + sel.length;
  }
  function prefixLines(prefix) {
    const s = ta.selectionStart,
      e = ta.selectionEnd,
      start = ta.value.lastIndexOf("\n", s - 1) + 1;
    const out = (ta.value.slice(start, e) || "")
      .split("\n")
      .map((l) => prefix + l)
      .join("\n");
    ta.value = ta.value.slice(0, start) + out + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = start;
    ta.selectionEnd = start + out.length;
  }
  function applyFormat(kind) {
    if (locked) {
      return;
    }
    showTab("write");
    if (kind === "bold") {
      wrapSel("**", "**", "bold text");
    } else if (kind === "italic") {
      wrapSel("*", "*", "italic text");
    } else if (kind === "heading") {
      prefixLines("## ");
    } else if (kind === "quote") {
      prefixLines("> ");
    } else if (kind === "ul") {
      prefixLines("- ");
    } else if (kind === "ol") {
      prefixLines("1. ");
    } else if (kind === "indent") {
      prefixLines("  ");
    } else if (kind === "link") {
      wrapSel("[", "](https://)", "link text");
    } else if (kind === "code") {
      const s = ta.selectionStart,
        e = ta.selectionEnd;
      if (s === e || ta.value.slice(s, e).includes("\n")) {
        wrapSel("```\n", "\n```", "code");
      } else {
        wrapSel("`", "`", "code");
      }
    }
    markEdited();
  }
  app.querySelectorAll(".tb[data-fmt]").forEach((b) => {
    b.onclick = () => applyFormat(b.dataset.fmt);
  });
  ta.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) {
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      applyFormat("bold");
    } else if (k === "i") {
      e.preventDefault();
      applyFormat("italic");
    } else if (k === "k") {
      e.preventDefault();
      applyFormat("link");
    }
  });

  // --- unsaved-changes tracking + save ---
  // A snapshot of the last-saved field values; the editor is "dirty" whenever the
  // current values differ. We reflect that in a save-status indicator beside the
  // button, guard navigation (at the router, via isEditorDirty), and autosave.
  editorHash = location.hash;
  const saveBtn = document.getElementById("saveBtn");
  const saveStatus = document.getElementById("saveStatus");
  const snapshot = () => JSON.stringify(collect());
  let savedSnapshot = snapshot();
  let saving = false;
  // The autosave editor's counterpart to the shared save bar's dot: same amber
  // "unsaved" cue (dot + text), extended to the autosave lifecycle it actually has —
  // Saving… while a save is in flight, Saved once it lands. Empty while locked
  // (a scheduled post can't be edited here).
  function renderSaveStatus() {
    if (!saveStatus) {
      return;
    }
    if (locked) {
      saveStatus.className = "save-status";
      saveStatus.textContent = "";
    } else if (saving) {
      saveStatus.className = "save-status is-saving";
      saveStatus.textContent = "Saving…";
    } else if (isEditorDirty) {
      saveStatus.className = "save-status is-dirty";
      saveStatus.textContent = "Unsaved changes";
    } else {
      saveStatus.className = "save-status is-saved";
      saveStatus.textContent = "Saved";
    }
  }
  function refreshDirty() {
    isEditorDirty = snapshot() !== savedSnapshot;
    renderSaveStatus();
  }
  renderSaveStatus(); // paint the initial state (Saved on a fresh draft; empty if locked)
  // Autosave: save after IDLE_MS of quiet, but never let an edit sit unsaved
  // longer than MAX_MS even during continuous typing (the idle timer keeps
  // resetting; the cap timer, started on the first edit after a save, does not).
  // Manual Save + ⌘S stays the primary path; this is the safety net.
  function scheduleAutosave() {
    if (autosaveIdleTimer) {
      clearTimeout(autosaveIdleTimer);
    }
    autosaveIdleTimer = setTimeout(runAutosave, IDLE_MS);
    if (!autosaveCapTimer) {
      autosaveCapTimer = setTimeout(runAutosave, MAX_MS);
    }
  }
  function runAutosave() {
    clearAutosaveTimers();
    saveDraft(true).catch((e) => toast(`Couldn't autosave — ${e.message}`)); // surface failures, never lose silently
  }
  // Called after any edit — typed, formatted, or an inserted image.
  function markEdited() {
    if (locked) {
      return;
    }
    refreshDirty();
    if (!editorConflict) {
      scheduleAutosave();
    }
  }

  // Saves are chained so an autosave and an explicit save can never overlap; a
  // silent save with nothing pending is skipped.
  let saveChain = Promise.resolve();
  function saveDraft(silent) {
    saveChain = saveChain.catch(() => {}).then(() => doSaveDraft(silent));
    return saveChain;
  }
  async function doSaveDraft(silent) {
    if (silent && snapshot() === savedSnapshot) {
      return null; // nothing changed since the last save
    }
    if (editorConflict) {
      return null; // paused until the out-of-date banner is resolved
    }
    clearAutosaveTimers(); // a save is starting — cancel any pending autosave trigger
    saving = true;
    renderSaveStatus(); // reflect Saving… right away; the finally re-renders when done
    try {
      const { post: u } = await api(`/posts/${id}`, {
        method: "PUT",
        json: { ...collect(), base_revision: baseRevision },
      });
      const slugEl = document.getElementById("f-slug");
      // Reflect server-side dedupe, but don't yank the slug from under the cursor
      // if an autosave lands while the field is focused.
      if (u?.slug && slugEl && document.activeElement !== slugEl) {
        slugEl.value = u.slug;
      }
      baseRevision = u.current_revision; // our save is now the newest; poll against it
      savedSnapshot = snapshot();
      editorSaveFailed = false;
      if (!silent) {
        toast("Saved");
      }
      return u;
    } catch (e) {
      // A stale-revision 409 isn't a plain failure: another writer got there first.
      // Surface the out-of-date banner (notify, don't clobber) instead of an error toast.
      if (e && e.status === 409) {
        showConflict(
          e.data && e.data.error === "stale_revision"
            ? { current_revision: e.data.current_revision, author: e.data.author }
            : { schedLocked: true },
        );
        return null;
      }
      editorSaveFailed = true; // the leave guard now prompts rather than silently flushing
      throw e;
    } finally {
      saving = false;
      refreshDirty();
    }
  }
  if (saveBtn) {
    saveBtn.onclick = () =>
      busy(saveBtn, "Saving…", () => saveDraft(false).catch((e) => toast(e.message))).finally(
        refreshDirty,
      );
  }

  // Leaving the editor saves in the background instead of prompting. Capture the
  // payload NOW (the router tears down the DOM right after) and send it through
  // the chain so it can't overlap an in-flight save.
  editorLeaveFlush = () => {
    clearAutosaveTimers();
    if (locked || snapshot() === savedSnapshot) {
      return;
    }
    const body = { ...collect(), base_revision: baseRevision };
    savedSnapshot = JSON.stringify(collect());
    isEditorDirty = false;
    saveChain = saveChain
      .catch(() => {})
      .then(() => api(`/posts/${id}`, { method: "PUT", json: body }))
      .catch((e) =>
        toast(
          e.status === 409
            ? "Changed elsewhere — your edits weren't saved"
            : `Couldn't save your changes — ${e.message}`,
        ),
      );
  };
  editorManualSave = () => {
    if (saveBtn && !saveBtn.disabled) {
      saveBtn.click();
    }
  };

  // Typed edits mark dirty; blurring subject/slug flushes promptly. The body is
  // left to the idle/cap timers so a toolbar click (which blurs it) doesn't save
  // on every interaction.
  if (!locked) {
    ["f-subject", "f-slug", "f-markdown"].forEach((k) => {
      document.getElementById(k).addEventListener("input", markEdited);
    });
    ["f-subject", "f-slug"].forEach((k) => {
      document
        .getElementById(k)
        .addEventListener("blur", () =>
          saveDraft(true).catch((e) => toast(`Couldn't save — ${e.message}`)),
        );
    });
  }

  // --- concurrent-edit detection (SPEC §4) ---
  // Another tab, or Claude through the API, can save this draft while it's open
  // here. A save carries base_revision so the server rejects a stale write (409);
  // a light poll warns before the writer invests more effort. We notify, never
  // adopt: Reload takes the other version, Keep editing keeps yours (your next
  // save overwrites it). Re-arm only on a genuinely newer revision.
  const freshnessEl = document.getElementById("freshnessBanner");
  const friendlyAuthor = (a) => (a === "service" ? "Claude" : a || null);

  function clearConflict() {
    editorConflict = false;
    warnedRevision = null;
    if (freshnessEl) {
      freshnessEl.hidden = true;
      freshnessEl.innerHTML = "";
    }
  }
  function showConflict(info) {
    if (!freshnessEl || locked) {
      return;
    }
    editorConflict = true; // pauses autosave; makes the leave guard prompt
    if (info.schedLocked) {
      freshnessEl.innerHTML = `<span><span aria-hidden="true">⚠️</span> This draft was scheduled elsewhere and can no longer be edited here.</span><span class="row"><button type="button" class="ghost" id="freshReload">Reload</button></span>`;
    } else {
      warnedRevision = info.current_revision;
      const who = friendlyAuthor(info.author);
      freshnessEl.innerHTML =
        `<span><span aria-hidden="true">⚠️</span> This draft was changed elsewhere${who ? ` — last edited by <strong>${esc(who)}</strong>` : ""}. Reload to load that version (discards your unsaved edits), or keep editing to overwrite it on your next save.</span>` +
        `<span class="row"><button type="button" class="ghost" id="freshReload">Reload</button><button type="button" class="ghost" id="freshKeep">Keep editing</button></span>`;
    }
    freshnessEl.hidden = false;
    freshnessEl.querySelector("#freshReload").onclick = () => {
      clearConflict();
      renderEditor(id);
    };
    const keep = freshnessEl.querySelector("#freshKeep");
    if (keep) {
      keep.onclick = () => {
        baseRevision = warnedRevision; // adopt the newer revision as our base — our next save wins
        clearConflict();
        refreshDirty();
        if (isEditorDirty) {
          scheduleAutosave();
        }
      };
    }
  }

  if (!locked) {
    // Skipped while hidden, saving, or already warned — poll GET is cheap and only
    // re-warns on a revision we haven't surfaced yet.
    const pollFreshness = async () => {
      if (saving || editorConflict || document.hidden) {
        return;
      }
      const baseAtRequest = baseRevision; // guard against our own save landing mid-poll
      try {
        const data = await api(`/posts/${id}`);
        // If our own save advanced the base while this GET was in flight, the response
        // may predate it — don't mistake our write for someone else's.
        if (saving || baseRevision !== baseAtRequest) {
          return;
        }
        if (data.post.status !== "draft") {
          showConflict({ schedLocked: true });
          return;
        }
        const rev = data.post.current_revision;
        if (rev && rev !== baseRevision && rev !== warnedRevision) {
          showConflict({ current_revision: rev, author: data.author });
        }
      } catch (_) {
        /* transient — try again next tick */
      }
    };
    editorPollTimer = setInterval(pollFreshness, 10000);
  } else {
    // A scheduled post is soft-locked here (read-only, showing the scheduled banner). If its
    // send FIRES while the editor is open, it's no longer a cancelable scheduled draft — it's
    // an active send — so redirect to the live watch, the same as opening it fresh would
    // (#162). Likewise jump to the record if it finishes while we're sitting here.
    const pollSchedule = async () => {
      if (document.hidden) {
        return;
      }
      try {
        const data = await api(`/posts/${id}`);
        if (data.sending) {
          location.hash = `#/sent/${data.sending.id}`;
        } else if (data.post.status === "sent") {
          location.hash = data.sent ? `#/sent/${data.sent.id}` : "#/sent";
        }
      } catch (_) {
        /* transient — try again next tick */
      }
    };
    editorPollTimer = setInterval(pollSchedule, 10000);
  }

  // --- open in browser ---
  const openBtn = document.getElementById("openBtn");
  openBtn.onclick = () =>
    busy(openBtn, "Opening…", async () => {
      try {
        if (!locked) {
          await saveDraft(true);
        }
        const html = await apiText(`/posts/${id}/preview`);
        const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) {
        toast(e.message);
      }
    });

  // --- cancel schedule (from the scheduled banner) ---
  const cancelScheduleBtn = document.getElementById("cancelSchedule");
  if (cancelScheduleBtn && scheduled) {
    cancelScheduleBtn.onclick = () =>
      busy(cancelScheduleBtn, "Canceling…", async () => {
        try {
          await api(`/sends/${scheduled.id}/cancel`, { method: "POST" });
          toast("Schedule canceled");
          renderEditor(id);
        } catch (e) {
          toast(e.message);
        }
      });
  }

  // --- image upload: drag/drop, paste, click ---
  async function uploadAndInsert(file) {
    if (!file?.type.startsWith("image/")) {
      return;
    }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { image } = await api(`/posts/${id}/images`, { method: "POST", body: fd });
      const s = ta.selectionStart,
        snippet = `\n![${file.name}](${image.filename})\n`;
      ta.value = ta.value.slice(0, s) + snippet + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s + snippet.length;
      markEdited();
      toast("Image added");
    } catch (e) {
      toast(e.message);
    }
  }
  if (!locked) {
    const body = document.getElementById("composerBody"),
      imgInput = document.getElementById("imgInput"),
      foot = document.getElementById("dropFoot");
    body.addEventListener("dragover", (e) => {
      e.preventDefault();
      body.classList.add("dragover");
    });
    body.addEventListener("dragleave", (e) => {
      if (e.target === body) {
        body.classList.remove("dragover");
      }
    });
    body.addEventListener("drop", (e) => {
      e.preventDefault();
      body.classList.remove("dragover");
      showTab("write");
      for (const f of e.dataTransfer.files) {
        uploadAndInsert(f);
      }
    });
    ta.addEventListener("paste", (e) => {
      for (const it of e.clipboardData?.items || []) {
        if (it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) {
            e.preventDefault();
            uploadAndInsert(f);
          }
        }
      }
    });
    foot.onclick = () => imgInput.click();
    imgInput.onchange = () => {
      for (const f of imgInput.files) {
        uploadAndInsert(f);
      }
      imgInput.value = "";
    };
  }

  function showWarnings(ws) {
    document.getElementById("warnings").innerHTML = ws?.length
      ? `<div class="warnings"><strong>Warnings:</strong> ${ws.map(esc).join("; ")}</div>`
      : "";
  }

  // --- send test (modal) ---
  // Pre-fills from the default test recipients (Settings) and accepts
  // several — one per line. Each address is a separate test send through the same
  // per-recipient path as a real send (I5).
  document.getElementById("testBtn").onclick = () => {
    const m = modal(
      `<h3>Send a test</h3><p class="hint">Delivers the rendered email to real inboxes so you can check it in a client. One address per line.</p><label for="testTo">Recipients</label><textarea id="testTo" rows="3" placeholder="you@example.com"></textarea><p class="hint" id="testDefaultsHint" hidden></p><div class="actions"><button type="button" id="tCancel">Cancel</button><button type="button" class="primary" id="tGo">Send test</button></div>`,
    );
    const to = m.el.querySelector("#testTo");
    to.focus();
    // Pre-fill with saved defaults (don't clobber anything already typed).
    api("/api/settings")
      .then((s) => {
        const defaults = s?.settings?.testRecipients || [];
        if (defaults.length && !to.value.trim()) {
          to.value = defaults.join("\n");
          const hint = m.el.querySelector("#testDefaultsHint");
          hint.textContent = "Pre-filled from your default test recipients (Settings).";
          hint.hidden = false;
        }
      })
      .catch(() => {});
    m.el.querySelector("#tCancel").onclick = m.close;
    m.el.querySelector("#tGo").onclick = () =>
      busy(m.el.querySelector("#tGo"), "Sending…", async () => {
        const addrs = parseAddresses(to.value);
        if (!addrs.length) {
          toast("Enter at least one email address");
          return;
        }
        try {
          if (!locked) {
            await saveDraft(true);
          }
          let sent = 0;
          let lastWarnings = null;
          for (const addr of addrs) {
            const r = await api(`/posts/${id}/test`, { method: "POST", json: { to: addr } });
            if (r.sent) {
              sent++;
            }
            lastWarnings = r.warnings;
          }
          showWarnings(lastWarnings);
          m.close();
          toast(
            withNoProviderNote(
              sent === addrs.length
                ? `Test sent to ${sent} address${sent === 1 ? "" : "es"}`
                : `Sent ${sent}/${addrs.length} — some failed`,
            ),
          );
        } catch (e) {
          toast(e.message);
        }
      });
  };

  // --- schedule (the one send entry point; Send now lives inside as a demoted link) ---
  // Scheduling behind a cancelable review window is the literal default (SPEC §6);
  // sending immediately is the deliberate sub-choice. Both server flows are unchanged
  // (/schedule, /send) — this is one modal with two views, so the safer path is what
  // the Primary opens and the louder one is a step down.
  const scheduleBtn = document.getElementById("scheduleBtn");
  if (scheduleBtn) {
    scheduleBtn.onclick = () => {
      if (!validateSubject()) {
        return; // empty subject: the field-level error is now showing; don't open the modal
      }
      const minStr = toLocalInput(new Date(Date.now() + 6 * 60000));
      const def = toLocalInput(new Date(Date.now() + 24 * 3600 * 1000));
      const scheduleView =
        `<h3 id="schHead">Schedule this issue</h3><p class="hint">It sends at the time you pick (at least 5 minutes out), with a cancelable window until then.</p><label for="schWhen">Send at</label><input type="datetime-local" id="schWhen" min="${minStr}" value="${def}">` +
        `<div class="actions"><button type="button" id="schCancel">Cancel</button><button type="button" class="primary" id="schGo">Schedule</button></div>` +
        `<div class="altrow"><span class="altrow-note">Skip the review window?</span><button type="button" class="linkbtn" id="toSendNow">Send now →</button></div>`;
      const m = modal(scheduleView);
      const box = m.el.querySelector(".modal");

      const doSchedule = () =>
        busy(box.querySelector("#schGo"), "Scheduling…", async () => {
          const v = box.querySelector("#schWhen").value;
          const t = v ? new Date(v).getTime() : NaN;
          if (Number.isNaN(t)) {
            toast("Pick a valid date & time");
            return;
          }
          try {
            await saveDraft(true);
            await api(`/posts/${id}/schedule`, {
              method: "POST",
              json: { fire_at: new Date(t).toISOString() },
            });
            m.close();
            toast(withNoProviderNote("Scheduled"));
            location.hash = "#/sent";
          } catch (e) {
            toast(e.message);
          }
        });

      const doSendNow = () =>
        busy(box.querySelector("#snGo"), "Queuing…", async () => {
          try {
            await saveDraft(true);
            await api(`/posts/${id}/send`, { method: "POST" });
            m.close();
            toast(withNoProviderNote("Queued — cancelable for 5 minutes"));
            location.hash = "#/sent";
          } catch (e) {
            toast(e.message);
          }
        });

      function wireSchedule() {
        box.setAttribute("aria-labelledby", "schHead");
        box.querySelector("#schCancel").onclick = m.close;
        box.querySelector("#schGo").onclick = doSchedule;
        box.querySelector("#toSendNow").onclick = showSendNow;
        box.querySelector("#schWhen").focus();
      }

      async function showSendNow() {
        box.innerHTML =
          `<h3 id="snHead">Send now?</h3><p class="hint">Freezes the current draft and sends it to <strong id="snWho">your confirmed subscribers</strong> after a 5-minute cancelable window. You can cancel from Status until it fires.</p>` +
          `<div class="altrow altrow-top"><button type="button" class="linkbtn" id="toSchedule">← Back to schedule</button></div>` +
          `<div class="actions"><button type="button" id="snCancel">Cancel</button><button type="button" class="primary" id="snGo">Send now</button></div>`;
        box.setAttribute("aria-labelledby", "snHead");
        box.querySelector("#snCancel").onclick = m.close;
        box.querySelector("#snGo").onclick = doSendNow;
        box.querySelector("#toSchedule").onclick = () => {
          box.innerHTML = scheduleView;
          wireSchedule();
        };
        box.querySelector("#snGo").focus();
        // Fill the real confirmed-subscriber count once known; the copy reads sensibly until then.
        try {
          const s = await api("/subscribers");
          const n = s.counts.confirmed;
          const whoEl = box.querySelector("#snWho");
          if (whoEl) {
            whoEl.textContent = `${n} confirmed subscriber${n === 1 ? "" : "s"}`;
          }
        } catch (_) {}
      }

      wireSchedule();
    };
  }
}

// ---- sends ----
function startCountdowns() {
  // Clear any prior interval first: reloadAll() re-runs loadScheduled (and this) on
  // every cancel/resolve, so without this each refresh would leak a 1s interval.
  if (statusTimer) {
    clearInterval(statusTimer);
  }
  const tick = () =>
    document.querySelectorAll("[data-fire]").forEach((el) => {
      el.textContent = untilStr(Number(el.dataset.fire));
    });
  tick();
  statusTimer = setInterval(tick, 1000);
}

// A send wedged on ambiguous in-flight rows: still `sending`, nothing left pending,
// but one or more in-flight recipients whose fate a transport error left unknown
// (SPEC §11). This is the state the sweep flags and the operator must adjudicate; it
// can't clear on its own without risking a double-mail (I4). Read straight off the row's
// denormalized counters (c_pending / c_in_flight, migration 0006) — the same signals the
// server's buildSendProgress derives `wedged` from, so the list and the watch agree.
// The lease check is essential: while the loop is ACTIVELY working a send it holds the
// lease (`locked_until` in the future) — so a normal send's final dispatched batch
// (pending 0, in flight > 0) is not a wedge, just work in progress. A genuine wedge has
// released the lease. Without this, every send briefly flashed "needs attention" at the
// tail of its dispatch.
function isWedged(s) {
  const leaseHeld = s.locked_until != null && s.locked_until > Date.now();
  return s.status === "sending" && !(s.c_pending || 0) && (s.c_in_flight || 0) > 0 && !leaseHeld;
}

// The one manual step for a wedged send: decide whether the ambiguous batch went out
// or not. Both outcomes are safe for I4 — neither re-mails this issue — so the modal
// explains the trade-off (record accuracy) rather than warning of a double-send.
function openResolveModal(send, reload) {
  const n = send.c_in_flight || 0;
  const noun = n === 1 ? "delivery" : "deliveries";
  const m = modal(
    `<h3>Resolve ${n} ambiguous ${noun}</h3>` +
      `<p class="hint">A transport error left ${n} recipient${n === 1 ? "" : "s"} in flight: the request went out but the provider never confirmed, so we can't know if it was accepted. To avoid mailing anyone twice, the send won't retry ${n === 1 ? "it" : "them"} on its own — so it can't finish until you decide. Neither choice re-sends this issue.</p>` +
      `<p class="hint"><strong>Assume not sent</strong> — recorded as failed; ${n === 1 ? "the address is" : "the addresses are"} simply picked up by your next issue.</p>` +
      `<p class="hint"><strong>Assume sent</strong> — recorded as delivered. Choose this only if you've confirmed it in your provider's console.</p>` +
      `<div class="actions"><button type="button" id="rCancel">Cancel</button><button type="button" id="rFailed">Assume not sent</button><button type="button" class="primary" id="rAccepted">Assume sent</button></div>`,
  );
  m.el.querySelector("#rCancel").onclick = m.close;
  const doResolve = (btn, resolution, verb) =>
    busy(btn, "Resolving…", async () => {
      try {
        const res = await api(`/sends/${send.id}/resolve`, {
          method: "POST",
          json: { resolution },
        });
        m.close();
        toast(res.completed ? "Send completed" : `Marked ${verb}`);
        reload();
      } catch (e) {
        toast(e.message);
      }
    });
  m.el.querySelector("#rFailed").onclick = (e) => doResolve(e.target, "failed", "not sent");
  m.el.querySelector("#rAccepted").onclick = (e) => doResolve(e.target, "accepted", "sent");
}

// Dispatch/delivery numbers from a `/sends` list row's denormalized counters (SEND_LIST_COLS),
// so the active-send row and the dashboard widget need no per-send /progress read. `done`
// is the dispatch fraction (accepted vs the frozen total), matching the watch's dispatch bar.
function listRowCounts(s) {
  const total =
    (s.c_pending || 0) +
    (s.c_in_flight || 0) +
    (s.c_accepted || 0) +
    (s.c_delivered || 0) +
    (s.c_bounced || 0) +
    (s.c_complained || 0) +
    (s.c_skipped || 0) +
    (s.c_failed || 0);
  const t = total > 0 ? total : s.recipient_count || 0;
  const done =
    (s.c_accepted || 0) + (s.c_delivered || 0) + (s.c_bounced || 0) + (s.c_complained || 0);
  const confirmed = (s.c_delivered || 0) + (s.c_bounced || 0) + (s.c_complained || 0);
  const pct = t > 0 ? Math.round((100 * done) / t) : 0;
  // Rough ETA from the average rate since the send started — the same cumulative
  // estimate /progress reports, computed here off the list row so no extra read is needed.
  let etaMs = null;
  if (s.started_at && done > 0 && t > done) {
    const elapsed = Date.now() - s.started_at;
    if (elapsed > 0) {
      etaMs = ((t - done) * elapsed) / done;
    }
  }
  return { total: t, accepted: done, confirmed, pct, etaMs };
}

// A `/sends` list row's "Delivered" cell, from its denormalized counters (#90). It reports
// TRUE delivered — webhook-confirmed `c_delivered`, not provider-`accepted` — so the Sent
// list and dashboard recent-sends agree with the record view's "Delivered" for the same
// send, and a bounced/complained recipient is never miscounted as delivered. Any bounce /
// complaint / send-time-failure shows as a muted trouble suffix, so a bad send reads as
// trouble at a glance instead of a clean number. `deliveries` stays the source of truth.
function deliveredCell(s) {
  const delivered = s.c_delivered || 0;
  const notes = [];
  if (s.c_bounced) {
    notes.push(`${(s.c_bounced || 0).toLocaleString()} bounced`);
  }
  if (s.c_complained) {
    notes.push(`${(s.c_complained || 0).toLocaleString()} complained`);
  }
  if (s.c_failed) {
    notes.push(`${(s.c_failed || 0).toLocaleString()} failed`);
  }
  const suffix = notes.length ? ` <span class="muted">(${notes.join(", ")})</span>` : "";
  return `${delivered.toLocaleString()}${suffix}`;
}
// One in-progress send as a card with a live mini dispatch bar, an ETA, and a Watch link.
// The whole card opens the watch; the "Watch" link is the keyboard/middle-click target.
function activeRowHtml(s) {
  const c = listRowCounts(s);
  const eta = c.etaMs != null ? ` · ~${fmtDuration(c.etaMs)} left` : "";
  return `<div class="card spread clickable active-card" data-watch="${s.id}">
      <div class="active-main">
        <a class="card-link active-subj" href="#/sent/${s.id}">${esc(s.subject) || "<em>untitled</em>"}</a>
        <div class="active-bar"><div class="active-fill" style="width:${clampPct(c.pct)}%"></div></div>
        <div class="muted active-stat">Sending — ${c.accepted.toLocaleString()} of ${c.total.toLocaleString()} accepted${
          c.confirmed ? ` · ${c.confirmed.toLocaleString()} confirmed` : ""
        }${eta}</div>
      </div>
      <a class="ghost-link" href="#/sent/${s.id}">Watch&nbsp;→</a>
    </div>`;
}

async function renderSent() {
  // The dispatch side (#147): the still-cancelable Scheduled queue on top, then the
  // frozen Sent records. The table is sent-only, so it carries no status column or
  // filter; default sort = fire desc so the "When" header shows its arrow from the start.
  const state = { status: "sent", search: "", sort: "fire", dir: "desc", offset: 0, limit: 50 };
  app.innerHTML = `<h1>Sent</h1>
    ${noEmailProvider() ? `<p class="muted">No email provider is configured, so these sends are recorded here but nothing is delivered.</p>` : ""}
    <div id="stuck"></div>
    <h2>Scheduled</h2><div id="scheduled" class="muted">Loading…</div>
    <div id="active"></div>
    <h2>Sent issues</h2>
    ${listToolbar({ searchPlaceholder: "Search subject…" })}
    <div id="sendsList" class="muted">Loading…</div>
    <div id="sendsPager"></div>`;
  const stuckEl = document.getElementById("stuck");
  const schedEl = document.getElementById("scheduled");
  const activeEl = document.getElementById("active");
  const listEl = document.getElementById("sendsList");
  const pagerEl = document.getElementById("sendsPager");

  // Resolving a wedged send or canceling a scheduled one touches several sections at
  // once, so refresh them together.
  function reloadAll() {
    loadScheduled();
    loadList();
    refreshSending();
  }

  // The in-flight set drives two sections — the wedged attention block (§11) and the
  // in-progress active rows (#154) — so one fetch renders both. Tracking the set's
  // signature lets us tell a real transition (a send fired or finished) from a mere bar
  // advance: on a transition we also refresh the scheduled queue (it lost this send) and
  // the sent list (it gained it), so a fired issue leaves the scheduled slot and lands in
  // the records without a manual reload. Polled every 3s (matching the watch + dashboard).
  let sentActiveSig = "";
  function renderActive(sends) {
    const active = sends.filter((s) => !isWedged(s));
    activeEl.innerHTML = active.length
      ? `<h2>In progress</h2>${active.map(activeRowHtml).join("")}`
      : "";
    activeEl.querySelectorAll("[data-watch]").forEach((card) => {
      card.onclick = (e) => {
        if (e.target.tagName !== "A") {
          location.hash = `#/sent/${card.dataset.watch}`;
        }
      };
    });
  }
  function renderStuck(sends) {
    const wedged = sends.filter(isWedged);
    stuckEl.innerHTML = wedged
      .map((s) => {
        const n = s.c_in_flight || 0;
        const noun = n === 1 ? "delivery" : "deliveries";
        return `<div class="card stuck-card"><div class="stuck-head"><span class="stuck-dot">⚠️</span><div><strong>${esc(s.subject)}</strong><div class="muted">${n} ambiguous ${noun} — this send can't finish until you resolve ${n === 1 ? "it" : "them"}.</div></div></div><button class="primary" data-resolve="${s.id}">Resolve…</button></div>`;
      })
      .join("");
    stuckEl.querySelectorAll("[data-resolve]").forEach((b) => {
      const s = wedged.find((x) => x.id === b.dataset.resolve);
      b.onclick = () => openResolveModal(s, reloadAll);
    });
  }
  async function refreshSending() {
    let sends;
    try {
      ({ sends } = await api("/sends?status=sending&limit=200"));
    } catch {
      // Non-fatal: the in-flight sections just stay empty if this probe fails.
      stuckEl.innerHTML = "";
      activeEl.innerHTML = "";
      return;
    }
    renderStuck(sends);
    renderActive(sends);
    const sig = sends
      .map((s) => s.id)
      .sort()
      .join(",");
    if (sig !== sentActiveSig) {
      sentActiveSig = sig;
      loadScheduled(); // a fired send left the queue; the next one moves up
      loadList(); // a finished send joins the records
    }
  }

  // The upcoming queue, soonest-first — the next send to fire (and the one you'd reach
  // for the cancel window on) sits at the top. Fetched on its own so it shows every
  // scheduled send regardless of the table's paging/filter below.
  async function loadScheduled() {
    try {
      const { sends } = await api("/sends?status=scheduled&sort=fire&dir=asc&limit=200");
      const schedCard = (s) =>
        `<div class="card spread clickable sched-card" data-post="${s.post_id}"><div><a class="card-link sched-subj" href="#/edit/${s.post_id}">${esc(s.subject)}</a><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div><button class="ghost" data-cancel="${s.id}">Cancel</button></div>`;
      if (!sends.length) {
        schedEl.innerHTML = `<p class="muted">Nothing scheduled.</p>`;
      } else {
        // Show only the soonest to send, so the sent records stay near the top of the
        // page; any others collapse behind a "Show all" toggle (usually there are none —
        // a post has at most one active send).
        const [first, ...rest] = sends;
        schedEl.innerHTML =
          schedCard(first) +
          (rest.length
            ? `<div id="schedMore" hidden>${rest.map(schedCard).join("")}</div><button type="button" class="ghost sched-toggle" id="schedToggle" aria-expanded="false">Show all ${sends.length} scheduled</button>`
            : "");
        const toggle = schedEl.querySelector("#schedToggle");
        if (toggle) {
          toggle.onclick = () => {
            const more = schedEl.querySelector("#schedMore");
            const show = more.hidden;
            more.hidden = !show;
            toggle.setAttribute("aria-expanded", String(show));
            toggle.textContent = show ? "Show fewer" : `Show all ${sends.length} scheduled`;
          };
        }
      }
      // The whole card opens the issue; the subject link handles keyboard/middle-click,
      // and Cancel opts out of navigation (like the posts table's row-click guard).
      schedEl.querySelectorAll(".card.clickable").forEach((card) => {
        card.onclick = (e) => {
          if (e.target.tagName !== "A" && !e.target.closest("[data-cancel]")) {
            location.hash = `#/edit/${card.dataset.post}`;
          }
        };
      });
      schedEl.querySelectorAll("[data-cancel]").forEach((b) => {
        b.onclick = () =>
          busy(b, "Canceling…", async () => {
            try {
              await api(`/sends/${b.dataset.cancel}/cancel`, { method: "POST" });
              toast("Canceled");
              // A cancel drops it from the queue and flips it to canceled in the table.
              reloadAll();
            } catch (e) {
              toast(e.message);
            }
          });
      });
      startCountdowns();
    } catch (e) {
      renderError(schedEl, e.message, loadScheduled);
    }
  }

  // The frozen Sent records — every completed issue, each opening its read-only record
  // view (#148). Sent-only, so no status column; the "When" is the send's completion.
  async function loadList() {
    try {
      const data = await api(`/sends?${listQuery(state)}`);
      const sends = data.sends;
      if (!sends.length) {
        listEl.innerHTML = `<p class="muted">${
          state.search ? "No sent issues match." : "No sent issues yet."
        }</p>`;
        pagerEl.innerHTML = "";
        return;
      }
      listEl.innerHTML = `<div class="table-wrap"><table class="list-table"><colgroup><col><col class="c-date"><col class="c-num"><col class="c-num"></colgroup><thead><tr>${th("Subject", "subject", state)}${th("When", "fire", state)}${th("Recipients", "recipients", state, "num")}<th class="num">Delivered</th></tr></thead><tbody>${sends
        .map(
          (s) =>
            `<tr class="clickable" data-id="${s.id}"><td><a href="#/sent/${s.id}">${esc(s.subject)}</a></td><td class="muted">${fmt(s.completed_at ?? s.fire_at)}</td><td class="num">${s.recipient_count}</td><td class="num">${deliveredCell(s)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
      wireSort(listEl, state, loadList);
      // The whole row opens the record; the subject link handles keyboard/middle-click.
      listEl.querySelectorAll("tr[data-id]").forEach((tr) => {
        tr.onclick = (e) => {
          if (e.target.tagName !== "A") {
            location.hash = `#/sent/${tr.dataset.id}`;
          }
        };
      });
      renderPager(pagerEl, state, data.page, loadList);
    } catch (e) {
      renderError(listEl, e.message, loadList);
    }
  }

  wireToolbar(app, state, loadList);
  reloadAll();
  // Poll the in-flight sections every 3s (matching the watch + dashboard): the active
  // bar advances, and a fired/finished send moves through the queue → in-progress →
  // records on its own. A recursive setTimeout so a slow read never overlaps; cleared on
  // navigation (route() clears progressTimer). Countdowns run on statusTimer.
  const scheduleSentPoll = () => {
    const gen = navGeneration;
    progressTimer = setTimeout(async () => {
      await refreshSending();
      // Navigated off the Sent page mid-fetch — the sections refreshSending paints are gone and
      // the reschedule would leak onto the new view's poll timer. Bail (see navGeneration).
      if (gen !== navGeneration) {
        return;
      }
      scheduleSentPoll();
    }, 3000);
  };
  scheduleSentPoll();
}

// ---- sent record view (#148) + live in-flight watch (#154) ----
// A sent issue is a frozen record (I3), not an editable object, so it opens this instead
// of a locked editor: how the send went over the frozen audience, with a link to the
// archived issue. A send still IN FLIGHT opens the live watch — two bars (dispatch, and
// the lagging delivery), a derived phase, a counts grid, throughput, and a provider-
// health strip — polling /progress until dispatch completes, after which the record keeps
// absorbing delivery receipts as they settle (SPEC §6/§8/§11).
async function renderSentRecord(id) {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let data;
  try {
    data = await api(`/sends/${id}`);
  } catch (e) {
    renderError(app, e.message, () => renderSentRecord(id));
    return;
  }
  const { send } = data;

  // A scheduled send is still cancel-to-edit — its home is the editor, not this record.
  if (send.status === "scheduled") {
    location.hash = `#/edit/${send.post_id}`;
    return;
  }
  // A send still in flight opens the live watch, which polls /progress.
  if (send.status === "sending") {
    return startWatch(id, send);
  }
  return renderFrozenRecord(id, data);
}

// Phase → { label, tone } for the derived-phase pill. Tones reuse the status/semantic
// palettes: sending = blue (the in-flight treatment, DESIGN §3), ok = green, warn/danger
// as usual, scheduled = violet.
const PHASE_META = {
  scheduled: { label: "Scheduled", tone: "scheduled" },
  progressing: { label: "Sending", tone: "sending" },
  retrying: { label: "Retrying", tone: "warn" },
  "backing-off": { label: "Backing off", tone: "warn" },
  "needs-attention": { label: "Needs attention", tone: "danger" },
  settling: { label: "Settling", tone: "sending" },
  complete: { label: "Complete", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  canceled: { label: "Canceled", tone: "muted" },
};
const PHASE_BLURB = {
  progressing: "Handing recipients to the provider.",
  retrying: "Some recipients hit a transient error and will be retried.",
  "backing-off": "Paused between ticks — it resumes on the next sweep.",
  "needs-attention": "Some deliveries are stuck and need a decision.",
  settling: "Dispatch complete — waiting on delivery receipts.",
};
function phasePill(phase) {
  const m = PHASE_META[phase] || { label: phase, tone: "muted" };
  return `<span class="phase-pill tone-${m.tone}">${esc(m.label)}</span>`;
}
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n || 0)));
// A labeled progress bar: `tone` picks the fill color, `sub` is a muted sub-line.
function progressBar(tone, label, value, total, sub) {
  const p = total > 0 ? clampPct((100 * value) / total) : 0;
  return `<div class="wbar-row">
      <div class="wbar-head"><span class="wbar-label">${label}</span><span class="wbar-count">${value.toLocaleString()} / ${total.toLocaleString()}</span></div>
      <div class="wbar" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><div class="wbar-fill tone-${tone}" style="width:${p}%"></div></div>
      ${sub ? `<div class="wbar-sub muted">${sub}</div>` : ""}
    </div>`;
}
// The delivery bar shares the dispatch bar's scale (denominator = the whole audience), so
// the two pair up: a grey `accepted` segment tracks the exact frontier the dispatch bar
// reaches, and green fills in behind it as receipts confirm. Green can never pass grey, so
// delivery visibly LAGS dispatch instead of racing ahead of it (which it did when the two
// bars used different denominators).
function deliveryBar(label, confirmed, accepted, total, sub) {
  const acceptedPct = total > 0 ? clampPct((100 * accepted) / total) : 0;
  const confirmedPct = total > 0 ? clampPct((100 * confirmed) / total) : 0;
  return `<div class="wbar-row">
      <div class="wbar-head"><span class="wbar-label">${label}</span><span class="wbar-count">${confirmed.toLocaleString()} of ${accepted.toLocaleString()} accepted</span></div>
      <div class="wbar dual" role="progressbar" aria-valuenow="${confirmedPct}" aria-valuemin="0" aria-valuemax="100">
        <div class="wbar-fill tone-accepted" style="width:${acceptedPct}%"></div>
        <div class="wbar-fill tone-ok" style="width:${confirmedPct}%"></div>
      </div>
      ${sub ? `<div class="wbar-sub muted">${sub}</div>` : ""}
    </div>`;
}
function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  const s = Math.round(ms / 1000);
  if (s < 90) {
    return `${s}s`;
  }
  const m = Math.round(s / 60);
  if (m < 90) {
    return `${m} min`;
  }
  return `${Math.round(m / 60)} hr`;
}

// The counts grid mirrors the eight denormalized buckets; each swatch reuses the record
// tile palette so a bucket reads the same here and on the frozen record.
const WATCH_COUNTS = [
  { key: "pending", label: "Pending", sw: "neutral" },
  { key: "in_flight", label: "In flight", sw: "sending" },
  { key: "accepted", label: "Accepted", sw: "sending" },
  { key: "delivered", label: "Delivered", sw: "ok" },
  { key: "bounced", label: "Bounced", sw: "warn" },
  { key: "complained", label: "Complained", sw: "danger" },
  { key: "failed", label: "Failed", sw: "neutral" },
  { key: "skipped", label: "Skipped", sw: "neutral" },
];
function watchCountsHtml(counts) {
  return `<div class="wcounts">${WATCH_COUNTS.map(
    (c) =>
      `<div class="wcount"><div class="wcount-n">${(counts[c.key] || 0).toLocaleString()}</div><div class="wcount-l"><span class="rec-sw sw-${c.sw}"></span>${c.label}</div></div>`,
  ).join("")}</div>`;
}

// The dynamic half of the watch (bars + counts + health strip), repainted on each poll.
function watchBodyHtml(prog) {
  const c = prog.counts;
  const acceptedTotal = c.accepted + c.delivered + c.bounced + c.complained;
  const rate = prog.dispatch.rate_per_min;
  const dispatchSub =
    prog.state === "sending"
      ? `${PHASE_BLURB[prog.phase] || ""}${
          rate ? ` · ~${rate.toLocaleString()}/min · ETA ${fmtDuration(prog.dispatch.eta_ms)}` : ""
        }`
      : "Dispatch complete.";
  const trouble = (c.failed || 0) + (c.bounced || 0) + (c.complained || 0);
  const providerText = noEmailProvider()
    ? "No email provider configured — nothing is delivered"
    : `Provider: ${esc(prog.provider?.name || "—")}`;
  return `
    <div class="wbars">
      ${progressBar("sending", "Dispatch — provider-accepted", acceptedTotal, prog.total, dispatchSub)}
      ${deliveryBar(
        "Delivery — webhook-confirmed",
        prog.delivery.confirmed,
        acceptedTotal,
        prog.total,
        "Delivery lags acceptance — grey is accepted-but-unconfirmed, green fills in as receipts arrive.",
      )}
    </div>
    ${watchCountsHtml(c)}
    <div class="whealth${trouble ? " has-trouble" : ""}"><span class="whealth-dot"></span><span>${providerText} · ${
      trouble ? `${trouble.toLocaleString()} bounced / failed / complained` : "no delivery trouble"
    }</span></div>`;
}
function watchMetaHtml(send, prog) {
  const started = send.started_at ? `Started ${esc(fmt(send.started_at))}` : "Sending now";
  return `${started} · ${prog.total.toLocaleString()} recipients`;
}
function watchHtml(send, prog) {
  return `
    <div class="editor-head">
      <a href="#/sent" class="back">← Sent</a>
      ${prog.attention?.wedged ? `<button type="button" class="primary" id="resolveBtn">Resolve…</button>` : ""}
    </div>
    <div class="card rec-card watch-card">
      <div class="rec-head">
        <div class="watch-title"><h1>${esc(send.subject) || "<em>untitled</em>"}</h1><span id="watchPill">${phasePill(prog.phase)}</span></div>
        <div class="rec-meta" id="watchMeta">${watchMetaHtml(send, prog)}</div>
      </div>
      <div id="watchBody">${watchBodyHtml(prog)}</div>
      <p class="rec-note muted">This view updates live while the send is in flight. Delivery receipts keep arriving after dispatch finishes — the record stays accurate as they settle.</p>
    </div>`;
}

// Wire the header's Resolve control (present only when the send is wedged, §11). It
// reuses the same modal the Sent page uses, shimming the shape it reads.
function wireWatchHeader(id, send, prog) {
  const rb = document.getElementById("resolveBtn");
  if (rb) {
    rb.onclick = () =>
      openResolveModal({ id, subject: send.subject, c_in_flight: prog.counts.in_flight }, () =>
        renderSentRecord(id),
      );
  }
}
function paintWatch(send, prog) {
  const pill = document.getElementById("watchPill");
  if (pill) {
    pill.innerHTML = phasePill(prog.phase);
  }
  const meta = document.getElementById("watchMeta");
  if (meta) {
    meta.innerHTML = watchMetaHtml(send, prog);
  }
  const body = document.getElementById("watchBody");
  if (body) {
    body.innerHTML = watchBodyHtml(prog);
  }
}

async function startWatch(id, send) {
  let prog;
  try {
    prog = await api(`/sends/${id}/progress`);
  } catch (e) {
    renderError(app, e.message, () => renderSentRecord(id));
    return;
  }
  // It may have finished between the two reads — fall through to the frozen record.
  if (prog.state !== "sending") {
    return renderSentRecord(id);
  }
  app.innerHTML = watchHtml(send, prog);
  wireWatchHeader(id, send, prog);
  scheduleWatchPoll(id, send);
}

// Poll /progress (~3s) while sending; a recursive setTimeout so a slow read never
// overlaps. `progressTimer` holds the pending id so route() clears it on navigation.
function scheduleWatchPoll(id, send) {
  const gen = navGeneration;
  progressTimer = setTimeout(async () => {
    let prog;
    try {
      prog = await api(`/sends/${id}/progress`);
    } catch {
      // transient — keep the last view, try again (unless we've since navigated away)
      if (gen === navGeneration) {
        scheduleWatchPoll(id, send);
      }
      return;
    }
    // Navigated away while the fetch was in flight: the new view owns the screen and its own
    // poll now — don't renderSentRecord over it, swap it, or reschedule onto its timer.
    if (gen !== navGeneration) {
      return;
    }
    if (prog.state !== "sending") {
      progressTimer = null;
      return renderSentRecord(id); // dispatch done → the frozen record (which settles)
    }
    // If it just wedged, the header needs the Resolve control it didn't have — re-render.
    if (prog.attention?.wedged && !document.getElementById("resolveBtn")) {
      app.innerHTML = watchHtml(send, prog);
      wireWatchHeader(id, send, prog);
    } else {
      paintWatch(send, prog);
    }
    scheduleWatchPoll(id, send);
  }, 3000);
}

// The delivery-outcome tiles + reconciliation line — the frozen record's body, factored
// so the settling poll can repaint them in place as late receipts arrive.
function outcomeTilesHtml(outcomes) {
  const tiles = [
    { n: outcomes.recipients, label: "Recipients", cls: "", sw: "neutral" },
    { n: outcomes.delivered, label: "Delivered", cls: "ok", sw: "ok" },
    { n: outcomes.bounced, label: "Bounced", cls: "warn", sw: "warn" },
    { n: outcomes.complained, label: "Complained", cls: "danger", sw: "danger" },
    { n: outcomes.failed, label: "Failed", cls: "", sw: "neutral" },
  ];
  return tiles
    .map(
      (t) =>
        `<div class="rec-tile"><div class="rec-n ${t.cls}">${t.n.toLocaleString()}</div><div class="rec-l"><span class="rec-sw sw-${t.sw}"></span>${t.label}</div></div>`,
    )
    .join("");
}
function outcomeReconHtml(outcomes) {
  const total = outcomes.recipients;
  const residual = outcomes.accepted + outcomes.skipped + outcomes.in_flight;
  const parts = [`${outcomes.delivered.toLocaleString()} delivered`];
  if (outcomes.bounced) {
    parts.push(`${outcomes.bounced.toLocaleString()} bounced`);
  }
  if (outcomes.complained) {
    parts.push(`${outcomes.complained.toLocaleString()} complained`);
  }
  if (outcomes.failed) {
    parts.push(`${outcomes.failed.toLocaleString()} failed`);
  }
  if (residual) {
    parts.push(`${residual.toLocaleString()} accepted, awaiting a delivery receipt`);
  }
  return `All ${total.toLocaleString()} accounted for: ${parts.join(", ")}. Bounces and complaints have already suppressed those addresses.`;
}

// The per-recipient record (#164): the outcome tiles summarize, this shows the actual
// rows. A row's OUTCOME is derived from the same two facts the tiles bucket — the webhook
// `event` winning over the send-loop `status` — so a row reads the same bucket (and reuses
// the same swatch palette) as its tile. A bounce splits soft vs hard on the durable signal
// the spec defines the split by: a hard bounce suppressed the address, a soft one didn't.
function deliveryOutcome(r) {
  if (r.event === "delivered") {
    return { label: "Delivered", sw: "ok" };
  }
  if (r.event === "bounced") {
    const hard = r.suppressed && r.suppressed_reason === "bounce";
    return hard
      ? { label: "Hard bounce", sw: "warn", hint: "suppressed" }
      : { label: "Soft bounce", sw: "warn", hint: "counted, not suppressed" };
  }
  if (r.event === "complained") {
    return { label: "Complained", sw: "danger", hint: "suppressed" };
  }
  switch (r.status) {
    case "failed":
      return { label: "Failed", sw: "neutral" };
    case "skipped":
      return { label: "Skipped", sw: "neutral" };
    case "accepted":
      return { label: "Accepted", sw: "sending", hint: "awaiting a delivery receipt" };
    default:
      return { label: "In flight", sw: "sending" };
  }
}

// The three view tabs the record opens on — issues first (the rows that went wrong).
const DELIVERY_VIEWS = [
  { v: "issues", label: "Issues" },
  { v: "delivered", label: "Delivered" },
  { v: "all", label: "All" },
];

// A positive/neutral empty state per view — an empty "issues" list is good news, not a gap.
function deliveryEmpty(dstate) {
  if (dstate.search) {
    return "No recipients match that address.";
  }
  if (dstate.view === "issues") {
    return "No delivery issues — every recipient was accepted or delivered.";
  }
  if (dstate.view === "delivered") {
    return "No delivery receipts confirmed yet.";
  }
  return "No recipients on this send.";
}

function recordDeliveryQuery(d) {
  const p = new URLSearchParams();
  p.set("view", d.view);
  const term = (d.search || "").trim();
  if (term) {
    p.set("search", term);
  }
  if (d.sort) {
    p.set("sort", d.sort);
    p.set("dir", d.dir);
  }
  p.set("limit", String(d.limit));
  p.set("offset", String(d.offset));
  return p.toString();
}

function deliveryRowsHtml(rows, dstate) {
  const body = rows
    .map((r) => {
      const o = deliveryOutcome(r);
      const outcome = `<span class="rec-out"><span class="rec-sw sw-${o.sw}"></span>${esc(o.label)}${
        o.hint ? ` <span class="rec-out-hint muted">${esc(o.hint)}</span>` : ""
      }</span>`;
      const detail = r.error || r.event_detail || "";
      const when = r.event_at ? fmt(r.event_at) : "";
      return `<tr><td class="rec-email">${esc(r.email)}</td><td>${outcome}</td><td class="muted">${
        detail ? esc(detail) : "—"
      }</td><td class="muted">${when ? esc(when) : "—"}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="list-table rec-people-table"><colgroup><col><col class="c-out"><col><col class="c-date"></colgroup><thead><tr>${th(
    "Recipient",
    "email",
    dstate,
  )}<th class="c-out">Outcome</th><th>Detail</th><th class="c-date">When</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderFrozenRecord(id, data) {
  const { send, outcomes, archive_url, published, slug } = data;
  const total = outcomes.recipients;
  const sentAt = send.completed_at ?? send.fire_at;

  app.innerHTML = `
    <div class="editor-head">
      <a href="#/sent" class="back">← Sent</a>
      ${published && archive_url ? `<button type="button" class="primary" id="viewPublished">View published issue&nbsp;↗</button>` : ""}
    </div>
    <div class="card rec-card">
      <div class="rec-head">
        <h1>${esc(send.subject) || "<em>untitled</em>"}</h1>
        <div class="rec-meta">Sent ${esc(fmt(sentAt))} · ${total.toLocaleString()} recipients</div>
      </div>
      <div class="rec-tiles">${outcomeTilesHtml(outcomes)}</div>
      <p class="rec-recon muted">${outcomeReconHtml(outcomes)}</p>
      <div class="rec-actions">
        <button type="button" class="ghost" id="csvBtn">Export recipients (CSV)</button>
      </div>
      <div class="rec-people">
        <div class="rec-people-head">
          <h2 class="rec-people-title">Recipients</h2>
          <div class="rec-views" role="group" aria-label="Which recipients to show">
            ${DELIVERY_VIEWS.map(
              (t, i) =>
                `<button type="button" class="rec-view-btn" data-view="${t.v}" aria-pressed="${i === 0 ? "true" : "false"}">${t.label}</button>`,
            ).join("")}
          </div>
        </div>
        <input class="rec-people-search" type="search" placeholder="Search email…" aria-label="Search recipients by email" autocomplete="off">
        <div id="recRows" class="muted">Loading…</div>
        <div id="recPager"></div>
      </div>
      <p class="rec-note muted">This is the record of what went out — the published issue is the exact frozen copy readers received, and nothing here is editable. Delivery counts keep updating as receipts arrive.</p>
    </div>`;

  const viewBtn = document.getElementById("viewPublished");
  if (viewBtn && archive_url) {
    viewBtn.onclick = () => window.open(archive_url, "_blank", "noopener");
  }

  // The per-recipient record, its own paged/filtered state (independent of the tiles).
  // Default view is "issues" so the rows that went wrong lead; default sort mirrors the
  // CSV (email asc). The tiles above stay the live summary as receipts settle; this list
  // reloads on interaction (a view/search/sort/page change, or re-clicking the view).
  const dstate = { view: "issues", search: "", sort: "email", dir: "asc", offset: 0, limit: 50 };
  const rowsEl = document.getElementById("recRows");
  const recPagerEl = document.getElementById("recPager");
  const loadDeliveries = async () => {
    try {
      const d = await api(`/sends/${id}/deliveries?${recordDeliveryQuery(dstate)}`);
      if (!d.deliveries.length) {
        rowsEl.innerHTML = `<p class="rec-people-empty muted">${esc(deliveryEmpty(dstate))}</p>`;
        recPagerEl.innerHTML = "";
        return;
      }
      rowsEl.innerHTML = deliveryRowsHtml(d.deliveries, dstate);
      wireSort(rowsEl, dstate, loadDeliveries);
      renderPager(recPagerEl, dstate, d.page, loadDeliveries);
    } catch (e) {
      renderError(rowsEl, e.message, loadDeliveries);
    }
  };
  app.querySelectorAll(".rec-view-btn").forEach((b) => {
    b.onclick = () => {
      dstate.view = b.dataset.view;
      dstate.offset = 0;
      app.querySelectorAll(".rec-view-btn").forEach((x) => {
        x.setAttribute("aria-pressed", String(x === b));
      });
      loadDeliveries();
    };
  });
  const recSearch = app.querySelector(".rec-people-search");
  if (recSearch) {
    let t = null;
    recSearch.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        dstate.search = recSearch.value;
        dstate.offset = 0;
        loadDeliveries();
      }, 250);
    };
  }
  loadDeliveries();

  const csvBtn = document.getElementById("csvBtn");
  csvBtn.onclick = () =>
    busy(csvBtn, "Exporting…", async () => {
      try {
        const csv = await apiText(`/sends/${id}/deliveries.csv`);
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const a = document.createElement("a");
        a.href = url;
        // Match the server's content-disposition (routes/sends.ts) so the file is named
        // the same however it's fetched — the archive slug, not a re-slug of the subject.
        a.download = `${slug ?? "send"}-deliveries.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) {
        toast(e.message);
      }
    });

  // Still settling: the record keeps absorbing delivery receipts after dispatch (§6), so
  // poll ~15s and repaint the tiles until every accepted recipient is confirmed. Capped
  // so a provider that never confirms doesn't leave the poll running forever.
  if (outcomes.accepted > 0) {
    scheduleSettlePoll(id, 0);
  }
}

function scheduleSettlePoll(id, count) {
  if (count > 40) {
    return; // ~10 min ceiling — stop chasing receipts that may never arrive
  }
  const gen = navGeneration;
  progressTimer = setTimeout(async () => {
    let data;
    try {
      data = await api(`/sends/${id}`);
    } catch {
      if (gen === navGeneration) {
        scheduleSettlePoll(id, count + 1);
      }
      return;
    }
    // Navigated away mid-fetch — the tiles we'd repaint belong to a view that's gone, and the
    // reschedule would leak onto the new view's poll timer. Bail (see navGeneration).
    if (gen !== navGeneration) {
      return;
    }
    if (data.send.status === "sending") {
      progressTimer = null;
      return renderSentRecord(id); // resumed (a wedged resolve, say) → back to the watch
    }
    const tiles = app.querySelector(".rec-tiles");
    const recon = app.querySelector(".rec-recon");
    if (tiles) {
      tiles.innerHTML = outcomeTilesHtml(data.outcomes);
    }
    if (recon) {
      recon.innerHTML = outcomeReconHtml(data.outcomes);
    }
    if (data.outcomes.accepted > 0) {
      scheduleSettlePoll(id, count + 1);
    } else {
      progressTimer = null;
    }
  }, 15000);
}

// ---- subscribers ----
// The story of the list as a whole: its composition (by-status counts) and the roster,
// filterable, sortable, and searchable. Consent status and suppression are separate
// axes: the status filter narrows the roster; the suppression facet is an overlay. The
// dashboard tiles deep-link via #/subscribers/<filter> — `initialFilter` seeds the
// status filter, or the suppression facet for "suppressed".
const SUB_STATUSES = [
  { value: "confirmed", label: "Confirmed" },
  { value: "pending", label: "Pending" },
  { value: "unsubscribed", label: "Unsubscribed" },
];
async function renderSubscribers(initialFilter) {
  const state = {
    status: "",
    search: "",
    suppressed: "",
    sort: "joined",
    dir: "desc",
    offset: 0,
    limit: 50,
  };
  if (initialFilter === "suppressed") {
    state.suppressed = "only";
  } else if (
    initialFilter === "confirmed" ||
    initialFilter === "pending" ||
    initialFilter === "unsubscribed"
  ) {
    state.status = initialFilter;
  }

  app.innerHTML = `
    <div class="spread page-head"><h1>Subscribers</h1><button class="primary" id="addSub">Add subscriber</button></div>
    <div id="subCounts" class="muted">Loading…</div>
    ${listToolbar({ statuses: SUB_STATUSES, suppressible: true, searchPlaceholder: "Search email…" })}
    <div id="subList" class="muted">Loading…</div>
    <div id="subPager"></div>`;

  const listEl = document.getElementById("subList");
  const pagerEl = document.getElementById("subPager");

  async function load() {
    try {
      const data = await api(`/subscribers?${listQuery(state)}`);
      const c = data.counts;
      // The counts card stays a global by-status summary (independent of the active
      // filter); the page total below reflects the filtered roster.
      document.getElementById("subCounts").innerHTML =
        `<div class="card row" style="gap:24px"><span><strong>${c.confirmed}</strong> confirmed</span><span>${c.pending} pending</span><span>${c.unsubscribed} unsubscribed</span><span>${c.suppressed} suppressed</span>${infoTip(
          "Pending: subscribed but hasn't clicked the confirmation email. Confirmed: consented — receives sends. Unsubscribed: opted out. Suppressed: bounced or complained — never mailed, whatever the consent state.",
          { below: true },
        )}</div>`;
      renderSubTable(listEl, data.subscribers, state, load);
      renderPager(pagerEl, state, data.page, load);
    } catch (e) {
      renderError(listEl, e.message, load);
    }
  }

  document.getElementById("addSub").onclick = () => addSubscriberModal(load);
  wireToolbar(app, state, load);
  load();
}

// The inline suppression flag rides next to the email (suppression is a deliverability
// overlay, not a consent status) and names WHY: bounced / complaint / blocked, with the
// provider detail in the tooltip. Reasons come from the webhook (bounce, complaint) or a
// manual block; anything unrecognized falls back to a generic label.
const SUPPRESSION_LABELS = { bounce: "bounced", complaint: "complaint", manual: "blocked" };
const SUPPRESSION_TIPS = {
  bounce: "Hard bounce — mail to this address failed, so it won't be mailed again.",
  complaint: "Marked as spam — won't be mailed again, whatever the consent state.",
  manual: "Manually blocked — won't be mailed.",
};
function suppressionFlag(s) {
  if (!s.suppressed) {
    return "";
  }
  const label = SUPPRESSION_LABELS[s.suppression_reason] || "suppressed";
  const base =
    SUPPRESSION_TIPS[s.suppression_reason] ||
    "Suppressed — won't be mailed, whatever the consent state.";
  const tip = s.suppression_detail ? `${base} (${s.suppression_detail})` : base;
  return ` <span class="badge suppressed row-flag" title="${esc(tip)}">${esc(label)}</span>`;
}

function renderSubTable(listEl, rows, state, reload) {
  if (!rows.length) {
    listEl.innerHTML = `<p class="muted">No subscribers match.</p>`;
    return;
  }
  listEl.innerHTML = `<div class="table-wrap"><table class="list-table"><colgroup><col><col class="c-status"><col class="c-date"><col class="c-act"></colgroup><thead><tr>${th("Email", "email", state)}${th("Status", null, state)}${th("Joined", "joined", state)}<th></th></tr></thead><tbody>${rows
    .map(
      (s) =>
        `<tr data-id="${s.id}"><td>${esc(s.email)}${suppressionFlag(s)}</td><td>${badge(s.status)}</td><td class="muted">${fmt(s.created_at)}</td><td class="act">${s.status === "confirmed" ? `<button class="icon" data-menu="${s.id}" aria-label="Subscriber actions">⋯</button>` : ""}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
  wireSort(listEl, state, reload);
  listEl.querySelectorAll("[data-menu]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const row = rows.find((r) => r.id === b.dataset.menu);
      openMenu(b, [
        { label: "Unsubscribe", danger: true, onClick: () => confirmUnsubscribe(row, reload) },
      ]);
    };
  });
}

// Add subscriber → the normal double opt-in (never an auto-confirm).
function addSubscriberModal(onDone) {
  const m = modal(
    `<h3>Add subscriber</h3><p class="hint">Starts the normal double opt-in: they get a confirmation email and won't receive issues until they confirm.</p><label for="addEmail">Email address</label><input type="email" id="addEmail" placeholder="person@example.com"><div class="actions"><button type="button" id="aCancel">Cancel</button><button type="button" class="primary" id="aGo">Send confirmation</button></div>`,
  );
  const input = m.el.querySelector("#addEmail");
  input.focus();
  m.el.querySelector("#aCancel").onclick = m.close;
  m.el.querySelector("#aGo").onclick = () =>
    busy(m.el.querySelector("#aGo"), "Adding…", async () => {
      const addr = input.value.trim();
      if (!addr?.includes("@")) {
        toast("Enter a valid email");
        return;
      }
      try {
        const r = await api("/subscribers", { method: "POST", json: { email: addr } });
        m.close();
        toast(
          r.action === "already_confirmed"
            ? `${addr} is already confirmed`
            : `Confirmation sent to ${addr}`,
        );
        onDone?.();
      } catch (e) {
        toast(e.message);
      }
    });
}

// ---- settings ----
// Runtime preferences (editable) + a read-only reflection of the deploy-time
// config. Secrets never come down this wire (see routes/settings.ts).
const PROVIDER_LABELS = { fake: "Fake (dev, dead-end)", ses: "Amazon SES", resend: "Resend" };

// Small inline icons for the intent chips, read-only notes, and controls.
const SET_ICON = {
  editable:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  readonly:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  copyout:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/></svg>',
  upload:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M8 8l4-4 4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  send: '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 3 11 14M22 3l-7 18-4-7-7-4 18-7z"/></svg>',
  lines:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1"/></svg>',
};

// ---- settings: email template (mock) ----
// The one layout each issue ships inside, authored as an HTML template with
// logic-less {{ }} placeholders over a fixed variable context. Logic-less means a
// token is only ever swapped for its value — nothing executes — which is why this
// is a template editor, not a WYSIWYG. This pass is a MOCK: edits repaint the
// preview only, nothing persists. The real layout engine (rendered once and frozen
// per send, I3/I5) and saved template variables come later; conceptually both run
// through the single render path (SPEC §5, I5) this preview stands in for.

// The variables a template can drop in, grouped for the reference panel.
const EMAIL_TEMPLATE_VARS = [
  {
    group: "Post",
    vars: [
      {
        token: "{{ post.body }}",
        desc: "Your issue's Markdown, rendered to HTML — the body slot.",
      },
      { token: "{{ post.subject }}", desc: "The issue's subject line." },
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
      { token: "{{ email.viewInBrowserUrl }}", desc: "The archived issue's permanent URL." },
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
const EMAIL_TEMPLATE_EXAMPLES = {
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

// Sample post body for the preview — representative prose inside a called-out slot,
// so it's unmistakable where a real issue's rendered Markdown lands. Its typography
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
// in a name can't break the surrounding markup. An unknown token renders empty.
function fillEmailTemplate(html, ctx) {
  return String(html).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) =>
    key === "post.body" ? ctx["post.body"] || "" : esc(ctx[key]),
  );
}

// A neutral placeholder logo (a monogram tile) for the preview when no real logo is
// set, so a signed sign-off still renders. Fully URL-encoded so it carries no raw
// <,>," and survives the template's attribute escaping.
function sampleLogoDataUri(name) {
  const ch = (String(name || "").trim()[0] || "K").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" rx="9" fill="#e4e4e7"/><text x="22" y="29" font-family="Georgia, serif" font-size="20" font-weight="700" fill="#52525b" text-anchor="middle">${ch}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Sample values the template preview binds — mirrors the render path's context, with
// email.* standing in for per-recipient values. `identity` is { name, tagline,
// logoUrl, address } from the live or loaded settings.
function templateSampleCtx(identity) {
  const id = identity || {};
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

// Mount a sample-email preview into an <iframe>, kept sized to its content. Returns
// { repaint } — call after the template or identity changes. getTemplate() returns
// the current template HTML; getIdentity() the { name, tagline, logoUrl, address }.
// Shared by the Template page (live editor preview) and Settings (a read-only one).
function mountSampleEmailPreview(iframe, getTemplate, getIdentity) {
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
    // innerHTML (not srcdoc per keystroke): flicker-free, and any <script> stays inert.
    slot.innerHTML = fillEmailTemplate(getTemplate(), templateSampleCtx(getIdentity()));
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
function templateVarsHtml() {
  return EMAIL_TEMPLATE_VARS.map(
    (g) =>
      `<div class="set-tpl-vargroup"><h4>${g.group}</h4>${g.vars
        .map(
          (v) =>
            `<div class="set-tpl-var"><code>${esc(v.token)}</code><span class="set-tpl-var-desc">${esc(v.desc)}</span></div>`,
        )
        .join("")}</div>`,
  ).join("");
}

/**
 * The Email template page (top-level "Template" nav item). The one layout each issue
 * is sent inside: a live sample-email preview over an HTML editor (with starter
 * examples, a variable reference, and its own validated Save). Editing lives here,
 * not in Settings, so each surface has a single, unambiguous save.
 */
// --- template syntax highlighting (issue #123) ---
// A small tokenizer for the overlay editor: colors the {{ tokens }}, HTML tags and
// attribute strings, and — inside the <style> block — CSS selectors, properties,
// colors and at-rules. Logic-less templates need nothing heavier, so this stays
// inside the dashboard's framework-free, no-build ethos (no CodeMirror, no bundler).
function hlTokens(s) {
  return s.replace(/\{\{\s*[\w.]+\s*\}\}/g, (m) => `<span class="cx-var">${m}</span>`);
}
function hlHtml(raw) {
  let s = esc(raw);
  s = s.replace(/&quot;[^&]*?&quot;/g, (m) => `<span class="cx-str">${m}</span>`);
  s = s.replace(
    /(&lt;\/?)([a-zA-Z][\w-]*)/g,
    (_m, br, name) => `<span class="cx-punct">${br}</span><span class="cx-tag">${name}</span>`,
  );
  s = s.replace(/(\/?)&gt;/g, (_m, sl) => `<span class="cx-punct">${sl}&gt;</span>`);
  return hlTokens(s);
}
function hlCss(raw) {
  let s = esc(raw);
  s = s.replace(/&quot;[^&]*?&quot;/g, (m) => `<span class="cx-str">${m}</span>`);
  s = s.replace(/#[0-9a-fA-F]{3,8}\b/g, (m) => `<span class="cx-num">${m}</span>`);
  s = s.replace(/@[\w-]+/g, (m) => `<span class="cx-at">${m}</span>`);
  s = s.replace(
    /^(\s*)(?![@\s])([^\n{}<]+?)(\s*)\{$/gm,
    (_m, ind, sel, sp) => `${ind}<span class="cx-sel">${sel}</span>${sp}{`,
  );
  s = s.replace(
    /^(\s*)([a-z-]+)(\s*:)/gm,
    (_m, ind, prop, colon) => `${ind}<span class="cx-prop">${prop}</span>${colon}`,
  );
  return hlTokens(s);
}
function highlightTemplate(src) {
  return String(src)
    .split(/(<style>[\s\S]*?<\/style>)/)
    .map((seg) => {
      const m = seg.match(/^<style>([\s\S]*?)<\/style>$/);
      if (m) {
        return `<span class="cx-punct">&lt;</span><span class="cx-tag">style</span><span class="cx-punct">&gt;</span>${hlCss(m[1])}<span class="cx-punct">&lt;/</span><span class="cx-tag">style</span><span class="cx-punct">&gt;</span>`;
      }
      return hlHtml(seg);
    })
    .join("");
}

async function renderTemplate() {
  app.innerHTML = `<div class="tpl-page"><div class="page-head"><h1>Email template</h1><p class="set-lede set-page-lede">The template controls the look and feel of the emails you send. You write it as HTML with a <code>&lt;style&gt;</code> block and <code>{{ variables }}</code> Kestrel fills in; your post’s Markdown is rendered into <code>{{ post.body }}</code>.</p></div><div id="tplBody" class="muted">Loading…</div></div>`;
  const bodyEl = document.getElementById("tplBody");
  let data;
  try {
    data = await api("/api/settings");
  } catch (e) {
    renderError(bodyEl, e.message, renderTemplate);
    return;
  }
  const s = data.settings;
  const d = data.deployment;
  const p = s.publication || {};
  const identity = {
    name: p.name || parseFromName(d.fromAddress) || "",
    tagline: p.tagline || "",
    logoUrl: p.logoUrl || "",
    address: p.address || "",
  };
  let templateBaseline = s.emailTemplate || "";
  const defaultRecipients = Array.isArray(s.testRecipients) ? s.testRecipients : [];

  bodyEl.innerHTML = `
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
          <button type="button" class="secondary" id="tplTest">${SET_ICON.send}<span id="tplTestLbl">Send test email</span></button>
        </span>
      </div>
      <div class="set-email-stage" id="tplStage">
        <iframe class="set-email-frame" id="tplPreview" title="Sample email preview" scrolling="no"></iframe>
      </div>
      <div class="set-preview-cap">Your post’s Markdown fills the body, and the <code>{{ email.* }}</code> values are set for each recipient when the issue sends. Email clients render differently, so send yourself a test to see it in a real inbox.</div>
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
              <button type="button" class="set-icon-btn" id="tplLineNums" aria-pressed="false" title="Show line numbers" aria-label="Show line numbers">${SET_ICON.lines}</button>
              <button type="button" class="ghost" id="tplCopyAll" title="Copy the whole template to the clipboard">${SET_ICON.copyout}<span id="tplCopyLbl">Copy</span></button>
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
      <div class="set-note">${SET_ICON.info}<span>Kestrel uses this one template, starting from a sensible default, when you send an email. Each sent email is archived exactly as it went out, so editing the template changes future emails and never ones already sent. Save and Discard are in the bar at the bottom of the page.</span></div>
    </div>

    <div class="set-card set-tpl-varcard">
      <div class="set-card-pad">
        <div class="set-tpl-varhead">
          <h3 class="set-tpl-vartitle">Variables</h3>
          <p class="field-hint">Kestrel replaces these variables with real values when you send an email. Type a variable exactly as shown, or it renders as empty. Double-click a variable to select it, then copy.</p>
        </div>
        <div class="set-tpl-vars-body">${templateVarsHtml()}</div>
      </div>
    </div>`;

  const tplEditor = document.getElementById("tplEditor");
  const preview = mountSampleEmailPreview(
    document.getElementById("tplPreview"),
    () => tplEditor.value,
    () => identity,
  );
  const tplMsgsEl = document.getElementById("tplMsgs");
  const tplTestEl = document.getElementById("tplTest");
  const tplTestLbl = document.getElementById("tplTestLbl");
  const isDirty = () => tplEditor.value !== templateBaseline;

  // Syntax-highlight overlay (issue #123): a transparent <textarea> over a highlighted
  // <pre>, plus a line-number gutter, kept in scroll sync. Vanilla, no dependency.
  const tplHl = document.getElementById("tplHl");
  const tplHlCode = tplHl.querySelector("code");
  const tplGutter = document.getElementById("tplGutter");
  const paintEditor = () => {
    const src = tplEditor.value;
    // Trailing newline so the last line renders and the overlay height matches the textarea.
    tplHlCode.innerHTML = `${highlightTemplate(src)}\n`;
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
  const reqBodyEl = document.getElementById("reqBody");
  const reqUnsubEl = document.getElementById("reqUnsub");
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
      : "Sends a sample issue through the saved template so you can see it in a real inbox.";
  }
  // Advisory warnings for the template that was just saved; blocking errors go to the
  // save bar instead (bar.showError), so the bar owns the blocking state and this owns
  // the post-save advisory state.
  function showWarnings(msgs) {
    if (!msgs.length) {
      tplMsgsEl.hidden = true;
      tplMsgsEl.innerHTML = "";
      return;
    }
    tplMsgsEl.hidden = false;
    tplMsgsEl.className = "set-tpl-msgs warn";
    tplMsgsEl.innerHTML = msgs.map((m) => `<div>${esc(m)}</div>`).join("");
  }
  function revertTemplate() {
    tplEditor.value = templateBaseline;
    showWarnings([]);
    preview.repaint();
    refreshDirty();
  }
  // Persist the current editor content. Returns the server's warnings (empty on a
  // clean save); THROWS on a rejected template (e.g. no unsubscribe link → 400), so
  // callers decide what to do. Shared by the save bar's Save and Save-&-send-test.
  async function saveTemplate() {
    const r = await api("/api/settings", {
      method: "PUT",
      json: { emailTemplate: tplEditor.value },
    });
    // The server may resolve "" to the default — reflect what was actually stored.
    templateBaseline = r.settings.emailTemplate;
    tplEditor.value = templateBaseline;
    appConfig = { ...(appConfig || {}), settings: r.settings };
    preview.repaint();
    refreshDirty(); // clean now — slides the bar away
    return Array.isArray(r.warnings) ? r.warnings : [];
  }
  // The shared save bar's Save button (run inside busy() by the controller). Persists,
  // surfaces warnings inline; a rejected save keeps the bar up and shows why in it.
  async function onSaveTemplate() {
    try {
      const warnings = await saveTemplate();
      showWarnings(warnings);
      toast(warnings.length ? "Template saved with warnings" : "Template saved");
    } catch (err) {
      // The bar owns the blocking error (it stays up and says why). No toast — a
      // bottom-center toast would sit on top of the bar and hide the very message.
      bar.showError(err.message);
    }
  }

  const loadExample = (key) => {
    const ex = EMAIL_TEMPLATE_EXAMPLES[key] || EMAIL_TEMPLATE_EXAMPLES.signed;
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
  const exBtn = document.getElementById("tplExamplesBtn");
  const exList = document.getElementById("tplExamplesList");
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
  for (const b of exList.querySelectorAll("[data-example]")) {
    b.onclick = () => {
      loadExample(b.dataset.example);
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
      if (wrap && list && !list.hidden && !wrap.contains(e.target)) {
        list.hidden = true;
        document.getElementById("tplExamplesBtn")?.setAttribute("aria-expanded", "false");
      }
    });
  }

  // Preview width toggle (640 / 375) — proof both inbox measures; 640 is the default.
  const frameEl = document.getElementById("tplPreview");
  for (const wb of bodyEl.querySelectorAll(".wtog-btn")) {
    wb.onclick = () => {
      for (const o of bodyEl.querySelectorAll(".wtog-btn")) {
        o.setAttribute("aria-pressed", String(o === wb));
      }
      frameEl.style.maxWidth = `${wb.dataset.w}px`;
      preview.repaint();
    };
  }

  // Line numbers: hidden by default; the toolbar toggle shows them and the choice is
  // remembered per browser (a lightweight convenience — safe to lose).
  const editorWrap = document.getElementById("tplEditorWrap");
  const lineNumsBtn = document.getElementById("tplLineNums");
  const setLineNums = (on) => {
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
  const copyAllBtn = document.getElementById("tplCopyAll");
  const copyAllLbl = document.getElementById("tplCopyLbl");
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
  // A test renders a sample issue through the SAVED template — what will actually
  // ship (I5). So if the editor is dirty we save first (a "Save & send test" flow);
  // a rejected save (e.g. missing unsubscribe) stops the send, honestly. We never
  // render unsaved editor content, which would test something that won't ship.
  tplTestEl.onclick = () => {
    const dirty = isDirty();
    const m = modal(
      `<h3>Send a test email</h3><p class="hint">Delivers a sample issue rendered through your <strong>saved</strong> template, so you can see it in a real inbox. One address per line.</p>${
        dirty
          ? `<p class="hint" style="color:var(--warn-fg)"><strong>Unsaved changes:</strong> sending will save your template first, so the test reflects what will actually ship.</p>`
          : ""
      }<label for="tplTestTo">Recipients</label><textarea id="tplTestTo" rows="3" placeholder="you@example.com"></textarea><p class="hint" id="tplTestHint" hidden></p><div class="actions"><button type="button" id="ttCancel">Cancel</button><button type="button" class="primary" id="ttGo">${
        dirty ? "Save &amp; send test" : "Send test"
      }</button></div>`,
    );
    const to = m.el.querySelector("#tplTestTo");
    to.focus();
    // Pre-fill from the saved default test recipients (don't clobber typed input).
    if (defaultRecipients.length && !to.value.trim()) {
      to.value = defaultRecipients.join("\n");
      const hint = m.el.querySelector("#tplTestHint");
      hint.textContent = "Pre-filled from your default test recipients (Settings).";
      hint.hidden = false;
    }
    m.el.querySelector("#ttCancel").onclick = m.close;
    m.el.querySelector("#ttGo").onclick = () =>
      busy(m.el.querySelector("#ttGo"), isDirty() ? "Saving…" : "Sending…", async () => {
        const addrs = parseAddresses(to.value);
        if (!addrs.length) {
          toast("Enter at least one email address");
          return;
        }
        // Honest unsaved-changes handling: persist first so the test renders what ships.
        // A rejected save shows in the bar and stops the send.
        if (isDirty()) {
          try {
            const warnings = await saveTemplate();
            showWarnings(warnings);
          } catch (err) {
            // The save failed, so the test can't send what would ship. The bar shows
            // why (and stays up); closing the dialog returns you to it. No toast — it
            // would overlay the bar and hide the reason.
            bar.showError(err.message);
            m.close();
            return;
          }
        }
        try {
          const r = await api("/api/settings/template/test", {
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
          toast(e.message);
        }
      });
  };
  tplEditor.value = templateBaseline;
  preview.repaint();
  refreshDirty();
}

async function renderSettings() {
  app.innerHTML = `<div class="settings"><div class="page-head"><h1>Settings</h1><p class="set-lede set-page-lede">Your publication's identity, the email each issue is sent inside, how mail is sent, and the ways readers subscribe. Facts set when Kestrel was deployed are shown read-only.</p></div><div id="settingsBody" class="muted">Loading…</div></div>`;
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
  const fromName = parseFromName(d.fromAddress) || "Your publication";

  // Live, in-memory state. The save bar tracks the PERSISTED identity fields (name,
  // tagline, address) + test recipients against the saved baseline. The logo is
  // immediate (its own endpoints); the email template has its own Save (it validates
  // and can warn), so it doesn't feed the bar.
  const state = {
    name: p.name || "",
    tagline: p.tagline || "",
    address: p.address || "",
    logoUrl: p.logoUrl || "",
    recipients: [...(s.testRecipients || [])],
    template: s.emailTemplate || "",
  };
  let baseline = {
    name: state.name,
    tagline: state.tagline,
    address: state.address,
    recipients: [...state.recipients],
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

  const chip = (kind, label) => `<span class="set-chip ${kind}">${SET_ICON[kind]}${label}</span>`;
  const secHead = (title, chipHtml, extra = "") =>
    `<div class="set-sec-head"><h2 class="set-sec-title">${title}</h2>${chipHtml}${extra}<span class="set-rule"></span></div>`;

  const identitySection = `
    <section class="set-sec">
      ${secHead("Publication identity", chip("editable", "Editable"))}
      <div class="set-card">
        <div class="set-id-grid">
          <div class="set-logo-slot">
            <div class="set-logo-tile${state.logoUrl ? " has-img" : ""}" id="logoTile" role="button" tabindex="0" aria-label="Upload logo"${state.logoUrl ? ` style="background-image:url('${esc(state.logoUrl)}')"` : ""}>
              <span class="set-logo-ph" id="logoPh"${state.logoUrl ? " hidden" : ""}>${SET_ICON.upload}Upload</span>
            </div>
            <input type="file" id="logoInput" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>
            <div class="set-logo-actions">
              <button type="button" id="logoReplace">${state.logoUrl ? "Replace" : "Upload"}</button>
              <button type="button" class="danger-subtle" id="logoRemove"${state.logoUrl ? "" : " hidden"}>Remove</button>
            </div>
            <p class="field-hint">PNG, JPEG, WebP, GIF, or SVG, up to 512&nbsp;KB. Saves immediately.</p>
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
      </div>
    </section>`;

  const templateSection = `
    <section class="set-sec">
      ${secHead("Email template", chip("editable", "Editable"))}
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
        <div class="set-ro-note">${SET_ICON.readonly}<span>The sender is fixed at deploy via environment secrets, so it can’t be edited here. Change it in the <a class="set-link" href="#/docs">operator setup guide</a>, then redeploy. Credentials are never shown.</span></div>
        <div class="set-preview-bar" style="background:transparent">
          <span class="set-preview-lbl">Inbox preview</span>
          <span class="set-preview-dot">How readers see the sender</span>
        </div>
        <div class="set-inbox">
          <div class="set-inbox-avatar">${esc(monogram(fromName))}</div>
          <div class="set-inbox-body">
            <div class="set-inbox-top"><span class="set-inbox-from">${esc(fromName)}</span><span class="set-inbox-time">9:02 AM</span></div>
            <div class="set-inbox-subj">Your latest issue — a sample subject line</div>
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
          <p class="field-hint" style="margin:0">Pre-filled into <strong>Send test email</strong> so you can proof an issue against your own inboxes before scheduling. These are your addresses, and they don’t go through the subscribe/consent flow.</p>
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

  const archiveBase = `${d.archiveOrigin || ""}${d.archiveBasePath || ""}`;
  const archiveIsDefault = d.archiveOrigin === d.appOrigin;
  const instanceSection = `
    <section class="set-sec">
      ${secHead("Instance", chip("readonly", "Read-only · set at deploy"))}
      <div class="set-card sunken">
        <div class="set-ro-note">${SET_ICON.info}<span>Deploy-time infrastructure, shown for reference. These live in your Worker config and never pass through the API. See the <a class="set-link" href="#/docs">operator setup guide</a> to change them.</span></div>
        <div class="set-kv">
          <div class="set-kv-k">App origin</div><div class="set-kv-v"><span class="mono">${esc(d.appOrigin)}</span></div>
          <div class="set-kv-k">Archive URL base</div><div class="set-kv-v"><span class="mono">${esc(archiveBase)}</span>${archiveIsDefault ? '<span class="set-pill">default: app origin</span>' : ""}</div>
          <div class="set-kv-k">Image URL base</div><div class="set-kv-v"><span class="mono">${esc(d.mediaPublicBase)}</span></div>
          <div class="set-kv-k">Auth mode</div><div class="set-kv-v">${d.authMode === "access" ? "Cloudflare Access" : "Local dev token"}</div>
          <div class="set-kv-k">Cloudflare Access</div><div class="set-kv-v">${d.accessConfigured ? `<span class="set-pill ok">${SET_ICON.check}Configured</span>` : '<span class="set-pill">Not configured</span>'}</div>
        </div>
      </div>
    </section>`;

  body.innerHTML =
    identitySection +
    templateSection +
    senderSection +
    recipSection +
    subscribeSection +
    instanceSection;

  // Keep the cached config + sidebar brand in step after a save (the sidebar brand
  // reads the same publication identity).
  const applySettings = (settings) => {
    appConfig = { ...(appConfig || {}), settings };
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
  const isDirty = () =>
    state.name !== baseline.name ||
    state.tagline !== baseline.tagline ||
    state.address !== baseline.address ||
    !sameList(state.recipients, baseline.recipients);
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
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await api("/api/settings/logo", { method: "POST", body: fd });
      state.logoUrl = r.settings.publication.logoUrl || "";
      applySettings(r.settings);
      applyLogoUi();
      toast("Logo updated");
    } catch (err) {
      toast(err.message);
    }
  };
  logoRemove.onclick = () =>
    busy(logoRemove, "Removing…", async () => {
      try {
        const r = await api("/api/settings/logo", { method: "DELETE" });
        state.logoUrl = r.settings.publication.logoUrl || "";
        applySettings(r.settings);
        applyLogoUi();
        toast("Logo removed");
      } catch (err) {
        toast(err.message);
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
          `<span class="set-recip-chip">${esc(addr)}<button type="button" data-rm="${i}" aria-label="Remove ${esc(addr)}">${SET_ICON.x}</button></span>`,
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

  // --- save / discard. Wired into the shared save bar above; the controller runs
  // saveSettings inside busy() on its Save button, so these stay plain callbacks.
  async function saveSettings() {
    try {
      const r = await api("/api/settings", {
        method: "PUT",
        json: {
          publication: { name: state.name, tagline: state.tagline, address: state.address },
          testRecipients: state.recipients,
        },
      });
      // Adopt the server's normalized result (trim, lowercase, dedupe) as baseline.
      const ns = r.settings;
      state.name = ns.publication.name;
      state.tagline = ns.publication.tagline;
      state.address = ns.publication.address;
      state.recipients = [...ns.testRecipients];
      nameEl.value = state.name;
      taglineEl.value = state.tagline;
      addressEl.value = state.address;
      baseline = {
        name: state.name,
        tagline: state.tagline,
        address: state.address,
        recipients: [...state.recipients],
      };
      applySettings(ns);
      renderRecipChips();
      rebuildEmbed();
      templatePreview.repaint();
      refreshDirty(); // clean now — slides the bar away
      toast("Settings saved");
    } catch (err) {
      // A failed save leaves the edits in place (still dirty → bar stays up).
      toast(err.message);
    }
  }
  function discardSettings() {
    state.name = baseline.name;
    state.tagline = baseline.tagline;
    state.address = baseline.address;
    state.recipients = [...baseline.recipients];
    nameEl.value = state.name;
    taglineEl.value = state.tagline;
    addressEl.value = state.address;
    renderRecipChips();
    rebuildEmbed();
    templatePreview.repaint();
    refreshDirty();
  }

  // --- initial paint.
  renderRecipChips();
  setEmbed("plain");
  templatePreview.repaint();
  refreshDirty();
}

// ---- docs ----
// The operator setup guide, authored in docs/setup/*.md and served read-only by the
// authed GET /api/docs route as sanitized HTML fragments. The guide is
// paginated — one part per page — with a "Contents" list of every part and an "On
// this page" of the current part's sections in the rail, plus Previous/Next at the
// foot; so scrolling reaches the end of the current doc and moving between docs is a
// deliberate step. No iframe: the content is trusted (repo markdown, hygiene-passed),
// so injecting the fragments into the DOM is safe. Fetched once and cached (the
// bundle never changes at runtime), so paging between parts is instant.
let docsCache = null;
async function renderDocs(slug) {
  app.innerHTML = roomShell(
    "docs",
    `<p class="muted">Loading…</p>`,
    `<article class="doc" id="docsMain"><p class="muted">Loading…</p></article>`,
  );
  const navEl = app.querySelector(".rail-inner");
  const mainEl = document.getElementById("docsMain");
  if (!docsCache) {
    try {
      ({ docs: docsCache } = await api("/api/docs"));
    } catch (e) {
      renderError(mainEl, e.message, () => renderDocs(slug));
      return;
    }
  }
  const docs = docsCache;
  if (!docs?.length) {
    mainEl.innerHTML = `<p class="muted">No documentation.</p>`;
    return;
  }

  // Show one part per page — the deep-linked slug, or the first. An unknown slug (a
  // stale or renamed deep link) shouldn't silently masquerade as the first doc: say
  // so and heal the URL back to the canonical guide (replaceState, so no reload).
  const found = docs.findIndex((d) => d.slug === slug);
  if (slug && found === -1) {
    toast(`No doc named “${slug}” — showing the guide.`);
    history.replaceState(history.state, "", "#/docs");
  }
  const at = Math.max(0, found);
  const cur = docs[at];
  const prev = docs[at - 1];
  const next = docs[at + 1];
  mainEl.innerHTML = `<section class="doc-part" id="doc-${esc(cur.slug)}">${cur.html}</section>`;

  // The fragment carries no ids — assign them to the current part's H1 and its H2s,
  // and collect the sections for the "On this page" rail. The H1 leads the list so
  // there's a way back to the top / the intro that sits above the first H2.
  const sec = mainEl.querySelector("section.doc-part");
  const h1 = sec.querySelector("h1");
  const sections = [];
  if (h1) {
    h1.id = `part-${cur.slug}`;
    sections.push({ id: h1.id, title: h1.textContent || cur.title });
  }
  sec.querySelectorAll("h2").forEach((h2, i) => {
    const id = `sec-${cur.slug}-${i + 1}`;
    h2.id = id;
    sections.push({ id, title: h2.textContent || "" });
  });

  // Previous / Next at the foot — the scroll ends with the current doc, so moving
  // between docs is a deliberate step (router links, one doc per page).
  const pager = document.createElement("nav");
  pager.className = "doc-pager";
  pager.innerHTML =
    (prev
      ? `<a class="doc-pager-btn prev" href="#/docs/${esc(prev.slug)}"><span class="doc-pager-dir">← Previous</span><span class="doc-pager-title">${esc(prev.title)}</span></a>`
      : `<span></span>`) +
    (next
      ? `<a class="doc-pager-btn next" href="#/docs/${esc(next.slug)}"><span class="doc-pager-dir">Next →</span><span class="doc-pager-title">${esc(next.title)}</span></a>`
      : `<span></span>`);
  mainEl.appendChild(pager);

  // The rail: a "Docs" list of every doc (router links, current one marked) and,
  // below it, an "On this page" of the current doc's sections that scroll-spy tracks.
  const onPage = sections.length
    ? `<div class="toc-onpage" id="tocOnPage"><div class="toc-label">On this page</div>${sections
        .map(
          (s) =>
            `<a class="toc-sub" href="#${esc(s.id)}" data-target="${esc(s.id)}">${esc(s.title)}</a>`,
        )
        .join("")}</div>`
    : "";
  navEl.innerHTML =
    `<div class="toc-label">Docs</div>` +
    `<nav class="doc-parts">${docs
      .map(
        (d) =>
          `<a class="toc-h${d.slug === cur.slug ? " on" : ""}" href="#/docs/${esc(d.slug)}">${ARTICLE_ICON}<span>${esc(d.title)}</span></a>`,
      )
      .join("")}</nav>` +
    onPage;

  // "On this page" links smooth-scroll within the current doc (and highlight at once,
  // so a short final section that can't scroll to the top still lights up); the Docs
  // links carry no data-target and fall through to the SPA router (a new doc page).
  const onPageEl = document.getElementById("tocOnPage");
  const markActive = (id) => {
    if (!onPageEl) {
      return;
    }
    for (const a of onPageEl.querySelectorAll(".toc-sub")) {
      a.classList.toggle("on", a.dataset.target === id);
    }
  };
  navEl.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-target]");
    if (!a) {
      return;
    }
    ev.preventDefault();
    markActive(a.dataset.target);
    document
      .getElementById(a.dataset.target)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  });

  // Copy buttons on the guide's many shell / DNS code blocks.
  for (const pre of mainEl.querySelectorAll("pre")) {
    pre.classList.add("has-copy");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      try {
        await navigator.clipboard.writeText((code || pre).innerText);
        btn.textContent = "Copied";
        setTimeout(() => {
          btn.textContent = "Copy";
        }, 1500);
      } catch {
        toast("Couldn't copy to clipboard");
      }
    });
    pre.appendChild(btn);
  }

  // Scroll-spy: the active section is the last heading scrolled above a line just
  // under the sticky room bar; at the very bottom the last heading wins even if the
  // page can't scroll it that high, so a short final section still highlights (the
  // .doc bottom runway makes most reach the line on their own). One document.onscroll
  // slot, self-cleared once this doc leaves the DOM — no leak across SPA navigations.
  // (Same position-based shape as ~/Git/svg-tutorial, not an IntersectionObserver,
  // which pauses when the tab isn't being composited.)
  if (onPageEl && sections.length) {
    const ids = sections.map((s) => s.id);
    const line = 80; // clears the 54px room bar
    const spy = () => {
      if (!document.getElementById(ids[0])) {
        document.onscroll = null; // this doc is gone — unhook
        return;
      }
      let active = ids[0];
      if (Math.ceil(window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight) {
        active = ids[ids.length - 1];
      } else {
        for (const id of ids) {
          if (
            (document.getElementById(id)?.getBoundingClientRect().top ??
              Number.POSITIVE_INFINITY) <= line
          ) {
            active = id;
          } else {
            break;
          }
        }
      }
      markActive(active);
    };
    document.onscroll = spy;
    spy();
  }

  // Each doc is its own page — start at the top.
  window.scrollTo(0, 0);
}

// ---- API reference ----
// Every route the app and Claude can call, generated from the route manifest
// (src/app.ts) and served as JSON by the authed /api/reference route. The SPA
// renders it natively as a sticky rail of tiers beside the route list, so it
// matches the app's own chrome (no iframe, unlike the earlier build).
function apiExample(label, value) {
  return value === undefined
    ? ""
    : `<div class="api-ex"><span class="api-ex-label">${esc(label)}</span><pre><code>${esc(
        JSON.stringify(value, null, 2),
      )}</code></pre></div>`;
}
// Query params for a list route, rendered as a name→description table so the
// generated reference documents filter/sort/pagination from the registration.
function apiQueryHtml(query) {
  if (!query?.length) {
    return "";
  }
  const rows = query
    .map(
      (q) =>
        `<tr><td><code>${esc(q.name)}</code></td><td class="muted">${esc(q.description)}</td></tr>`,
    )
    .join("");
  return `<div class="api-ex"><span class="api-ex-label">Query</span><table class="api-query"><tbody>${rows}</tbody></table></div>`;
}
function apiRouteHtml(r) {
  return `<div class="api-route">
      <div class="api-route-head">
        <span class="api-method m-${esc(r.method)}">${esc(r.method)}</span>
        <code class="api-path">${esc(r.path)}</code>
        <span class="api-tier">${esc(r.access)}</span>
      </div>
      <p class="api-summary">${esc(r.summary)}</p>
      ${r.description ? `<p class="api-desc muted">${esc(r.description)}</p>` : ""}
      ${apiQueryHtml(r.query)}
      ${apiExample("Request", r.example?.request)}
      ${apiExample("Response", r.example?.response)}
    </div>`;
}
function apiSectionHtml(g) {
  return `<section class="api-section" id="api-${esc(g.access)}">
      <h2>${esc(g.title)}</h2>
      <p class="api-blurb muted">${esc(g.blurb)}</p>
      ${g.routes.map(apiRouteHtml).join("")}
    </section>`;
}
async function renderReference() {
  app.innerHTML = roomShell(
    "reference",
    `<div class="toc-label">API</div><nav class="api-nav" id="apiNav" aria-label="API sections"></nav>`,
    `<div class="api-content" id="apiContent"><p class="muted">Loading…</p></div>`,
  );
  const navEl = document.getElementById("apiNav");
  const contentEl = document.getElementById("apiContent");
  // Delegate clicks synchronously with one listener on the stable nav, so it survives
  // the async fill below: a sidebar click smooth-scrolls to that section.
  navEl.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-sec]");
    if (!a) {
      return;
    }
    ev.preventDefault();
    document.getElementById(`api-${a.dataset.sec}`)?.scrollIntoView({ block: "start" });
  });
  let groups;
  try {
    ({ groups } = await api("/api/reference"));
  } catch (e) {
    renderError(contentEl, e.message, renderReference);
    return;
  }

  navEl.innerHTML = groups
    .map(
      (g, i) =>
        `<a href="#/reference" data-sec="${esc(g.access)}"${i === 0 ? ' class="active"' : ""}>` +
        `${esc(g.title)}<span class="api-nav-count">${g.routes.length}</span></a>`,
    )
    .join("");
  contentEl.innerHTML =
    `<header class="api-head"><h1>API reference</h1>` +
    `<p class="muted">Generated from the route registration, so every endpoint the app and Claude can call is listed here. ` +
    `Base URL <code>${esc(location.origin)}</code>.</p></header>` +
    groups.map(apiSectionHtml).join("");

  // Highlight whichever section is in view. Query the live nav each time so it
  // never holds a stale link reference; park the observer on the nav so it lives
  // as long as the view (GC'd on unmount).
  navEl._obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const sec = e.target.id.replace(/^api-/, "");
          for (const a of navEl.querySelectorAll("a[data-sec]")) {
            a.classList.toggle("active", a.dataset.sec === sec);
          }
        }
      }
    },
    { rootMargin: "-15% 0px -75% 0px", threshold: 0 },
  );
  for (const g of groups) {
    const el = document.getElementById(`api-${g.access}`);
    if (el) {
      navEl._obs.observe(el);
    }
  }
}

// ---- dashboard (home) ----
// The post-login landing and the brand's target (the default route). Built entirely
// from existing authed endpoints — GET /posts, /sends, /subscribers, and the cached
// /api/settings — so it adds no surface and can't touch an invariant. It answers
// SPEC §8's questions at a glance: is anything wrong, who's on the list, what's
// scheduled, what went out, and what's still in progress.

// SES puts a sender under review at a 5% bounce rate, so that danger-zone threshold is
// what the health line treats as a "bounce spike" (SPEC §8/§11). It sits well above the
// dev send simulator's normal ~2% simulated bounce rate (src/providers/simulate.ts), so a
// demo send never false-alarms. A small absolute floor keeps a tiny audience's inherently
// noisy rate (one bad address out of a handful) from tripping it.
const BOUNCE_SPIKE_RATE = 0.05;
const BOUNCE_SPIKE_MIN = 3;

// Health (SPEC §8 "is anything wrong", §11 loud failure): calm in the common case,
// loud only when something needs attention. Derived from GET /sends.
function computeHealth(sends) {
  const now = Date.now();
  const issues = [];
  const failed = sends.filter((s) => s.status === "failed");
  if (failed.length) {
    issues.push({
      level: "red",
      text: `${failed.length} send${failed.length === 1 ? "" : "s"} failed — check Sends.`,
    });
  }
  const missed = sends.filter((s) => s.status === "scheduled" && s.fire_at <= now);
  if (missed.length) {
    issues.push({
      level: "red",
      text: `${missed.length} scheduled send${missed.length === 1 ? "" : "s"} passed the fire time without going out.`,
    });
  }
  const sending = sends.filter((s) => s.status === "sending");
  // A send wedged on ambiguous in-flight rows needs a decision, not just patience —
  // flag it red and actionable, and keep it out of the generic in-progress lines
  // below so it isn't reported twice (SPEC §11; resolve on the Sends page).
  const wedged = sending.filter(isWedged);
  if (wedged.length) {
    const n = wedged.reduce((sum, s) => sum + (s.c_in_flight || 0), 0);
    issues.push({
      level: "red",
      text: `${n} ambiguous ${n === 1 ? "delivery needs" : "deliveries need"} a decision — resolve in Sends.`,
    });
  }
  // A healthy in-progress send is NOT surfaced here — the live active-send widget below is
  // its home (a bar + a Watch link, kept live by the poll). The health line is loud-only,
  // so it keeps just the *stuck* case: a send that's been running unusually long.
  const active = sending.filter((s) => !isWedged(s));
  const stuck = active.filter((s) => s.started_at && now - s.started_at > 10 * 60 * 1000);
  if (stuck.length) {
    issues.push({
      level: "amber",
      text: "A send has been in progress over 10 minutes — it may be retrying.",
    });
  }
  // Bounce spike (SPEC §8 "is anything wrong", §11): a recent send whose real bounce rate
  // is in the danger zone. This reads the true webhook-confirmed bounce count off the send
  // row's `c_bounced` counter (migration 0006) over the frozen audience — not the old
  // send-time-`failed` proxy, which couldn't see asynchronous bounce events at all. The
  // threshold is BOUNCE_SPIKE_RATE; the absolute floor keeps a tiny audience's noisy rate
  // from tripping it. Read-only reporting — it never throttles or halts a send (§11 leaves
  // an automatic deliverability circuit-breaker deferred).
  const spiky = sends
    .filter((s) => s.status === "sent")
    .slice(0, 5)
    .find((s) => {
      const bounced = s.c_bounced || 0;
      return (
        s.recipient_count > 0 &&
        bounced >= BOUNCE_SPIKE_MIN &&
        bounced / s.recipient_count >= BOUNCE_SPIKE_RATE
      );
    });
  if (spiky) {
    const pct = Math.round((100 * (spiky.c_bounced || 0)) / spiky.recipient_count);
    issues.push({
      level: "amber",
      text: `Elevated bounce rate (${pct}%) on a recent send — check Sends.`,
    });
  }
  return issues;
}

async function renderDashboard() {
  app.innerHTML = `<div class="dash" id="dash"><p class="muted">Loading…</p></div>`;
  const root = document.getElementById("dash");
  let posts, sends, counts;
  try {
    // The health line scans every send and the archive-link slug map needs every post,
    // so ask for a full window rather than the list default (50). Subscribers is only
    // read for its (filter-independent) counts, so its row limit doesn't matter.
    const [p, s, subs] = await Promise.all([
      api("/posts?limit=200"),
      api("/sends?limit=200"),
      api("/subscribers"),
    ]);
    posts = p.posts;
    sends = s.sends;
    counts = subs.counts;
  } catch (e) {
    renderError(root, e.message, renderDashboard);
    return;
  }
  const pub = derivePublication(appConfig);
  const deployment = appConfig?.deployment || {};
  const totalSubs = counts.confirmed + counts.pending + counts.unsubscribed + counts.suppressed;

  // First run — nothing written and no one on the list: replace the body with the
  // onboarding checklist (the shared Getting-started component) rather than a wall
  // of empty tiles.
  if (!posts.length && totalSubs === 0) {
    root.innerHTML =
      `<div class="dash-head"><div><h1>${esc(pub.name)}</h1>${
        pub.tagline ? `<p class="muted dash-tagline">${esc(pub.tagline)}</p>` : ""
      }<p class="muted">Let's get your first issue out the door.</p></div></div>` +
      setupChecklistHtml(pub, deployment);
    wireDashActions(root, renderDashboard);
    return;
  }

  // No news is good news: the health line appears only when something needs
  // attention (SPEC §8 / §11 — the only thing that ever surfaces loudly).
  const health = computeHealth(sends);
  const level = health.some((i) => i.level === "red") ? "red" : "amber";
  const healthHtml = health.length
    ? `<div class="health ${level}"><span class="health-dot">⚠️</span><div>${health
        .map((i) => `<div>${esc(i.text)}</div>`)
        .join("")}</div></div>`
    : "";

  // Active-send widget: when a send is in flight (and not wedged — that's a red health
  // line above), show it with a live mini dispatch bar, an ETA, and a Watch link into the
  // record view's live watch (#154). A glanceable entry point sitting with the health area.
  // It lives in its own `#dashActive` container and is polled live (below), so its bar
  // advances and it appears/clears without a manual reload.
  const activeSends = sends.filter((s) => s.status === "sending" && !isWedged(s));

  // Each tile deep-links into the roster pre-filtered on its criterion
  // (#/subscribers/<filter>), so a count is a way in, not just a number.
  const tiles = [
    {
      label: "Confirmed",
      emph: true,
      v: counts.confirmed,
      filter: "confirmed",
    },
    { label: "Pending", v: counts.pending, filter: "pending" },
    { label: "Unsubscribed", v: counts.unsubscribed, filter: "unsubscribed" },
    { label: "Suppressed", v: counts.suppressed, filter: "suppressed" },
  ];
  const tilesHtml = `<div class="tiles">${tiles
    .map(
      (t) =>
        `<a class="tile${t.emph ? " tile-emph" : ""}" href="#/subscribers/${t.filter}"><span class="tile-n">${t.v}</span><span class="tile-label">${esc(t.label)}${
          t.sub ? `<span class="tile-sub">${esc(t.sub)}</span>` : ""
        }</span></a>`,
    )
    .join("")}</div>`;

  const scheduled = sends
    .filter((s) => s.status === "scheduled")
    .sort((a, b) => a.fire_at - b.fire_at);
  const nextUpHtml = dashScheduledHtml(scheduled);

  const slugById = new Map(posts.map((p) => [p.id, p.slug]));
  const recent = sends
    .filter((s) => s.status === "sent" || s.status === "sending" || s.status === "failed")
    .slice(0, 5);
  const recentHtml = recent.length
    ? `<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th><th></th></tr></thead><tbody>${recent
        .map((s) => {
          const slug = slugById.get(s.post_id);
          const url = slug ? archiveUrlFor(deployment, slug) : null;
          // A sent row opens its record view (#148); the subject is the keyboard target.
          const isSent = s.status === "sent";
          const subj = isSent ? `<a href="#/sent/${s.id}">${esc(s.subject)}</a>` : esc(s.subject);
          return `<tr${isSent ? ` class="clickable" data-send="${s.id}"` : ""}><td>${subj}</td><td>${badge(s.status)}</td><td class="num">${s.recipient_count}</td><td class="num">${deliveredCell(s)}</td><td class="act">${
            url && isSent
              ? `<a class="ghost-link" href="${esc(url)}" target="_blank" rel="noopener">Archive&nbsp;↗</a>`
              : ""
          }</td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : `<p class="muted">No sends yet.</p>`;

  const drafts = posts.filter((p) => p.status === "draft").slice(0, 5);
  const draftsHtml = drafts.length
    ? `<div class="table-wrap"><table><tbody>${drafts
        .map(
          (p) =>
            `<tr class="clickable" data-id="${p.id}"><td><a href="#/edit/${p.id}">${esc(p.subject) || "<em>untitled</em>"}</a></td><td class="muted">edited ${fmt(p.updated_at)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="muted">No drafts in progress.</p>`;

  const appOrigin = deployment.appOrigin || location.origin;
  const archiveBase =
    (deployment.archiveOrigin || location.origin) + (deployment.archiveBasePath || "");
  const pubCardHtml = `<div class="card pub-card">
    <div class="pub-row"><span class="pub-key muted">Publication</span><code class="pub-val">${esc(appOrigin)}</code><button class="ghost" data-copy="${esc(appOrigin)}">Copy</button></div>
    <div class="pub-row"><span class="pub-key muted">Archive</span><code class="pub-val">${esc(archiveBase)}</code><button class="ghost" data-copy="${esc(archiveBase)}">Copy</button></div>
    <div class="pub-foot"><a href="/" target="_blank" rel="noopener">View publication&nbsp;↗</a></div>
  </div>`;

  // Connect the API — the API's first client is an agent, so the base URL is
  // copyable right here (no need to open the reference room to wire up Claude).
  const apiCardHtml = `<div class="card pub-card">
    <div class="pub-row"><span class="pub-key muted">Base&nbsp;URL</span><code class="pub-val">${esc(appOrigin)}</code><button class="ghost" data-copy="${esc(appOrigin)}">Copy</button></div>
    <p class="pub-note">One API drives Kestrel — the editor and Claude are equal clients of it. <a href="#/reference">Browse the API reference →</a></p>
  </div>`;

  const quickHtml = `<div class="row quick-actions"><button class="primary" data-act="new-post">New post</button><button data-act="add-sub">Add subscriber</button><button data-nav="#/settings">Edit publication</button></div>`;

  root.innerHTML = `
    <div class="dash-head">
      <div><h1>${esc(pub.name)}</h1>${pub.tagline ? `<p class="muted dash-tagline">${esc(pub.tagline)}</p>` : ""}</div>
      <button class="primary" data-act="new-post">New post</button>
    </div>
    ${healthHtml}
    <div id="dashActive">${dashActiveHtml(activeSends)}</div>
    <section class="dash-section"><h2>Subscribers</h2>${tilesHtml}</section>
    <div class="dash-cols">
      <section class="dash-section"><h2>Scheduled</h2><div id="dashScheduled">${nextUpHtml}</div></section>
      <section class="dash-section"><h2>Drafts</h2>${draftsHtml}</section>
    </div>
    <section class="dash-section"><h2>Sent</h2>${recentHtml}</section>
    <section class="dash-section"><h2>Quick actions</h2>${quickHtml}</section>
    <div class="dash-cols">
      <section class="dash-section"><h2>Publication</h2>${pubCardHtml}</section>
      <section class="dash-section"><h2>Connect the API</h2>${apiCardHtml}</section>
    </div>`;

  wireDashActions(root, renderDashboard);
  // Row / card clicks open the issue (subject links + Cancel opt out — the same guard
  // the Posts table and the Sends cards use).
  root.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.tagName !== "A" && !e.target.closest("button")) {
        location.hash = `#/edit/${tr.dataset.id}`;
      }
    };
  });
  // Recent-sends rows carry a SEND id (not a post id) and open the record view.
  root.querySelectorAll("tr[data-send]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.tagName !== "A") {
        location.hash = `#/sent/${tr.dataset.send}`;
      }
    };
  });
  wireDashActiveCards();
  wireDashScheduledCards();
  startCountdowns();
  // Keep the send sections live: advance the active-send widget's bar, and when a send
  // starts or finishes, refresh the Scheduled queue so a fired issue clears out of it (its
  // home is now the In-progress widget, then the records). Cleared on navigation.
  scheduleDashActivePoll();
}

/** The dashboard's scheduled cards are read-only summaries: the whole card links into the
 *  editor, where the schedule is actually managed. The Sent page keeps the one-call cancel
 *  the review window needs (SPEC §8). */
function dashScheduledHtml(scheduled) {
  if (!scheduled.length) {
    return `<p class="muted">Nothing scheduled.</p>`;
  }
  return scheduled
    .map(
      (s) =>
        `<div class="card spread clickable nextup sched-card" data-post="${s.post_id}"><div><a class="card-link sched-subj" href="#/edit/${s.post_id}">${esc(s.subject)}</a><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div></div>`,
    )
    .join("");
}
function wireDashScheduledCards() {
  document.querySelectorAll("#dashScheduled .nextup").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.tagName !== "A") {
        location.hash = `#/edit/${card.dataset.post}`;
      }
    };
  });
}

/** The dashboard active-send section (empty string when nothing is in flight). */
function dashActiveHtml(active) {
  if (!active.length) {
    return "";
  }
  return `<section class="dash-section"><h2>Active send${active.length === 1 ? "" : "s"}</h2>${active
    .map(activeRowHtml)
    .join("")}</section>`;
}
function wireDashActiveCards() {
  document.querySelectorAll("#dashActive .active-card[data-watch]").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.tagName !== "A") {
        location.hash = `#/sent/${card.dataset.watch}`;
      }
    };
  });
}
// Poll the in-flight set (~3s) and repaint ONLY the widget container in place — it slides
// in as a send starts, advances, and clears when it finishes, with no full-page re-render
// (a full re-render flashed the whole dashboard as the send started). The health line and
// Sent table is a glance snapshot that refreshes on navigation. A recursive setTimeout, so
// a slow read never overlaps; `progressTimer` holds it so navigation clears it.
let dashActiveSig = "";
function scheduleDashActivePoll() {
  const gen = navGeneration;
  progressTimer = setTimeout(async () => {
    let sends;
    try {
      ({ sends } = await api("/sends?status=sending&limit=200"));
    } catch {
      if (gen === navGeneration) {
        scheduleDashActivePoll();
      }
      return;
    }
    // Navigated off the dashboard mid-fetch: #dashActive is gone (or belongs to a re-mounted
    // dashboard with its own poll), so don't repaint or reschedule onto it (see navGeneration).
    if (gen !== navGeneration) {
      return;
    }
    const active = sends.filter((s) => !isWedged(s));
    const el = document.getElementById("dashActive");
    if (el) {
      el.innerHTML = dashActiveHtml(active);
      wireDashActiveCards();
    }
    // On a transition (a send started or finished) the scheduled queue changed — a fired
    // send left it — so refresh just that section in place (no full-page re-render).
    const sig = active
      .map((s) => s.id)
      .sort()
      .join(",");
    if (sig !== dashActiveSig) {
      dashActiveSig = sig;
      refreshDashScheduled();
    }
    scheduleDashActivePoll();
  }, 3000);
}
async function refreshDashScheduled() {
  const el = document.getElementById("dashScheduled");
  if (!el) {
    return;
  }
  try {
    const { sends } = await api("/sends?status=scheduled&sort=fire&dir=asc&limit=200");
    el.innerHTML = dashScheduledHtml(sends);
    wireDashScheduledCards();
    startCountdowns(); // re-arm the countdown ticker over the refreshed cards
  } catch {
    /* non-fatal — the scheduled section keeps its last render */
  }
}

// Controls shared by the Dashboard and the Getting-started view: hash navigation,
// "New post", "Add subscriber", and copy buttons.
function wireDashActions(root, reload) {
  root.querySelectorAll("[data-nav]").forEach((b) => {
    b.onclick = () => {
      location.hash = b.dataset.nav;
    };
  });
  root.querySelectorAll("[data-act='new-post']").forEach((b) => {
    b.onclick = () => createNewPost(b);
  });
  root.querySelectorAll("[data-act='add-sub']").forEach((b) => {
    b.onclick = () => addSubscriberModal(reload);
  });
  root.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = () => copyText(b.dataset.copy);
  });
}

// The onboarding checklist, shared by the first-run dashboard and Getting-started.
function setupChecklistHtml(pub, deployment) {
  const subscribeUrl = `${deployment.appOrigin || location.origin}/subscribe`;
  return `<div class="card setup">
    <h2 class="setup-title">Set up your publication</h2>
    <ol class="setup-steps">
      <li><div class="setup-step-main"><strong>Name your publication</strong><span class="muted">Currently “${esc(pub.name)}”. Set the name, tagline, and brand in Settings.</span></div><button data-nav="#/settings">Settings</button></li>
      <li><div class="setup-step-main"><strong>Write your first post</strong><span class="muted">Draft an issue in Markdown and preview it exactly as the email.</span></div><button class="primary" data-act="new-post">New post</button></li>
      <li><div class="setup-step-main"><strong>Confirm your sending domain</strong><span class="muted">SPF, DKIM, and DMARC on your From address — the operator setup guide walks through it.</span></div><button data-nav="#/docs">Docs</button></li>
      <li><div class="setup-step-main"><strong>Share your subscribe link</strong><code class="setup-url">${esc(subscribeUrl)}</code></div><button data-copy="${esc(subscribeUrl)}">Copy</button></li>
    </ol>
  </div>`;
}

// ---- Overview (the reference room's home) ----
// The permanent home for onboarding (the footer Kestrel link → here): a short "how
// Kestrel works", the "why" in plain language, and the setup checklist.
// It reserves the room rail like Docs/API, with an "on this page" scroll-spy.
function howItWorksHtml() {
  const steps = [
    ["Write", "Draft in Markdown and preview exactly what the email will look like."],
    ["Schedule", "Schedule ahead — the send waits in a visible, cancelable review window."],
    ["Send", "It fires on its own to your confirmed subscribers; nothing goes out unseen."],
    ["Archive", "Every issue is preserved as a permanent page — the record of what went out."],
  ];
  return `<section class="dash-section" id="ov-how"><h2>How Kestrel works</h2><ol class="how-steps">${steps
    .map(([t, d]) => `<li><strong>${esc(t)}</strong><span class="muted">${esc(d)}</span></li>`)
    .join("")}</ol></section>`;
}
// The "why", in clear language — competitor-neutral, no funnel copy.
const WHY_KESTREL = [
  [
    "One door, two clients",
    "You drive Kestrel through a single API, and the web editor and Claude are equal clients of it. Nothing reaches past that door, so the two can't fall out of sync — and an agent is a first-class author, able to do anything you can, not a bolt-on integration.",
  ],
  [
    "Safe to send unattended",
    "Scheduling freezes the rendered email and locks the issue behind a visible, cancelable review window. What goes out is exactly what was last reviewed — never a later edit no one checked — so you can prepare a send days ahead and let it fire on its own.",
  ],
  [
    "A test you can trust",
    "The preview, the test send, and the real send all run through one render path. A test to your own inbox is the same code producing the same result, so if the test looks right, the send is right.",
  ],
  [
    "Yours to keep",
    "The subscriber list, the double-opt-in consent record, the delivery history, and a permanent page for every issue live in your own database — exportable and independent of any provider. The page a reader opens is the same copy that was sent.",
  ],
  [
    "Cheap by construction",
    "Kestrel is one small serverless app over a database, object storage, and a wholesale email transport. There's no server to keep alive and no charge for the size of your list — you pay for what you send, and you can host it yourself.",
  ],
  [
    "Does one thing completely",
    "Email, done properly: consent, scheduling, the review window, delivery, suppression, and the archive. No drip funnels, no multi-channel sprawl — the focus is the point.",
  ],
];
async function renderStart() {
  // The checklist needs the deployment origins; boot usually has them cached.
  if (!appConfig) {
    try {
      appConfig = await api("/api/settings");
    } catch {
      /* fall back to location.origin in the checklist */
    }
  }
  const pub = derivePublication(appConfig);
  const deployment = appConfig?.deployment || {};
  // Overview's rail is only an "On this page" — use the section style (.toc-sub), not
  // the doc-list style (.toc-h, which carries the open-book "which doc" marker).
  const rail =
    `<div class="toc-label">On this page</div>` +
    `<a class="toc-sub" href="#ov-how" data-target="ov-how">How Kestrel works</a>` +
    `<a class="toc-sub" href="#ov-why" data-target="ov-why">Why Kestrel</a>` +
    `<a class="toc-sub" href="#ov-setup" data-target="ov-setup">Set up your publication</a>`;
  const whyHtml = WHY_KESTREL.map(
    ([t, d]) => `<div class="why-item"><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`,
  ).join("");
  const main = `<div class="dash room-overview" id="start">
    <div class="dash-head"><div><h1>Welcome to Kestrel</h1><p class="muted">A newsletter you own from end to end — write in Markdown, review behind a cancelable window, send it, and keep a permanent archive.</p></div></div>
    ${howItWorksHtml()}
    <section class="dash-section" id="ov-why"><h2>Why Kestrel</h2><div class="why-grid">${whyHtml}</div></section>
    <section class="dash-section" id="ov-setup">${setupChecklistHtml(pub, deployment)}</section>
  </div>`;
  app.innerHTML = roomShell("start", rail, main);
  const root = document.getElementById("start");
  wireDashActions(root, renderStart);

  // "On this page" scroll-spy over the three sections (same idea as Docs/API).
  const railEl = app.querySelector(".rail-inner");
  const sections = ["ov-how", "ov-why", "ov-setup"]
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  railEl._obs = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          for (const a of railEl.querySelectorAll("a[data-target]")) {
            a.classList.toggle("on", a.dataset.target === e.target.id);
          }
        }
      }
    },
    { rootMargin: "-66px 0px -72% 0px", threshold: 0 },
  );
  for (const s of sections) {
    railEl._obs.observe(s);
  }
  railEl.addEventListener("click", (ev) => {
    const a = ev.target.closest("a[data-target]");
    if (!a) {
      return;
    }
    ev.preventDefault();
    document.getElementById(a.dataset.target)?.scrollIntoView({ block: "start" });
  });
}

function confirmUnsubscribe(sub, onDone) {
  const m = modal(
    `<h3>Unsubscribe this subscriber?</h3><p class="hint">Removes <strong>${esc(sub.email)}</strong> from the send audience immediately. They can re-subscribe later through the double opt-in.</p><div class="actions"><button type="button" id="uCancel">Cancel</button><button type="button" class="danger" id="uGo">Unsubscribe</button></div>`,
  );
  m.el.querySelector("#uCancel").onclick = m.close;
  m.el.querySelector("#uGo").onclick = () =>
    busy(m.el.querySelector("#uGo"), "Unsubscribing…", async () => {
      try {
        await api(`/subscribers/${sub.id}/unsubscribe`, { method: "POST" });
        m.close();
        toast(`Unsubscribed ${sub.email}`);
        onDone?.();
      } catch (e) {
        toast(e.message);
      }
    });
}

// Boot: establish who we are before routing.
// - dev: no valid token yet → mint one from the dev-only endpoint (404 in prod).
// - a stored token can be stale (signed with an old dev secret, or expired). In dev
//   we recover silently — drop it, re-mint, probe once more — so a leftover token
//   never dead-ends the editor on "Session expired". In Access mode the dev endpoint
//   is absent, so re-minting is a no-op and we fall through to the re-login screen.
// - probe /api/whoami with redirect:"manual" so an Access edge bounce surfaces as
//   an opaque redirect (→ re-login) distinct from the app's own clean 401.
async function boot() {
  // Mint a dev token into localStorage. Returns false in prod, where the endpoint
  // 404s (or is unreachable) and the Access cookie authenticates instead.
  async function mintDevToken() {
    try {
      const r = await fetch("/api/dev/token?kind=human");
      if (r.ok) {
        setToken((await r.json()).token);
        return true;
      }
    } catch {
      /* prod: endpoint is absent; the Access cookie authenticates instead */
    }
    return false;
  }
  // Probe identity. A network error or an opaque Access redirect can't be recovered
  // here, so surface it as a null result (→ re-login screen).
  async function whoami() {
    try {
      return await fetch("/api/whoami", { headers: authHeaders(), redirect: "manual" });
    } catch {
      return null;
    }
  }

  if (!token) {
    await mintDevToken();
  }
  let res = await whoami();
  // Stale stored token in dev: clear it, mint a fresh one, and probe again so a
  // leftover credential self-heals. In Access mode the re-mint fails, `res` stays
  // unauthorized, and we drop through to showReauth() below.
  if (!res?.ok && token) {
    setToken("");
    if (await mintDevToken()) {
      res = await whoami();
    }
  }
  if (res?.ok) {
    session = await res.json();
    document.body.classList.remove("signed-out");
    renderIdentity();
    // Load the publication identity for the sidebar brand. Non-fatal: on failure the
    // brand keeps its "Kestrel" placeholder and routing still proceeds.
    try {
      appConfig = await api("/api/settings");
    } catch {
      /* keep the placeholder brand */
    }
    renderSidebarBrand();
    return route();
  }
  // opaque redirect (edge login bounce) or a clean 401 with no way to recover here.
  return showReauth();
}
boot();
