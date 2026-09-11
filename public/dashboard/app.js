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
// The publication's name / tagline / logo / brand color come from the settings
// surface (settings.publication). Each field falls back sensibly when unset: the
// name from the From: display name (the read-only deployment reflection), a neutral
// initial tile for the logo, and the theme accent for the color.
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
    color: p.brandColor || null,
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
  // A brand color tints the logo tile; otherwise it uses the theme accent.
  if (pub.color) {
    document.documentElement.style.setProperty("--brand", pub.color);
  } else {
    document.documentElement.style.removeProperty("--brand");
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
  setTimeout(() => t.classList.remove("show"), 2400);
  setTimeout(() => t.remove(), 2700);
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
function untilStr(fireAt) {
  const d = fireAt - Date.now();
  if (d <= 0) {
    return "firing now…";
  }
  const s = Math.floor(d / 1000),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  if (h > 0) {
    return `fires in ${h}h ${m}m`;
  }
  return `fires in ${m}m ${String(sec).padStart(2, "0")}s`;
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
  container.innerHTML = `<div class="error"><span>${esc(msg)}</span><button class="ghost-btn" data-retry>Retry</button></div>`;
  const b = container.querySelector("[data-retry]");
  if (b) {
    b.onclick = retryFn;
  }
}

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
  clearAutosaveTimers();
  isEditorDirty = false;
  editorSaveFailed = false;
  editorConflict = false;
  editorHash = null; // renderEditor re-establishes these when it mounts
  editorLeaveFlush = null;
  editorManualSave = null;
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
  if (view === "posts") {
    return renderPosts();
  }
  if (view === "subscribers") {
    return renderSubscribers();
  }
  if (view === "sends") {
    return renderSends();
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

// ---- posts list ----
async function renderPosts() {
  app.innerHTML = `<div class="spread page-head"><h1>Posts</h1><button class="primary" id="newPost">New post</button></div><div id="list" class="muted">Loading…</div>`;
  document.getElementById("newPost").onclick = (e) => createNewPost(e.currentTarget);
  try {
    const { posts } = await api("/posts");
    const list = document.getElementById("list");
    if (!posts.length) {
      list.innerHTML = `<p class="muted">No posts yet — create your first draft.</p>`;
      return;
    }
    list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Status</th><th>Scheduled</th><th>Updated</th><th></th></tr></thead><tbody>${posts
      .map(
        (p) =>
          `<tr class="clickable" data-id="${p.id}"><td><a href="#/edit/${p.id}">${esc(p.subject) || "<em>untitled</em>"}</a></td><td>${badge(p.status)}</td><td class="muted">${p.fire_at ? fmt(p.fire_at) : "—"}</td><td class="muted">${fmt(p.updated_at)}</td><td class="act"><button class="menu-btn" data-menu="${p.id}" data-status="${p.status}" aria-label="Post actions">⋯</button></td></tr>`,
      )
      .join("")}</tbody></table></div>`;
    list.querySelectorAll("tr[data-id]").forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.tagName !== "A" && !e.target.closest(".menu-btn")) {
          location.hash = `#/edit/${tr.dataset.id}`;
        }
      };
    });
    list.querySelectorAll(".menu-btn").forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        const pid = b.dataset.menu;
        const items = [{ label: "Open", onClick: () => (location.hash = `#/edit/${pid}`) }];
        if (b.dataset.status === "draft") {
          items.push({ label: "Delete draft", danger: true, onClick: () => confirmDelete(pid) });
        }
        openMenu(b, items);
      };
    });
  } catch (e) {
    renderError(document.getElementById("list"), e.message, renderPosts);
  }
}

function confirmDelete(pid) {
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
        renderPosts();
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
  } catch (e) {
    renderError(app, e.message, () => renderEditor(id));
    return;
  }

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
      <a href="#/posts" class="back">← Posts</a>
      <div class="editor-head-right">
        <button type="button" class="ghost-btn" id="openBtn">Open in browser ↗</button>
        ${badge(post.status)}
      </div>
    </div>
    ${locked && scheduled ? `<div class="sched-banner"><span>📅 Scheduled for <strong>${esc(fmt(scheduled.fire_at))}</strong></span><button type="button" class="ghost-btn" id="cancelSchedule">Cancel</button></div>` : ""}
    <div id="freshnessBanner" class="fresh-banner" hidden></div>
    <div class="card">
      <div class="grid2">
        <div><label for="f-subject">Subject</label><input id="f-subject" value="${esc(post.subject)}" ${dis}></div>
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
          <div class="toolbar" role="toolbar" aria-label="Formatting">${toolbarHtml}</div>
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
        <div class="row">
          <button id="saveBtn" ${dis}>Save draft</button>
          <button id="testBtn">Send test email</button>
        </div>
        ${
          locked
            ? ``
            : `<div class="row"><button id="scheduleBtn">Schedule</button><button class="primary" id="sendBtn">Send now</button></div>`
        }
      </div>
    </div>`;

  const ta = document.getElementById("f-markdown");
  const toolbarEl = app.querySelector(".toolbar");
  const previewFrame = document.getElementById("previewFrame");
  const get = (k) => document.getElementById(`f-${k}`).value;
  const collect = () => ({ subject: get("subject"), slug: get("slug"), markdown: get("markdown") });

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

    // An empty subject can't be sent — the server blocks it in freeze() (SPEC §6).
    // Disable Schedule / Send now (with the reason on hover) so the feedback comes
    // before the request round-trips. Whitespace-only counts as empty.
    const sendGuardBtns = [
      document.getElementById("scheduleBtn"),
      document.getElementById("sendBtn"),
    ];
    const reflectSendGuard = () => {
      const empty = subjectEl.value.trim() === "";
      for (const btn of sendGuardBtns) {
        if (!btn) {
          continue;
        }
        btn.disabled = empty;
        btn.title = empty ? "Add a subject before sending" : "";
      }
    };
    subjectEl.addEventListener("input", reflectSendGuard);
    reflectSendGuard();
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
  // current values differ. We reflect that on the Save button (tint + • suffix),
  // guard navigation (at the router, via isEditorDirty), and autosave.
  editorHash = location.hash;
  const saveBtn = document.getElementById("saveBtn");
  const snapshot = () => JSON.stringify(collect());
  let savedSnapshot = snapshot();
  let saving = false;
  function refreshDirty() {
    isEditorDirty = snapshot() !== savedSnapshot;
    if (saveBtn) {
      saveBtn.classList.toggle("unsaved", isEditorDirty);
    }
    if (saveBtn && !saving) {
      saveBtn.textContent = isEditorDirty ? "Save draft •" : "Save draft";
    }
  }
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
      freshnessEl.innerHTML = `<span>⚠️ This draft was scheduled elsewhere and can no longer be edited here.</span><span class="row"><button type="button" class="ghost-btn" id="freshReload">Reload</button></span>`;
    } else {
      warnedRevision = info.current_revision;
      const who = friendlyAuthor(info.author);
      freshnessEl.innerHTML =
        `<span>⚠️ This draft was changed elsewhere${who ? ` — last edited by <strong>${esc(who)}</strong>` : ""}. Reload to load that version (discards your unsaved edits), or keep editing to overwrite it on your next save.</span>` +
        `<span class="row"><button type="button" class="ghost-btn" id="freshReload">Reload</button><button type="button" class="ghost-btn" id="freshKeep">Keep editing</button></span>`;
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
            sent === addrs.length
              ? `Test sent to ${sent} address${sent === 1 ? "" : "es"}`
              : `Sent ${sent}/${addrs.length} — some failed`,
          );
        } catch (e) {
          toast(e.message);
        }
      });
  };

  // --- schedule (modal with datetime-local) ---
  const scheduleBtn = document.getElementById("scheduleBtn");
  if (scheduleBtn) {
    scheduleBtn.onclick = () => {
      const minStr = toLocalInput(new Date(Date.now() + 6 * 60000));
      const def = toLocalInput(new Date(Date.now() + 24 * 3600 * 1000));
      const m = modal(
        `<h3>Schedule this issue</h3><p class="hint">It sends at the time you pick (at least 5 minutes out), with a cancelable window until then.</p><label for="schWhen">Send at</label><input type="datetime-local" id="schWhen" min="${minStr}" value="${def}"><div class="actions"><button type="button" id="schCancel">Cancel</button><button type="button" class="primary" id="schGo">Schedule</button></div>`,
      );
      m.el.querySelector("#schCancel").onclick = m.close;
      m.el.querySelector("#schGo").onclick = () =>
        busy(m.el.querySelector("#schGo"), "Scheduling…", async () => {
          const v = m.el.querySelector("#schWhen").value;
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
            toast("Scheduled");
            location.hash = "#/sends";
          } catch (e) {
            toast(e.message);
          }
        });
    };
  }

  // --- send now (modal with recipient count) ---
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) {
    sendBtn.onclick = async () => {
      let who = "your confirmed subscribers";
      try {
        const s = await api("/subscribers");
        const n = s.counts.confirmed;
        who = `${n} confirmed subscriber${n === 1 ? "" : "s"}`;
      } catch (_) {}
      const m = modal(
        `<h3>Send now?</h3><p class="hint">Freezes the current draft and sends it to <strong>${esc(who)}</strong> after a 5-minute cancelable window. You can cancel from Status until it fires.</p><div class="actions"><button type="button" id="snCancel">Cancel</button><button type="button" class="primary" id="snGo">Send now</button></div>`,
      );
      m.el.querySelector("#snCancel").onclick = m.close;
      m.el.querySelector("#snGo").onclick = () =>
        busy(m.el.querySelector("#snGo"), "Queuing…", async () => {
          try {
            await saveDraft(true);
            await api(`/posts/${id}/send`, { method: "POST" });
            m.close();
            toast("Queued — cancelable for 5 minutes");
            location.hash = "#/sends";
          } catch (e) {
            toast(e.message);
          }
        });
    };
  }
}

// ---- sends ----
function startCountdowns() {
  const tick = () =>
    document.querySelectorAll("[data-fire]").forEach((el) => {
      el.textContent = untilStr(Number(el.dataset.fire));
    });
  tick();
  statusTimer = setInterval(tick, 1000);
}

async function renderSends() {
  app.innerHTML = `<h1>Sends</h1><h2>Scheduled</h2><div id="scheduled"></div><h2>Recent sends</h2><div id="recent"></div>`;
  try {
    const { sends } = await api("/sends");
    // The API returns fire_at DESC (newest-first, which the Recent list below wants).
    // Scheduled is the upcoming queue, so flip it to soonest-first — the next send to
    // fire, and the one you'd reach for the cancel window on, sits at the top.
    const scheduled = sends
      .filter((s) => s.status === "scheduled")
      .sort((a, b) => a.fire_at - b.fire_at);
    const recent = sends
      .filter((s) => s.status === "sent" || s.status === "sending" || s.status === "failed")
      .slice(0, 20);

    document.getElementById("scheduled").innerHTML = scheduled.length
      ? scheduled
          .map(
            (s) =>
              `<div class="card spread clickable" data-post="${s.post_id}"><div><strong><a class="card-link" href="#/edit/${s.post_id}">${esc(s.subject)}</a></strong><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div><button class="danger-subtle" data-cancel="${s.id}">Cancel</button></div>`,
          )
          .join("")
      : `<p class="muted">Nothing scheduled.</p>`;
    // The whole card opens the issue; the subject link handles keyboard/middle-click,
    // and Cancel opts out of navigation (like the posts table's row-click guard).
    document.querySelectorAll("#scheduled .card.clickable").forEach((card) => {
      card.onclick = (e) => {
        if (e.target.tagName !== "A" && !e.target.closest("[data-cancel]")) {
          location.hash = `#/edit/${card.dataset.post}`;
        }
      };
    });
    document.querySelectorAll("[data-cancel]").forEach((b) => {
      b.onclick = () =>
        busy(b, "Canceling…", async () => {
          try {
            await api(`/sends/${b.dataset.cancel}/cancel`, { method: "POST" });
            toast("Canceled");
            renderSends();
          } catch (e) {
            toast(e.message);
          }
        });
    });
    startCountdowns();

    document.getElementById("recent").innerHTML = recent.length
      ? `<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th></tr></thead><tbody>${recent
          .map(
            (s) =>
              `<tr><td>${esc(s.subject)}</td><td>${badge(s.status)}</td><td class="num">${s.recipient_count}</td><td class="num">${s.progress?.accepted || 0}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : `<p class="muted">No sends yet.</p>`;
  } catch (e) {
    renderError(document.getElementById("scheduled"), e.message, renderSends);
  }
}

// ---- subscribers ----
// The story of the list as a whole: its composition (by-status counts) and the
// roster, filterable and searchable. Sends/scheduling live on Status instead.
async function renderSubscribers() {
  app.innerHTML = `
    <div class="spread page-head"><h1>Subscribers</h1><button class="primary" id="addSub">Add subscriber</button></div>
    <div id="subCounts" class="muted">Loading…</div>
    <div class="row sub-controls">
      <select id="subFilter" aria-label="Filter by status">
        <option value="">All statuses</option>
        <option value="confirmed">Confirmed</option>
        <option value="pending">Pending</option>
        <option value="unsubscribed">Unsubscribed</option>
      </select>
      <input id="subSearch" type="search" placeholder="Search email…" aria-label="Search email" autocomplete="off">
    </div>
    <div id="subList" class="muted">Loading…</div>`;

  const filterEl = document.getElementById("subFilter");
  const searchEl = document.getElementById("subSearch");
  let searchTimer = null;

  async function load() {
    const params = new URLSearchParams();
    if (filterEl.value) {
      params.set("status", filterEl.value);
    }
    const term = searchEl.value.trim();
    if (term) {
      params.set("search", term);
    }
    const qs = params.toString();
    const listEl = document.getElementById("subList");
    try {
      const data = await api(`/subscribers${qs ? `?${qs}` : ""}`);
      const c = data.counts;
      document.getElementById("subCounts").innerHTML =
        `<div class="card row" style="gap:24px"><span><strong>${c.confirmed}</strong> confirmed</span><span>${c.pending} pending</span><span>${c.unsubscribed} unsubscribed</span><span>${c.suppressed} suppressed</span>${infoTip(
          "Pending: subscribed but hasn't clicked the confirmation email. Confirmed: consented — receives sends. Unsubscribed: opted out. Suppressed: bounced or complained — never mailed, whatever the consent state.",
          { below: true },
        )}</div>`;
      renderSubTable(listEl, data.subscribers, load);
    } catch (e) {
      renderError(listEl, e.message, load);
    }
  }

  document.getElementById("addSub").onclick = () => addSubscriberModal(load);
  filterEl.onchange = load;
  searchEl.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 250);
  };
  load();
}

function renderSubTable(listEl, rows, reload) {
  if (!rows.length) {
    listEl.innerHTML = `<p class="muted">No subscribers match.</p>`;
    return;
  }
  listEl.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Email</th><th>Status</th><th>Confirmed / created</th><th></th></tr></thead><tbody>${rows
    .map(
      (s) =>
        `<tr data-id="${s.id}"><td>${esc(s.email)}</td><td>${badge(s.status)}${s.suppressed ? ` ${badge("suppressed")}` : ""}</td><td class="muted">${fmt(s.confirmed_at || s.created_at)}</td><td class="act">${s.status === "confirmed" ? `<button class="menu-btn" data-menu="${s.id}" aria-label="Subscriber actions">⋯</button>` : ""}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
  listEl.querySelectorAll(".menu-btn").forEach((b) => {
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
async function renderSettings() {
  app.innerHTML = `<h1>Settings</h1><div id="settingsBody" class="muted">Loading…</div>`;
  const body = document.getElementById("settingsBody");
  let data;
  try {
    data = await api("/api/settings");
  } catch (e) {
    renderError(body, e.message, renderSettings);
    return;
  }
  const s = data.settings,
    d = data.deployment;
  const p = s.publication || { name: "", tagline: "", brandColor: "", logoUrl: "" };
  const fromName = parseFromName(d.fromAddress) || "Your publication";
  const kv = (k, v) => `<tr><td class="muted">${esc(k)}</td><td>${esc(v)}</td></tr>`;
  body.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">Publication identity</h2>
      <p class="hint">Your publication's name, tagline, logo, and brand color. These theme the reader surface and this dashboard — never the email itself (its identity is the From address) and never an already-sent issue.</p>
      <div class="logo-row">
        <div class="logo-preview" id="logoPreview">${
          p.logoUrl
            ? `<img src="${esc(p.logoUrl)}" alt="Current logo">`
            : `<span class="logo-placeholder">${esc((p.name || fromName).trim()[0] || "K").toUpperCase()}</span>`
        }</div>
        <div class="logo-actions">
          <input type="file" id="logoInput" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>
          <div class="row">
            <button id="logoUpload">${p.logoUrl ? "Replace logo" : "Upload logo"}</button>
            <button class="danger-subtle" id="logoRemove"${p.logoUrl ? "" : " hidden"}>Remove</button>
          </div>
          <p class="hint" style="margin:8px 0 0">PNG, JPEG, WebP, GIF, or SVG, up to 512&nbsp;KB. An SVG can follow light/dark with an internal <code>@media (prefers-color-scheme: dark)</code> rule — <code>currentColor</code> won't inherit, since the logo loads as an image.</p>
        </div>
      </div>
      <div class="grid2" style="margin-top:4px">
        <div>
          <label for="setName">Name</label>
          <input id="setName" value="${esc(p.name)}" placeholder="${esc(fromName)}" maxlength="120">
          <p class="field-hint">Blank falls back to the From name (“${esc(fromName)}”).</p>
        </div>
        <div>
          <label for="setTagline">Tagline</label>
          <input id="setTagline" value="${esc(p.tagline)}" placeholder="A one-line description" maxlength="200">
        </div>
      </div>
      <label for="setBrandHex">Brand color</label>
      <div class="row brand-row">
        <input type="color" id="setBrandColor" value="${esc(p.brandColor || "#2563eb")}" aria-label="Brand color picker">
        <input type="text" id="setBrandHex" class="brand-hex" value="${esc(p.brandColor)}" placeholder="#2563eb">
        <button class="ghost-btn" id="setBrandClear">Clear</button>
      </div>
      <p class="field-hint">Blank uses the theme default.</p>
      <div class="row" style="margin-top:14px"><button class="primary" id="idSave">Save identity</button></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Default test recipients</h2>
      <p class="hint">Pre-filled into <strong>Send test email</strong>. One address per line. These are your own inboxes — they don't go through the subscribe/consent flow.</p>
      <textarea id="setTestRecipients" rows="4" placeholder="you@example.com">${esc(s.testRecipients.join("\n"))}</textarea>
      <div class="row" style="margin-top:12px"><button class="primary" id="setSave">Save</button></div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Deployment</h2>
      <p class="hint">Set at deploy time (env vars + secrets), shown here read-only. To change any of these, see <a href="#/docs">Docs</a> — the operator setup guide. Credentials are never shown.</p>
      <div class="table-wrap"><table><tbody>
        ${kv("Email sender", PROVIDER_LABELS[d.provider] || d.provider)}
        ${kv("From address", d.fromAddress)}
        ${kv("Sending domain", d.sendingDomain)}
        ${kv("App origin", d.appOrigin)}
        ${kv("Archive URL base", d.archiveOrigin + d.archiveBasePath)}
        ${kv("Image URL base", d.mediaPublicBase)}
        ${kv("Auth mode", d.authMode === "access" ? "Cloudflare Access" : "Local dev token")}
        ${kv("Access configured", d.accessConfigured ? "Yes" : "No")}
      </tbody></table></div>
    </div>`;

  // Keep the cached config + sidebar brand in step with a save (the brand reads the
  // same publication identity), and re-render the Settings view so the logo preview
  // reflects a new/removed logo.
  const applySettings = (settings) => {
    appConfig = { ...(appConfig || {}), settings };
    renderSidebarBrand();
  };

  // --- brand color: the text field is the source of truth ("" = theme default);
  // the picker is a convenience that writes into it.
  const colorEl = document.getElementById("setBrandColor");
  const hexEl = document.getElementById("setBrandHex");
  colorEl.oninput = () => {
    hexEl.value = colorEl.value;
  };
  hexEl.oninput = () => {
    if (/^#[0-9a-fA-F]{6}$/.test(hexEl.value.trim())) {
      colorEl.value = hexEl.value.trim();
    }
  };
  document.getElementById("setBrandClear").onclick = () => {
    hexEl.value = "";
    hexEl.focus();
  };

  document.getElementById("idSave").onclick = (e) =>
    busy(e.currentTarget, "Saving…", async () => {
      try {
        const r = await api("/api/settings", {
          method: "PUT",
          json: {
            publication: {
              name: document.getElementById("setName").value.trim(),
              tagline: document.getElementById("setTagline").value.trim(),
              brandColor: hexEl.value.trim(),
            },
          },
        });
        applySettings(r.settings);
        toast("Identity saved");
        renderSettings();
      } catch (err) {
        toast(err.message);
      }
    });

  // --- logo upload / remove (immediate; their own endpoints).
  const logoInput = document.getElementById("logoInput");
  document.getElementById("logoUpload").onclick = () => logoInput.click();
  logoInput.onchange = async () => {
    const file = logoInput.files[0];
    logoInput.value = "";
    if (!file) {
      return;
    }
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await api("/api/settings/logo", { method: "POST", body: fd });
      applySettings(r.settings);
      toast("Logo updated");
      renderSettings();
    } catch (err) {
      toast(err.message);
    }
  };
  const removeBtn = document.getElementById("logoRemove");
  if (removeBtn) {
    removeBtn.onclick = () =>
      busy(removeBtn, "Removing…", async () => {
        try {
          const r = await api("/api/settings/logo", { method: "DELETE" });
          applySettings(r.settings);
          toast("Logo removed");
          renderSettings();
        } catch (err) {
          toast(err.message);
        }
      });
  }

  document.getElementById("setSave").onclick = (e) =>
    busy(e.currentTarget, "Saving…", async () => {
      const list = parseAddresses(document.getElementById("setTestRecipients").value);
      try {
        const r = await api("/api/settings", { method: "PUT", json: { testRecipients: list } });
        document.getElementById("setTestRecipients").value = r.settings.testRecipients.join("\n");
        applySettings(r.settings);
        toast("Settings saved");
      } catch (err) {
        toast(err.message);
      }
    });
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
function apiRouteHtml(r) {
  return `<div class="api-route">
      <div class="api-route-head">
        <span class="api-method m-${esc(r.method)}">${esc(r.method)}</span>
        <code class="api-path">${esc(r.path)}</code>
        <span class="api-tier">${esc(r.access)}</span>
      </div>
      <p class="api-summary">${esc(r.summary)}</p>
      ${r.description ? `<p class="api-desc muted">${esc(r.description)}</p>` : ""}
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
  const stuck = sending.filter((s) => s.started_at && now - s.started_at > 10 * 60 * 1000);
  if (stuck.length) {
    issues.push({
      level: "amber",
      text: "A send has been in progress over 10 minutes — it may be retrying.",
    });
  } else if (sending.length) {
    issues.push({
      level: "amber",
      text: `${sending.length} send${sending.length === 1 ? " is" : "s are"} in progress.`,
    });
  }
  // Delivery trouble: a high share of send-time failures on a recent send. (The list
  // rollup is by delivery *status* — accepted / failed / skipped — so asynchronous
  // bounce webhook events aren't reflected here; a true bounce-rate view would need a
  // dedicated endpoint, which this reuse-only change deliberately doesn't add.)
  const spiky = sends
    .filter((s) => s.status === "sent")
    .slice(0, 5)
    .find((s) => {
      const f = s.progress?.failed || 0;
      return s.recipient_count > 0 && f >= 3 && f / s.recipient_count >= 0.1;
    });
  if (spiky) {
    issues.push({
      level: "amber",
      text: "Elevated delivery failures on a recent send — check Sends.",
    });
  }
  return issues;
}

async function renderDashboard() {
  app.innerHTML = `<div class="dash" id="dash"><p class="muted">Loading…</p></div>`;
  const root = document.getElementById("dash");
  let posts, sends, counts;
  try {
    const [p, s, subs] = await Promise.all([api("/posts"), api("/sends"), api("/subscribers")]);
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

  const tiles = [
    { label: "Confirmed", sub: "your audience", emph: true, v: counts.confirmed },
    { label: "Pending", v: counts.pending },
    { label: "Unsubscribed", v: counts.unsubscribed },
    { label: "Suppressed", v: counts.suppressed },
  ];
  const tilesHtml = `<div class="tiles">${tiles
    .map(
      (t) =>
        `<a class="tile${t.emph ? " tile-emph" : ""}" href="#/subscribers"><span class="tile-n">${t.v}</span><span class="tile-label">${esc(t.label)}${
          t.sub ? `<span class="tile-sub">${esc(t.sub)}</span>` : ""
        }</span></a>`,
    )
    .join("")}</div>`;

  const scheduled = sends
    .filter((s) => s.status === "scheduled")
    .sort((a, b) => a.fire_at - b.fire_at);
  const nextUpHtml = scheduled.length
    ? scheduled
        .map(
          (s) =>
            `<div class="card spread clickable nextup" data-post="${s.post_id}"><div><strong><a class="card-link" href="#/edit/${s.post_id}">${esc(s.subject)}</a></strong><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div><button class="danger-subtle" data-cancel="${s.id}">Cancel</button></div>`,
        )
        .join("")
    : `<p class="muted">Nothing scheduled.</p>`;

  const slugById = new Map(posts.map((p) => [p.id, p.slug]));
  const recent = sends
    .filter((s) => s.status === "sent" || s.status === "sending" || s.status === "failed")
    .slice(0, 5);
  const recentHtml = recent.length
    ? `<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th><th></th></tr></thead><tbody>${recent
        .map((s) => {
          const slug = slugById.get(s.post_id);
          const url = slug ? archiveUrlFor(deployment, slug) : null;
          const delivered = s.progress?.accepted || 0;
          const failedN = s.progress?.failed || 0;
          return `<tr><td>${esc(s.subject)}</td><td>${badge(s.status)}</td><td class="num">${s.recipient_count}</td><td class="num">${delivered}${
            failedN ? ` <span class="muted">(${failedN} failed)</span>` : ""
          }</td><td class="act">${
            url && s.status === "sent"
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
    <div class="pub-row"><span class="pub-key muted">Publication</span><code class="pub-val">${esc(appOrigin)}</code><button class="ghost-btn" data-copy="${esc(appOrigin)}">Copy</button></div>
    <div class="pub-row"><span class="pub-key muted">Archive</span><code class="pub-val">${esc(archiveBase)}</code><button class="ghost-btn" data-copy="${esc(archiveBase)}">Copy</button></div>
    <div class="pub-foot"><a href="/" target="_blank" rel="noopener">View publication&nbsp;↗</a></div>
  </div>`;

  // Connect the API — the API's first client is an agent, so the base URL is
  // copyable right here (no need to open the reference room to wire up Claude).
  const apiCardHtml = `<div class="card pub-card">
    <div class="pub-row"><span class="pub-key muted">Base&nbsp;URL</span><code class="pub-val">${esc(appOrigin)}</code><button class="ghost-btn" data-copy="${esc(appOrigin)}">Copy</button></div>
    <p class="pub-note">One API drives Kestrel — the editor and Claude are equal clients of it. <a href="#/reference">Browse the API reference →</a></p>
  </div>`;

  const quickHtml = `<div class="row quick-actions"><button class="primary" data-act="new-post">New post</button><button data-act="add-sub">Add subscriber</button><button data-nav="#/settings">Edit identity &amp; template</button></div>`;

  root.innerHTML = `
    <div class="dash-head">
      <div><h1>${esc(pub.name)}</h1>${pub.tagline ? `<p class="muted dash-tagline">${esc(pub.tagline)}</p>` : ""}</div>
      <button class="primary" data-act="new-post">New post</button>
    </div>
    ${healthHtml}
    <section class="dash-section"><h2>Subscribers</h2>${tilesHtml}</section>
    <div class="dash-cols">
      <section class="dash-section"><h2>Next up</h2>${nextUpHtml}</section>
      <section class="dash-section"><h2>Continue writing</h2>${draftsHtml}</section>
    </div>
    <section class="dash-section"><h2>Recent sends</h2>${recentHtml}</section>
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
  root.querySelectorAll(".nextup").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.tagName !== "A" && !e.target.closest("[data-cancel]")) {
        location.hash = `#/edit/${card.dataset.post}`;
      }
    };
  });
  root.querySelectorAll("[data-cancel]").forEach((b) => {
    b.onclick = () =>
      busy(b, "Canceling…", async () => {
        try {
          await api(`/sends/${b.dataset.cancel}/cancel`, { method: "POST" });
          toast("Canceled");
          renderDashboard();
        } catch (e) {
          toast(e.message);
        }
      });
  });
  startCountdowns();
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
