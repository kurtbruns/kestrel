"use strict";
// Kestrel editor — a small vanilla SPA over the same HTTP API Claude uses.
// Auth: an admin bearer token in localStorage, sent on every call. (In
// production Cloudflare Access also gates this surface; the token still
// satisfies the Worker's requireAuth.)

const TOKEN_KEY = "kestrel_token";
let token = localStorage.getItem(TOKEN_KEY) || "";
let statusTimer = null; // countdown interval, cleared on navigation

const app = document.getElementById("app");
const banner = document.getElementById("tokenBanner");
const tokenInput = document.getElementById("tokenInput");
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
};
const icon = (name) => `<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

// ---- token handling ----
function setToken(t) {
  token = t.trim();
  localStorage.setItem(TOKEN_KEY, token);
  banner.hidden = !!token;
}
document.getElementById("tokenBtn").onclick = () => { banner.hidden = false; tokenInput.value = token; tokenInput.focus(); };
document.getElementById("tokenSave").onclick = () => { setToken(tokenInput.value); route(); };
if (!token) banner.hidden = false;

// ---- api ----
async function api(path, opts = {}) {
  const headers = Object.assign({ Authorization: "Bearer " + token }, opts.headers || {});
  if (opts.json !== undefined) { headers["content-type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401) { banner.hidden = false; throw new Error("Not authorized — set your token."); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && (data.message || data.error)) || res.statusText);
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
  const hash = location.hash || "#/posts";
  const [, view, arg] = hash.split("/");
  const current = view === "status" ? "#/status" : "#/posts";
  document.querySelectorAll(".topbar nav a").forEach((a) => {
    if (a.getAttribute("href") === current) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (view === "edit" && arg) return renderEditor(arg);
  if (view === "status") return renderStatus();
  return renderPosts();
}
window.addEventListener("hashchange", route);

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
    list.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Slug</th><th>Status</th><th>Scheduled</th><th>Updated</th><th></th></tr></thead><tbody>${posts
      .map((p) => `<tr class="clickable" data-id="${p.id}"><td><a href="#/edit/${p.id}">${esc(p.subject) || "<em>untitled</em>"}</a></td><td class="muted">${esc(p.slug)}</td><td>${badge(p.status)}</td><td class="muted">${p.fire_at ? fmt(p.fire_at) : "—"}</td><td class="muted">${fmt(p.updated_at)}</td><td class="act"><button class="menu-btn" data-menu="${p.id}" data-status="${p.status}" aria-label="Post actions">⋯</button></td></tr>`)
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
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let post, markdown, scheduled;
  try { const data = await api("/posts/" + id); post = data.post; markdown = data.markdown; scheduled = data.scheduled; }
  catch (e) { renderError(app, e.message, () => renderEditor(id)); return; }

  const locked = post.status !== "draft";
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
    <div class="card">
      <div class="grid2">
        <div><label for="f-subject">Subject</label><input id="f-subject" value="${esc(post.subject)}" ${dis}></div>
        <div><label for="f-slug">Slug</label><input id="f-slug" value="${esc(post.slug)}" ${dis}><div class="field-hint">The web address of this issue's archive page. Auto-generated from the subject until you set a custom slug.</div></div>
      </div>

      <label for="f-markdown">Body</label>
      <div class="composer">
        <div class="composer-head">
          <div class="ctabs" role="tablist">
            <button type="button" class="ctab active" data-tab="write" role="tab" aria-selected="true">Write</button>
            <button type="button" class="ctab" data-tab="preview" role="tab" aria-selected="false">Preview</button>
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

  // Linked Subject → Slug: auto-derive the slug from the subject until the author
  // sets a custom slug (clearing the slug field re-links it).
  if (!locked) {
    const subjectEl = document.getElementById("f-subject");
    const slugEl = document.getElementById("f-slug");
    // Linked if the slug is empty, equals the derived slug, or is a deduped
    // variant of it (base-2, base-3, …). A hand-written slug breaks the link.
    const base = clientSlugify(subjectEl.value);
    const v = slugEl.value.trim();
    let slugLinked = v === "" || v === base || (base !== "" && new RegExp(`^${base}-\\d+$`).test(v));
    // While the slug tracks the subject, show it muted so it reads as auto-derived.
    const reflectLink = () => slugEl.classList.toggle("slug-auto", slugLinked);
    reflectLink();
    subjectEl.addEventListener("input", () => { if (slugLinked) slugEl.value = clientSlugify(subjectEl.value); });
    slugEl.addEventListener("input", () => { slugLinked = slugEl.value.trim() === ""; reflectLink(); });
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
      const res = await fetch("/posts/" + id + "/preview", { headers: { Authorization: "Bearer " + token } });
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
  }
  app.querySelectorAll(".tb[data-fmt]").forEach((b) => (b.onclick = () => applyFormat(b.dataset.fmt)));
  ta.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); applyFormat("bold"); }
    else if (k === "i") { e.preventDefault(); applyFormat("italic"); }
    else if (k === "k") { e.preventDefault(); applyFormat("link"); }
  });

  // --- save ---
  async function saveDraft(silent) {
    const { post: u } = await api("/posts/" + id, { method: "PUT", json: collect() });
    const slugEl = document.getElementById("f-slug");
    if (u && u.slug && slugEl) slugEl.value = u.slug; // reflect any server-side dedupe
    if (!silent) toast("Saved");
    return u;
  }
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.onclick = () => busy(saveBtn, "Saving…", () => saveDraft(false).catch((e) => toast(e.message)));

  // --- open in browser ---
  const openBtn = document.getElementById("openBtn");
  openBtn.onclick = () => busy(openBtn, "Opening…", async () => {
    try {
      if (!locked) await saveDraft(true);
      const res = await fetch("/posts/" + id + "/preview", { headers: { Authorization: "Bearer " + token } });
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
      try { await saveDraft(true); await api("/posts/" + id + "/schedule", { method: "POST", json: { fire_at: new Date(t).toISOString() } }); m.close(); toast("Scheduled"); location.hash = "#/status"; }
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
      try { await saveDraft(true); await api("/posts/" + id + "/send", { method: "POST" }); m.close(); toast("Queued — cancelable for 5 minutes"); location.hash = "#/status"; }
      catch (e) { toast(e.message); }
    });
  };
}

// ---- status ----
function startCountdowns() {
  const tick = () => document.querySelectorAll("[data-fire]").forEach((el) => (el.textContent = untilStr(Number(el.dataset.fire))));
  tick();
  statusTimer = setInterval(tick, 1000);
}

async function renderStatus() {
  app.innerHTML = `<h1>Status</h1><div id="counts" class="muted">Loading…</div><h2>Scheduled</h2><div id="scheduled"></div><h2>Recent sends</h2><div id="recent"></div>`;
  try {
    const c = (await api("/subscribers")).counts;
    document.getElementById("counts").innerHTML = `<div class="card row" style="gap:24px"><span><strong>${c.confirmed}</strong> confirmed</span><span>${c.pending} pending</span><span>${c.unsubscribed} unsubscribed</span><span>${c.suppressed} suppressed</span></div>`;
  } catch (e) { renderError(document.getElementById("counts"), e.message, renderStatus); }

  try {
    const { sends } = await api("/sends");
    const scheduled = sends.filter((s) => s.status === "scheduled");
    const recent = sends.filter((s) => s.status === "sent" || s.status === "sending" || s.status === "failed").slice(0, 20);

    document.getElementById("scheduled").innerHTML = scheduled.length
      ? scheduled.map((s) => `<div class="card spread"><div><strong>${esc(s.subject)}</strong><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div><button class="danger" data-cancel="${s.id}">Cancel</button></div>`).join("")
      : `<p class="muted">Nothing scheduled.</p>`;
    document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => busy(b, "Canceling…", async () => {
      try { await api("/sends/" + b.dataset.cancel + "/cancel", { method: "POST" }); toast("Canceled"); renderStatus(); } catch (e) { toast(e.message); }
    })));
    startCountdowns();

    document.getElementById("recent").innerHTML = recent.length
      ? `<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th></tr></thead><tbody>${recent
          .map((s) => `<tr><td>${esc(s.subject)}</td><td>${badge(s.status)}</td><td class="num">${s.recipient_count}</td><td class="num">${(s.progress && s.progress.accepted) || 0}</td></tr>`)
          .join("")}</tbody></table></div>`
      : `<p class="muted">No sends yet.</p>`;
  } catch (e) { renderError(document.getElementById("scheduled"), e.message, renderStatus); }
}

route();
