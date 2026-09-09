"use strict";
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
let statusTimer = null; // countdown interval, cleared on navigation
let editorPollTimer = null; // freshness poll while the editor is open, cleared on navigation
// Autosave uses two timers (see scheduleAutosave): save after a short idle pause,
// but never let an edit sit unsaved longer than the hard cap even while typing.
let autosaveIdleTimer = null;
let autosaveCapTimer = null;
const IDLE_MS = 5000; // quiet pause before a background save
const MAX_MS = 30000; // hard cap: no edit stays unsaved longer than this
function clearAutosaveTimers() {
  if (autosaveIdleTimer) { clearTimeout(autosaveIdleTimer); autosaveIdleTimer = null; }
  if (autosaveCapTimer) { clearTimeout(autosaveCapTimer); autosaveCapTimer = null; }
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

// ---- Material Symbols icon paths (viewBox 0 -960 960 960) ----
const ICONS = {
  heading: "M360-280v-400h80v160h160v-160h80v400h-80v-160H440v160h-80Z",
  bold: "M272-200v-560h221q65 0 120 40t55 111q0 51-23 78.5T602-491q25 11 55.5 41t30.5 90q0 89-65 124.5T501-200H272Zm121-112h104q48 0 58.5-24.5T566-372q0-11-10.5-35.5T494-432H393v120Zm0-228h93q33 0 48-17t15-38q0-24-17-39t-44-15h-95v109Z",
  italic: "M200-200v-100h160l120-360H320v-100h400v100H580L460-300h140v100H200Z",
  quote: "m228-240 92-160q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 23-5.5 42.5T458-480L320-240h-92Zm360 0 92-160q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 23-5.5 42.5T818-480L680-240h-92ZM362.5-517.5Q380-535 380-560t-17.5-42.5Q345-620 320-620t-42.5 17.5Q260-585 260-560t17.5 42.5Q295-500 320-500t42.5-17.5Zm360 0Q740-535 740-560t-17.5-42.5Q705-620 680-620t-42.5 17.5Q620-585 620-560t17.5 42.5Q655-500 680-500t42.5-17.5ZM680-560Zm-360 0Z",
  code: "M320-240 80-480l240-240 57 57-184 184 183 183-56 56Zm320 0-57-57 184-184-183-183 56-56 240 240-240 240Z",
  link: "M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z",
  ul: "M360-200v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360ZM200-160q-33 0-56.5-23.5T120-240q0-33 23.5-56.5T200-320q33 0 56.5 23.5T280-240q0 33-23.5 56.5T200-160Zm0-240q-33 0-56.5-23.5T120-480q0-33 23.5-56.5T200-560q33 0 56.5 23.5T280-480q0 33-23.5 56.5T200-400Zm-56.5-263.5Q120-687 120-720t23.5-56.5Q167-800 200-800t56.5 23.5Q280-753 280-720t-23.5 56.5Q233-640 200-640t-56.5-23.5Z",
  ol: "M120-80v-60h100v-30h-60v-60h60v-30H120v-60h120q17 0 28.5 11.5T280-280v40q0 17-11.5 28.5T240-200q17 0 28.5 11.5T280-160v40q0 17-11.5 28.5T240-80H120Zm0-280v-110q0-17 11.5-28.5T160-510h60v-30H120v-60h120q17 0 28.5 11.5T280-560v70q0 17-11.5 28.5T240-450h-60v30h100v60H120Zm60-280v-180h-60v-60h120v240h-60Zm180 440v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360Z",
  indent: "M120-120v-80h720v80H120Zm320-160v-80h400v80H440Zm0-160v-80h400v80H440Zm0-160v-80h400v80H440ZM120-760v-80h720v80H120Zm0 440v-320l160 160-160 160Z",
  paperclip: "M720-330q0 104-73 177T470-80q-104 0-177-73t-73-177v-370q0-75 52.5-127.5T400-880q75 0 127.5 52.5T580-700v350q0 46-32 78t-78 32q-46 0-78-32t-32-78v-370h80v370q0 13 8.5 21.5T470-320q13 0 21.5-8.5T500-350v-350q-1-42-29.5-71T400-800q-42 0-71 29t-29 71v370q-1 71 49 120.5T470-160q70 0 119-49.5T640-330v-390h80v390Z",
  info: "M440-280h80v-240h-80v240Zm68.5-331.5Q520-623 520-640t-11.5-28.5Q497-680 480-680t-28.5 11.5Q440-657 440-640t11.5 28.5Q463-600 480-600t28.5-11.5ZM480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z",
};
const icon = (name) => `<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

// ---- auth ----
function setToken(t) {
  token = (t || "").trim();
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode */ }
}
// The dev token goes in Authorization; in Access mode there is no token and the
// session cookie authenticates instead, so we send no header.
function authHeaders() { return token ? { Authorization: "Bearer " + token } : {}; }

// Renders the topbar identity chip from `session`, and handles an auth failure by
// steering to the right recovery: re-login (Access) vs. re-mint (dev).
function renderIdentity() {
  if (!identity) return;
  const mode = session && session.auth && session.auth.mode;
  const p = (session && session.principal) || {};
  if (mode === "access") {
    const who = p.email || (p.kind === "service" ? "Service token" : "Signed in");
    identity.innerHTML = `<span class="who" title="${esc(who)}">${esc(who)}</span>` +
      `<a class="ghost" href="/cdn-cgi/access/logout">Sign out</a>`;
  } else {
    identity.innerHTML = `<span class="who dev" title="Local dev — auth is bypassed on localhost">Local dev</span>`;
  }
}
// Access sessions expire at the edge (the request never reaches the app), so the
// only recovery is a fresh document load that re-triggers the Access login. In dev
// this shouldn't happen, but a reload re-mints, so the same affordance is safe.
function showReauth() {
  app.innerHTML = `<div class="card auth-wall"><h2>Session expired</h2>` +
    `<p class="hint">Your access session ended. Sign in again to continue.</p>` +
    `<button id="reauth">Sign in</button></div>`;
  const b = document.getElementById("reauth");
  if (b) b.onclick = () => location.reload();
}

// ---- api ----
async function api(path, opts = {}) {
  const headers = Object.assign(authHeaders(), opts.headers || {});
  if (opts.json !== undefined) { headers["content-type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401) { showReauth(); throw new Error("Not authorized — please sign in again."); }
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

// ---- helpers ----
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg; toasts.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => t.classList.remove("show"), 2400);
  setTimeout(() => t.remove(), 2700);
}
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
const badge = (status) => `<span class="badge ${status}">${status}</span>`;
const fmt = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");

// Client-side slug (mirrors src/lib/slug.ts) for the linked Subject → Slug field.
function clientSlugify(s) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "");
}

function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function untilStr(fireAt) {
  const d = fireAt - Date.now();
  if (d <= 0) return "firing now…";
  const s = Math.floor(d / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `fires in ${h}h ${m}m`;
  return `fires in ${m}m ${String(sec).padStart(2, "0")}s`;
}
function modal(html) {
  const back = document.createElement("div");
  back.className = "modal-backdrop";
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.addEventListener("keydown", function onEsc(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onEsc); } });
  return { el: back, close };
}
async function busy(btn, label, fn) {
  const orig = btn.textContent; btn.disabled = true; if (label) btn.textContent = label;
  try { return await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = orig; } }
}
function renderError(container, msg, retryFn) {
  container.innerHTML = `<div class="error"><span>${esc(msg)}</span><button class="ghost-btn" data-retry>Retry</button></div>`;
  const b = container.querySelector("[data-retry]"); if (b) b.onclick = retryFn;
}

// popover menu for row actions (⋯). A transparent full-screen overlay (behind
// the menu) closes it on an outside click — no document-listener race.
let menuEls = [];
function closeMenu() { menuEls.forEach((e) => e.remove()); menuEls = []; }
function openMenu(anchor, items) {
  closeMenu();
  const overlay = document.createElement("div");
  overlay.className = "menu-overlay";
  overlay.onclick = closeMenu;
  const m = document.createElement("div");
  m.className = "menu";
  items.forEach((it) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "menu-item" + (it.danger ? " danger-item" : ""); b.textContent = it.label;
    b.onclick = () => { closeMenu(); it.onClick(); };
    m.appendChild(b);
  });
  document.body.appendChild(overlay);
  document.body.appendChild(m);
  menuEls = [overlay, m];
  const r = anchor.getBoundingClientRect();
  m.style.top = r.bottom + window.scrollY + 4 + "px";
  m.style.left = r.right + window.scrollX - m.offsetWidth + "px";
}

// ---- router ----
function route() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  if (editorPollTimer) { clearInterval(editorPollTimer); editorPollTimer = null; }
  clearAutosaveTimers();
  isEditorDirty = false; editorSaveFailed = false; editorConflict = false; editorHash = null; // renderEditor re-establishes these when it mounts
  editorLeaveFlush = null; editorManualSave = null;
  const hash = location.hash || "#/posts";
  const [, view, arg] = hash.split("/");
  const current = view === "sends" ? "#/sends" : view === "subscribers" ? "#/subscribers" : view === "docs" ? "#/docs" : "#/posts";
  document.querySelectorAll(".topbar nav a").forEach((a) => {
    if (a.getAttribute("href") === current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (view === "edit" && arg) return renderEditor(arg);
  if (view === "sends") return renderSends();
  if (view === "subscribers") return renderSubscribers();
  if (view === "docs") return renderDocs(arg);
  return renderPosts();
}
// Navigating away from a dirty editor saves in the background rather than
// prompting — hashchange fires after the hash has already moved, so the flush
// captures the payload before route() tears down the DOM. The exception is when
// the last save FAILED: silently flushing could lose work, so we fall back to a
// confirm() (synchronous, unlike the modal helper) and, on cancel, restore the
// editor's hash and swallow the echo.
let revertingHash = false;
window.addEventListener("hashchange", () => {
  if (revertingHash) { revertingHash = false; return; }
  if (isEditorDirty && editorHash && location.hash !== editorHash) {
    if (editorSaveFailed || editorConflict) {
      // A silent flush would fail (or clobber) — prompt so the user decides.
      if (!confirm(LEAVE_MSG)) { revertingHash = true; location.hash = editorHash; return; }
    } else if (editorLeaveFlush) {
      editorLeaveFlush();
    }
  }
  route();
});
// Tab close / reload / external navigation: can't reliably finish an async save,
// so fall back to the browser's own generic unsaved-changes prompt.
window.addEventListener("beforeunload", (e) => { if (isEditorDirty) { e.preventDefault(); e.returnValue = ""; } });
// ⌘S / Ctrl-S saves the mounted editor (registered once; no-op elsewhere).
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && editorManualSave) { e.preventDefault(); editorManualSave(); }
});

// ---- posts list ----
async function renderPosts() {
  app.innerHTML = `<div class="spread page-head"><h1>Posts</h1><button class="primary" id="newPost">New post</button></div><div id="list" class="muted">Loading…</div>`;
  document.getElementById("newPost").onclick = (e) => busy(e.currentTarget, "Creating…", async () => {
    try { const { post } = await api("/posts", { method: "POST", json: { subject: "Untitled" } }); location.hash = "#/edit/" + post.id; }
    catch (err) { toast(err.message); }
  });
  try {
    const { posts } = await api("/posts");
    const list = document.getElementById("list");
    if (!posts.length) { list.innerHTML = `<p class="muted">No posts yet — create your first draft.</p>`; return; }
    list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Status</th><th>Scheduled</th><th>Updated</th><th></th></tr></thead><tbody>${posts
      .map((p) => `<tr class="clickable" data-id="${p.id}"><td><a href="#/edit/${p.id}">${esc(p.subject) || "<em>untitled</em>"}</a></td><td>${badge(p.status)}</td><td class="muted">${p.fire_at ? fmt(p.fire_at) : "—"}</td><td class="muted">${fmt(p.updated_at)}</td><td class="act"><button class="menu-btn" data-menu="${p.id}" data-status="${p.status}" aria-label="Post actions">⋯</button></td></tr>`)
      .join("")}</tbody></table></div>`;
    list.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = (e) => { if (e.target.tagName !== "A" && !e.target.closest(".menu-btn")) location.hash = "#/edit/" + tr.dataset.id; }));
    list.querySelectorAll(".menu-btn").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const pid = b.dataset.menu;
      const items = [{ label: "Open", onClick: () => (location.hash = "#/edit/" + pid) }];
      if (b.dataset.status === "draft") items.push({ label: "Delete draft", danger: true, onClick: () => confirmDelete(pid) });
      openMenu(b, items);
    }));
  } catch (e) { renderError(document.getElementById("list"), e.message, renderPosts); }
}

function confirmDelete(pid) {
  const m = modal(`<h3>Delete draft?</h3><p class="hint">This permanently deletes the draft and its revisions. This can't be undone.</p><div class="actions"><button type="button" id="dCancel">Cancel</button><button type="button" class="danger" id="dGo">Delete</button></div>`);
  m.el.querySelector("#dCancel").onclick = m.close;
  m.el.querySelector("#dGo").onclick = () => busy(m.el.querySelector("#dGo"), "Deleting…", async () => {
    try { await api("/posts/" + pid, { method: "DELETE" }); m.close(); toast("Draft deleted"); renderPosts(); }
    catch (e) { toast(e.message); }
  });
}

// ---- editor ----
const TOOLBAR = [
  [["heading", "Heading"], ["bold", "Bold (⌘B)"], ["italic", "Italic (⌘I)"]],
  [["quote", "Quote"], ["code", "Code"], ["link", "Link (⌘K)"]],
  [["ul", "Bulleted list"], ["ol", "Numbered list"], ["indent", "Indent"]],
];

async function renderEditor(id) {
  clearAutosaveTimers();
  isEditorDirty = false; editorSaveFailed = false; editorConflict = false; editorHash = null; // fresh mount starts clean; the tracking block below re-establishes the hash
  editorLeaveFlush = null; editorManualSave = null;
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let post, markdown, scheduled;
  try { const data = await api("/posts/" + id); post = data.post; markdown = data.markdown; scheduled = data.scheduled; }
  catch (e) { renderError(app, e.message, () => renderEditor(id)); return; }

  const locked = post.status !== "draft";
  // The revision this editor is based on, for optimistic concurrency (SPEC §4).
  // Advanced on each successful save; carried on every save so the server rejects
  // (409) rather than clobbers a newer save from another tab or from Claude.
  let baseRevision = post.current_revision;
  let warnedRevision = null; // newest revision we've surfaced, so we re-arm only on a genuinely newer one
  const toolbarHtml = TOOLBAR
    .map((group) => group.map(([kind, label]) => `<button type="button" class="tb" data-fmt="${kind}" title="${label}" aria-label="${label}">${icon(kind)}</button>`).join(""))
    .join(`<span class="sep"></span>`);
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
            <span class="info" role="img" aria-label="The web address of this issue's archive page." data-tip="The web address of this issue's archive page.">${icon("info")}</span>
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
        ${locked
          ? ``
          : `<div class="row"><button id="scheduleBtn">Schedule</button><button class="primary" id="sendBtn">Send now</button></div>`}
      </div>
    </div>`;

  const ta = document.getElementById("f-markdown");
  const toolbarEl = app.querySelector(".toolbar");
  const previewFrame = document.getElementById("previewFrame");
  const get = (k) => document.getElementById("f-" + k).value;
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
    autoEl.checked = v === "" || v === base || (base !== "" && new RegExp(`^${base}-\\d+$`).test(v));

    // Muted while it tracks the subject; normal color once it's a hand-set slug.
    const reflect = () => slugEl.classList.toggle("slug-auto", autoEl.checked);
    reflect();
    if (autoEl.checked && v === "") slugEl.value = derive();

    subjectEl.addEventListener("input", () => { if (autoEl.checked) slugEl.value = derive(); });
    // Typing a slug takes manual control; clearing it re-links to the subject.
    slugEl.addEventListener("input", () => { autoEl.checked = slugEl.value.trim() === ""; reflect(); });
    // Ticking the box re-derives; unticking hands over the field ready to edit.
    autoEl.addEventListener("change", () => {
      reflect();
      if (autoEl.checked) slugEl.value = derive();
      else { slugEl.focus(); slugEl.select(); }
      markEdited(); // the checkbox mutates the slug without an input event
    });
    // Never leave an empty slug: on blur, fall back to the subject-derived one.
    slugEl.addEventListener("blur", () => {
      if (slugEl.value.trim() === "") { autoEl.checked = true; reflect(); slugEl.value = derive(); markEdited(); }
    });
  }

  // --- tabs ---
  const tabs = app.querySelectorAll(".ctab");
  function showTab(name) {
    tabs.forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle("active", on); t.setAttribute("aria-selected", on ? "true" : "false"); });
    ta.hidden = name !== "write"; previewFrame.hidden = name !== "preview";
    toolbarEl.classList.toggle("off", name !== "write");
  }
  async function showPreview() {
    showTab("preview");
    try {
      if (!locked) await saveDraft(true);
      const res = await fetch("/posts/" + id + "/preview", { headers: authHeaders() });
      previewFrame.srcdoc = await res.text();
      previewFrame.onload = () => { try { previewFrame.style.height = previewFrame.contentDocument.body.scrollHeight + 24 + "px"; } catch (_) {} };
    } catch (e) { toast(e.message); }
  }
  tabs.forEach((t) => (t.onclick = () => (t.dataset.tab === "preview" ? showPreview() : showTab("write"))));

  // --- formatting toolbar ---
  function wrapSel(before, after, placeholder) {
    const s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e) || placeholder;
    ta.value = ta.value.slice(0, s) + before + sel + after + ta.value.slice(e);
    ta.focus(); ta.selectionStart = s + before.length; ta.selectionEnd = s + before.length + sel.length;
  }
  function prefixLines(prefix) {
    const s = ta.selectionStart, e = ta.selectionEnd, start = ta.value.lastIndexOf("\n", s - 1) + 1;
    const out = (ta.value.slice(start, e) || "").split("\n").map((l) => prefix + l).join("\n");
    ta.value = ta.value.slice(0, start) + out + ta.value.slice(e);
    ta.focus(); ta.selectionStart = start; ta.selectionEnd = start + out.length;
  }
  function applyFormat(kind) {
    if (locked) return;
    showTab("write");
    if (kind === "bold") wrapSel("**", "**", "bold text");
    else if (kind === "italic") wrapSel("*", "*", "italic text");
    else if (kind === "heading") prefixLines("## ");
    else if (kind === "quote") prefixLines("> ");
    else if (kind === "ul") prefixLines("- ");
    else if (kind === "ol") prefixLines("1. ");
    else if (kind === "indent") prefixLines("  ");
    else if (kind === "link") wrapSel("[", "](https://)", "link text");
    else if (kind === "code") {
      const s = ta.selectionStart, e = ta.selectionEnd;
      if (s === e || ta.value.slice(s, e).includes("\n")) wrapSel("```\n", "\n```", "code");
      else wrapSel("`", "`", "code");
    }
    markEdited();
  }
  app.querySelectorAll(".tb[data-fmt]").forEach((b) => (b.onclick = () => applyFormat(b.dataset.fmt)));
  ta.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); applyFormat("bold"); }
    else if (k === "i") { e.preventDefault(); applyFormat("italic"); }
    else if (k === "k") { e.preventDefault(); applyFormat("link"); }
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
    if (saveBtn) saveBtn.classList.toggle("unsaved", isEditorDirty);
    if (saveBtn && !saving) saveBtn.textContent = isEditorDirty ? "Save draft •" : "Save draft";
  }
  // Autosave: save after IDLE_MS of quiet, but never let an edit sit unsaved
  // longer than MAX_MS even during continuous typing (the idle timer keeps
  // resetting; the cap timer, started on the first edit after a save, does not).
  // Manual Save + ⌘S stays the primary path; this is the safety net.
  function scheduleAutosave() {
    if (autosaveIdleTimer) clearTimeout(autosaveIdleTimer);
    autosaveIdleTimer = setTimeout(runAutosave, IDLE_MS);
    if (!autosaveCapTimer) autosaveCapTimer = setTimeout(runAutosave, MAX_MS);
  }
  function runAutosave() {
    clearAutosaveTimers();
    saveDraft(true).catch((e) => toast("Couldn't autosave — " + e.message)); // surface failures, never lose silently
  }
  // Called after any edit — typed, formatted, or an inserted image.
  function markEdited() { if (locked) return; refreshDirty(); if (!editorConflict) scheduleAutosave(); }

  // Saves are chained so an autosave and an explicit save can never overlap; a
  // silent save with nothing pending is skipped.
  let saveChain = Promise.resolve();
  function saveDraft(silent) {
    saveChain = saveChain.catch(() => {}).then(() => doSaveDraft(silent));
    return saveChain;
  }
  async function doSaveDraft(silent) {
    if (silent && snapshot() === savedSnapshot) return null; // nothing changed since the last save
    if (editorConflict) return null; // paused until the out-of-date banner is resolved
    clearAutosaveTimers(); // a save is starting — cancel any pending autosave trigger
    saving = true;
    try {
      const { post: u } = await api("/posts/" + id, { method: "PUT", json: { ...collect(), base_revision: baseRevision } });
      const slugEl = document.getElementById("f-slug");
      // Reflect server-side dedupe, but don't yank the slug from under the cursor
      // if an autosave lands while the field is focused.
      if (u && u.slug && slugEl && document.activeElement !== slugEl) slugEl.value = u.slug;
      baseRevision = u.current_revision; // our save is now the newest; poll against it
      savedSnapshot = snapshot();
      editorSaveFailed = false;
      if (!silent) toast("Saved");
      return u;
    } catch (e) {
      // A stale-revision 409 isn't a plain failure: another writer got there first.
      // Surface the out-of-date banner (notify, don't clobber) instead of an error toast.
      if (e && e.status === 409) {
        showConflict(e.data && e.data.error === "stale_revision" ? { current_revision: e.data.current_revision, author: e.data.author } : { schedLocked: true });
        return null;
      }
      editorSaveFailed = true; // the leave guard now prompts rather than silently flushing
      throw e;
    } finally {
      saving = false;
      refreshDirty();
    }
  }
  if (saveBtn) saveBtn.onclick = () => busy(saveBtn, "Saving…", () => saveDraft(false).catch((e) => toast(e.message))).finally(refreshDirty);

  // Leaving the editor saves in the background instead of prompting. Capture the
  // payload NOW (the router tears down the DOM right after) and send it through
  // the chain so it can't overlap an in-flight save.
  editorLeaveFlush = () => {
    clearAutosaveTimers();
    if (locked || snapshot() === savedSnapshot) return;
    const body = { ...collect(), base_revision: baseRevision };
    savedSnapshot = JSON.stringify(collect()); isEditorDirty = false;
    saveChain = saveChain.catch(() => {}).then(() => api("/posts/" + id, { method: "PUT", json: body }))
      .catch((e) => toast(e.status === 409 ? "Changed elsewhere — your edits weren't saved" : "Couldn't save your changes — " + e.message));
  };
  editorManualSave = () => { if (saveBtn && !saveBtn.disabled) saveBtn.click(); };

  // Typed edits mark dirty; blurring subject/slug flushes promptly. The body is
  // left to the idle/cap timers so a toolbar click (which blurs it) doesn't save
  // on every interaction.
  if (!locked) {
    ["f-subject", "f-slug", "f-markdown"].forEach((k) => document.getElementById(k).addEventListener("input", markEdited));
    ["f-subject", "f-slug"].forEach((k) => document.getElementById(k).addEventListener("blur", () => saveDraft(true).catch((e) => toast("Couldn't save — " + e.message))));
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
    editorConflict = false; warnedRevision = null;
    if (freshnessEl) { freshnessEl.hidden = true; freshnessEl.innerHTML = ""; }
  }
  function showConflict(info) {
    if (!freshnessEl || locked) return;
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
    freshnessEl.querySelector("#freshReload").onclick = () => { clearConflict(); renderEditor(id); };
    const keep = freshnessEl.querySelector("#freshKeep");
    if (keep) keep.onclick = () => {
      baseRevision = warnedRevision; // adopt the newer revision as our base — our next save wins
      clearConflict(); refreshDirty();
      if (isEditorDirty) scheduleAutosave();
    };
  }

  if (!locked) {
    // Skipped while hidden, saving, or already warned — poll GET is cheap and only
    // re-warns on a revision we haven't surfaced yet.
    const pollFreshness = async () => {
      if (saving || editorConflict || document.hidden) return;
      try {
        const data = await api("/posts/" + id);
        if (data.post.status !== "draft") { showConflict({ schedLocked: true }); return; }
        const rev = data.post.current_revision;
        if (rev && rev !== baseRevision && rev !== warnedRevision) showConflict({ current_revision: rev, author: data.author });
      } catch (_) { /* transient — try again next tick */ }
    };
    editorPollTimer = setInterval(pollFreshness, 10000);
  }

  // --- open in browser ---
  const openBtn = document.getElementById("openBtn");
  openBtn.onclick = () => busy(openBtn, "Opening…", async () => {
    try {
      if (!locked) await saveDraft(true);
      const res = await fetch("/posts/" + id + "/preview", { headers: authHeaders() });
      const url = URL.createObjectURL(new Blob([await res.text()], { type: "text/html" }));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) { toast(e.message); }
  });

  // --- cancel schedule (from the scheduled banner) ---
  const cancelScheduleBtn = document.getElementById("cancelSchedule");
  if (cancelScheduleBtn && scheduled) cancelScheduleBtn.onclick = () => busy(cancelScheduleBtn, "Canceling…", async () => {
    try { await api("/sends/" + scheduled.id + "/cancel", { method: "POST" }); toast("Schedule canceled"); renderEditor(id); }
    catch (e) { toast(e.message); }
  });

  // --- image upload: drag/drop, paste, click ---
  async function uploadAndInsert(file) {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const fd = new FormData(); fd.append("file", file);
      const { image } = await api("/posts/" + id + "/images", { method: "POST", body: fd });
      const s = ta.selectionStart, snippet = `\n![${file.name}](${image.filename})\n`;
      ta.value = ta.value.slice(0, s) + snippet + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s + snippet.length;
      markEdited();
      toast("Image added");
    } catch (e) { toast(e.message); }
  }
  if (!locked) {
    const body = document.getElementById("composerBody"), imgInput = document.getElementById("imgInput"), foot = document.getElementById("dropFoot");
    body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("dragover"); });
    body.addEventListener("dragleave", (e) => { if (e.target === body) body.classList.remove("dragover"); });
    body.addEventListener("drop", (e) => { e.preventDefault(); body.classList.remove("dragover"); showTab("write"); for (const f of e.dataTransfer.files) uploadAndInsert(f); });
    ta.addEventListener("paste", (e) => { for (const it of (e.clipboardData && e.clipboardData.items) || []) if (it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) { e.preventDefault(); uploadAndInsert(f); } } });
    foot.onclick = () => imgInput.click();
    imgInput.onchange = () => { for (const f of imgInput.files) uploadAndInsert(f); imgInput.value = ""; };
  }

  function showWarnings(ws) {
    document.getElementById("warnings").innerHTML = ws && ws.length ? `<div class="warnings"><strong>Warnings:</strong> ${ws.map(esc).join("; ")}</div>` : "";
  }

  // --- send test (modal) ---
  document.getElementById("testBtn").onclick = () => {
    const m = modal(`<h3>Send a test</h3><p class="hint">Delivers the rendered email to one address so you can check it in a real inbox.</p><label for="testTo">Email address</label><input type="email" id="testTo" placeholder="you@example.com"><div class="actions"><button type="button" id="tCancel">Cancel</button><button type="button" class="primary" id="tGo">Send test</button></div>`);
    const to = m.el.querySelector("#testTo"); to.focus();
    m.el.querySelector("#tCancel").onclick = m.close;
    m.el.querySelector("#tGo").onclick = () => busy(m.el.querySelector("#tGo"), "Sending…", async () => {
      const addr = to.value.trim();
      if (!addr || !addr.includes("@")) { toast("Enter a valid email"); return; }
      try { if (!locked) await saveDraft(true); const r = await api("/posts/" + id + "/test", { method: "POST", json: { to: addr } }); showWarnings(r.warnings); m.close(); toast(r.sent ? "Test sent to " + addr : "Send failed"); }
      catch (e) { toast(e.message); }
    });
  };

  // --- schedule (modal with datetime-local) ---
  const scheduleBtn = document.getElementById("scheduleBtn");
  if (scheduleBtn) scheduleBtn.onclick = () => {
    const minStr = toLocalInput(new Date(Date.now() + 6 * 60000));
    const def = toLocalInput(new Date(Date.now() + 24 * 3600 * 1000));
    const m = modal(`<h3>Schedule this issue</h3><p class="hint">It sends at the time you pick (at least 5 minutes out), with a cancelable window until then.</p><label for="schWhen">Send at</label><input type="datetime-local" id="schWhen" min="${minStr}" value="${def}"><div class="actions"><button type="button" id="schCancel">Cancel</button><button type="button" class="primary" id="schGo">Schedule</button></div>`);
    m.el.querySelector("#schCancel").onclick = m.close;
    m.el.querySelector("#schGo").onclick = () => busy(m.el.querySelector("#schGo"), "Scheduling…", async () => {
      const v = m.el.querySelector("#schWhen").value;
      const t = v ? new Date(v).getTime() : NaN;
      if (Number.isNaN(t)) { toast("Pick a valid date & time"); return; }
      try { await saveDraft(true); await api("/posts/" + id + "/schedule", { method: "POST", json: { fire_at: new Date(t).toISOString() } }); m.close(); toast("Scheduled"); location.hash = "#/sends"; }
      catch (e) { toast(e.message); }
    });
  };

  // --- send now (modal with recipient count) ---
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.onclick = async () => {
    let who = "your confirmed subscribers";
    try { const s = await api("/subscribers"); const n = s.counts.confirmed; who = `${n} confirmed subscriber${n === 1 ? "" : "s"}`; } catch (_) {}
    const m = modal(`<h3>Send now?</h3><p class="hint">Freezes the current draft and sends it to <strong>${esc(who)}</strong> after a 5-minute cancelable window. You can cancel from Status until it fires.</p><div class="actions"><button type="button" id="snCancel">Cancel</button><button type="button" class="primary" id="snGo">Send now</button></div>`);
    m.el.querySelector("#snCancel").onclick = m.close;
    m.el.querySelector("#snGo").onclick = () => busy(m.el.querySelector("#snGo"), "Queuing…", async () => {
      try { await saveDraft(true); await api("/posts/" + id + "/send", { method: "POST" }); m.close(); toast("Queued — cancelable for 5 minutes"); location.hash = "#/sends"; }
      catch (e) { toast(e.message); }
    });
  };
}

// ---- sends ----
function startCountdowns() {
  const tick = () => document.querySelectorAll("[data-fire]").forEach((el) => (el.textContent = untilStr(Number(el.dataset.fire))));
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
    const scheduled = sends.filter((s) => s.status === "scheduled").sort((a, b) => a.fire_at - b.fire_at);
    const recent = sends.filter((s) => s.status === "sent" || s.status === "sending" || s.status === "failed").slice(0, 20);

    document.getElementById("scheduled").innerHTML = scheduled.length
      ? scheduled.map((s) => `<div class="card spread clickable" data-post="${s.post_id}"><div><strong><a class="card-link" href="#/edit/${s.post_id}">${esc(s.subject)}</a></strong><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div><button class="danger-subtle" data-cancel="${s.id}">Cancel</button></div>`).join("")
      : `<p class="muted">Nothing scheduled.</p>`;
    // The whole card opens the issue; the subject link handles keyboard/middle-click,
    // and Cancel opts out of navigation (like the posts table's row-click guard).
    document.querySelectorAll("#scheduled .card.clickable").forEach((card) => (card.onclick = (e) => {
      if (e.target.tagName !== "A" && !e.target.closest("[data-cancel]")) location.hash = "#/edit/" + card.dataset.post;
    }));
    document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => busy(b, "Canceling…", async () => {
      try { await api("/sends/" + b.dataset.cancel + "/cancel", { method: "POST" }); toast("Canceled"); renderSends(); } catch (e) { toast(e.message); }
    })));
    startCountdowns();

    document.getElementById("recent").innerHTML = recent.length
      ? `<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th></tr></thead><tbody>${recent
          .map((s) => `<tr><td>${esc(s.subject)}</td><td>${badge(s.status)}</td><td class="num">${s.recipient_count}</td><td class="num">${(s.progress && s.progress.accepted) || 0}</td></tr>`)
          .join("")}</tbody></table></div>`
      : `<p class="muted">No sends yet.</p>`;
  } catch (e) { renderError(document.getElementById("scheduled"), e.message, renderSends); }
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
    if (filterEl.value) params.set("status", filterEl.value);
    const term = searchEl.value.trim();
    if (term) params.set("search", term);
    const qs = params.toString();
    const listEl = document.getElementById("subList");
    try {
      const data = await api("/subscribers" + (qs ? "?" + qs : ""));
      const c = data.counts;
      document.getElementById("subCounts").innerHTML = `<div class="card row" style="gap:24px"><span><strong>${c.confirmed}</strong> confirmed</span><span>${c.pending} pending</span><span>${c.unsubscribed} unsubscribed</span><span>${c.suppressed} suppressed</span><span class="info" role="img" aria-label="What these states mean" data-tip="Pending: subscribed but hasn't clicked the confirmation email. Confirmed: consented — receives sends. Unsubscribed: opted out. Suppressed: bounced or complained — never mailed, whatever the consent state.">${icon("info")}</span></div>`;
      renderSubTable(listEl, data.subscribers, load);
    } catch (e) { renderError(listEl, e.message, load); }
  }

  document.getElementById("addSub").onclick = () => addSubscriberModal(load);
  filterEl.onchange = load;
  searchEl.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(load, 250); };
  load();
}

function renderSubTable(listEl, rows, reload) {
  if (!rows.length) { listEl.innerHTML = `<p class="muted">No subscribers match.</p>`; return; }
  listEl.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Email</th><th>Status</th><th>Confirmed / created</th><th></th></tr></thead><tbody>${rows
    .map((s) => `<tr data-id="${s.id}"><td>${esc(s.email)}</td><td>${badge(s.status)}${s.suppressed ? " " + badge("suppressed") : ""}</td><td class="muted">${fmt(s.confirmed_at || s.created_at)}</td><td class="act">${s.status === "confirmed" ? `<button class="menu-btn" data-menu="${s.id}" aria-label="Subscriber actions">⋯</button>` : ""}</td></tr>`)
    .join("")}</tbody></table></div>`;
  listEl.querySelectorAll(".menu-btn").forEach((b) => (b.onclick = (e) => {
    e.stopPropagation();
    const row = rows.find((r) => r.id === b.dataset.menu);
    openMenu(b, [{ label: "Unsubscribe", danger: true, onClick: () => confirmUnsubscribe(row, reload) }]);
  }));
}

// Add subscriber → the normal double opt-in (never an auto-confirm).
function addSubscriberModal(onDone) {
  const m = modal(`<h3>Add subscriber</h3><p class="hint">Starts the normal double opt-in: they get a confirmation email and won't receive issues until they confirm.</p><label for="addEmail">Email address</label><input type="email" id="addEmail" placeholder="person@example.com"><div class="actions"><button type="button" id="aCancel">Cancel</button><button type="button" class="primary" id="aGo">Send confirmation</button></div>`);
  const input = m.el.querySelector("#addEmail"); input.focus();
  m.el.querySelector("#aCancel").onclick = m.close;
  m.el.querySelector("#aGo").onclick = () => busy(m.el.querySelector("#aGo"), "Adding…", async () => {
    const addr = input.value.trim();
    if (!addr || !addr.includes("@")) { toast("Enter a valid email"); return; }
    try {
      const r = await api("/subscribers", { method: "POST", json: { email: addr } });
      m.close();
      toast(r.action === "already_confirmed" ? addr + " is already confirmed" : "Confirmation sent to " + addr);
      onDone && onDone();
    } catch (e) { toast(e.message); }
  });
}

// ---- docs ----
// The operator setup guide, authored in docs/setup/*.md and served read-only by
// the authed /api/docs routes. We fetch each doc through the SPA (so the dev
// token / Access session cookie is attached, via authHeaders()) and drop the
// returned themed HTML into a sandboxed iframe — never a top-level navigation to
// the gated route, which would carry no credential and 401 in local dev.
async function renderDocs(slug) {
  app.innerHTML = `
    <div class="docs-layout">
      <nav class="docs-nav" id="docsNav" aria-label="Documentation"><p class="muted">Loading…</p></nav>
      <div class="docs-main"><iframe id="docsFrame" class="docs-frame" sandbox="allow-same-origin allow-popups" title="Documentation"></iframe></div>
    </div>`;
  const navEl = document.getElementById("docsNav");
  const frame = document.getElementById("docsFrame");
  let docs;
  try { ({ docs } = await api("/api/docs")); }
  catch (e) { renderError(navEl, e.message, () => renderDocs(slug)); return; }
  if (!docs || !docs.length) { navEl.innerHTML = `<p class="muted">No docs.</p>`; return; }

  const active = docs.some((d) => d.slug === slug) ? slug : docs[0].slug;
  navEl.innerHTML = docs
    .map((d) => `<a href="#/docs/${encodeURIComponent(d.slug)}"${d.slug === active ? ` class="active" aria-current="page"` : ""}>${esc(d.title)}</a>`)
    .join("");

  try {
    // A raw fetch (not api(), which JSON-parses): this route returns HTML. Same
    // auth + 401 handling as api() so an expired Access session steers to re-login.
    const res = await fetch("/api/docs/" + encodeURIComponent(active), { headers: authHeaders() });
    if (res.status === 401) { showReauth(); throw new Error("Not authorized — please sign in again."); }
    if (!res.ok) throw new Error("Couldn't load this doc.");
    frame.srcdoc = await res.text();
    frame.onload = () => { try { frame.style.height = frame.contentDocument.body.scrollHeight + 24 + "px"; } catch (_) {} };
  } catch (e) { toast(e.message); }
}

function confirmUnsubscribe(sub, onDone) {
  const m = modal(`<h3>Unsubscribe this subscriber?</h3><p class="hint">Removes <strong>${esc(sub.email)}</strong> from the send audience immediately. They can re-subscribe later through the double opt-in.</p><div class="actions"><button type="button" id="uCancel">Cancel</button><button type="button" class="danger" id="uGo">Unsubscribe</button></div>`);
  m.el.querySelector("#uCancel").onclick = m.close;
  m.el.querySelector("#uGo").onclick = () => busy(m.el.querySelector("#uGo"), "Unsubscribing…", async () => {
    try { await api("/subscribers/" + sub.id + "/unsubscribe", { method: "POST" }); m.close(); toast("Unsubscribed " + sub.email); onDone && onDone(); }
    catch (e) { toast(e.message); }
  });
}

// Boot: establish who we are before routing.
// - dev: no token yet → mint one from the dev-only endpoint (404 in prod).
// - probe /api/whoami with redirect:"manual" so an Access edge bounce surfaces as
//   an opaque redirect (→ re-login) distinct from the app's own clean 401.
async function boot() {
  if (!token) {
    try {
      const r = await fetch("/api/dev/token?kind=human");
      if (r.ok) setToken((await r.json()).token);
    } catch { /* prod: endpoint is absent; the Access cookie authenticates instead */ }
  }
  let res;
  try {
    res = await fetch("/api/whoami", { headers: authHeaders(), redirect: "manual" });
  } catch {
    return showReauth();
  }
  if (res.ok) {
    session = await res.json();
    renderIdentity();
    return route();
  }
  // opaqueredirect (edge login bounce) or a clean 401 with no way to recover here.
  return showReauth();
}
boot();
