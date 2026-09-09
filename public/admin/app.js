"use strict";
// Kestrel editor — a small vanilla SPA over the same HTTP API Claude uses.
// Auth: an admin bearer token kept in localStorage and sent on every call.
// (In production, Cloudflare Access also gates this surface; the token still
// satisfies the Worker's requireAuth.)

const TOKEN_KEY = "kestrel_token";
let token = localStorage.getItem(TOKEN_KEY) || "";

const app = document.getElementById("app");
const banner = document.getElementById("tokenBanner");
const tokenInput = document.getElementById("tokenInput");

// ---- Material Symbols icon paths (viewBox 0 -960 960 960) ----
const ICONS = {
  heading: "M420-160v-520H200v-120h560v120H540v520H420Z",
  bold: "M272-200v-560h221q65 0 120 40t55 111q0 51-23 78.5T602-491q25 11 55.5 41t30.5 90q0 89-65 124.5T501-200H272Zm121-112h104q48 0 58.5-24.5T566-372q0-11-10.5-35.5T494-432H393v120Zm0-228h93q33 0 48-17t15-38q0-24-17-39t-44-15h-95v109Z",
  italic: "M200-200v-100h160l120-360H320v-100h400v100H580L460-300h140v100H200Z",
  quote: "m228-240 92-160q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 23-5.5 42.5T458-480L320-240h-92Zm360 0 92-160q-66 0-113-47t-47-113q0-66 47-113t113-47q66 0 113 47t47 113q0 23-5.5 42.5T818-480L680-240h-92ZM362.5-517.5Q380-535 380-560t-17.5-42.5Q345-620 320-620t-42.5 17.5Q260-585 260-560t17.5 42.5Q295-500 320-500t42.5-17.5Zm360 0Q740-535 740-560t-17.5-42.5Q705-620 680-620t-42.5 17.5Q620-585 620-560t17.5 42.5Q655-500 680-500t42.5-17.5Z",
  code: "M320-240 80-480l240-240 57 57-184 184 183 183-56 56Zm320 0-57-57 184-184-183-183 56-56 240 240-240 240Z",
  link: "M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z",
  ul: "M360-200v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360ZM200-160q-33 0-56.5-23.5T120-240q0-33 23.5-56.5T200-320q33 0 56.5 23.5T280-240q0 33-23.5 56.5T200-160Zm0-240q-33 0-56.5-23.5T120-480q0-33 23.5-56.5T200-560q33 0 56.5 23.5T280-480q0 33-23.5 56.5T200-400Zm-56.5-263.5Q120-687 120-720t23.5-56.5Q167-800 200-800t56.5 23.5Q280-753 280-720t-23.5 56.5Q233-640 200-640t-56.5-23.5Z",
  ol: "M120-80v-60h100v-30h-60v-60h60v-30H120v-60h120q17 0 28.5 11.5T280-280v40q0 17-11.5 28.5T240-200q17 0 28.5 11.5T280-160v40q0 17-11.5 28.5T240-80H120Zm0-280v-110q0-17 11.5-28.5T160-510h60v-30H120v-60h120q17 0 28.5 11.5T280-560v70q0 17-11.5 28.5T240-450h-60v30h100v60H120Zm60-280v-180h-60v-60h120v240h-60Zm180 440v-80h480v80H360Zm0-240v-80h480v80H360Zm0-240v-80h480v80H360Z",
  indent: "M120-120v-80h720v80H120Zm320-160v-80h400v80H440Zm0-160v-80h400v80H440Zm0-160v-80h400v80H440ZM120-760v-80h720v80H120Zm0 440v-320l160 160-160 160Z",
  paperclip: "M720-330q0 104-73 177T470-80q-104 0-177-73t-73-177v-370q0-75 52.5-127.5T400-880q75 0 127.5 52.5T580-700v350q0 46-32 78t-78 32q-46 0-78-32t-32-78v-370h80v370q0 13 8.5 21.5T470-320q13 0 21.5-8.5T500-350v-350q-1-42-29.5-71T400-800q-42 0-71 29t-29 71v370q-1 71 49 120.5T470-160q70 0 119-49.5T640-330v-390h80v390Z",
};
const icon = (name) =>
  `<svg viewBox="0 -960 960 960" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;

// ---- token handling ----
function setToken(t) {
  token = t.trim();
  localStorage.setItem(TOKEN_KEY, token);
  banner.hidden = !!token;
}
document.getElementById("tokenBtn").onclick = () => {
  banner.hidden = false;
  tokenInput.value = token;
  tokenInput.focus();
};
document.getElementById("tokenSave").onclick = () => {
  setToken(tokenInput.value);
  route();
};
if (!token) banner.hidden = false;

// ---- api helper ----
async function api(path, opts = {}) {
  const headers = Object.assign({ Authorization: "Bearer " + token }, opts.headers || {});
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401) {
    banner.hidden = false;
    throw new Error("Not authorized — set your token.");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && (data.message || data.error)) || res.statusText);
  return data;
}

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast show";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.remove("show"), 2200);
  setTimeout(() => t.remove(), 2500);
}
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));
const badge = (status) => `<span class="badge ${status}">${status}</span>`;
const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : "—");

// ---- router ----
function route() {
  const hash = location.hash || "#/posts";
  const [, view, arg] = hash.split("/");
  if (view === "edit" && arg) return renderEditor(arg);
  if (view === "status") return renderStatus();
  return renderPosts();
}
window.addEventListener("hashchange", route);

// ---- posts list ----
async function renderPosts() {
  app.innerHTML = `<div class="spread"><h1>Posts</h1><button class="primary" id="newPost">New post</button></div><div id="list" class="muted">Loading…</div>`;
  document.getElementById("newPost").onclick = async () => {
    try {
      const { post } = await api("/posts", { method: "POST", json: { title: "Untitled" } });
      location.hash = "#/edit/" + post.id;
    } catch (e) { toast(e.message); }
  };
  try {
    const { posts } = await api("/posts");
    const list = document.getElementById("list");
    if (!posts.length) { list.innerHTML = `<p class="muted">No posts yet.</p>`; return; }
    list.innerHTML = `<table><thead><tr><th>Title</th><th>Slug</th><th>Status</th><th>Updated</th></tr></thead><tbody>${posts
      .map((p) => `<tr class="clickable" data-id="${p.id}"><td>${esc(p.title) || "<em>untitled</em>"}</td><td class="muted">${esc(p.slug)}</td><td>${badge(p.status)}</td><td class="muted">${fmt(p.updated_at)}</td></tr>`)
      .join("")}</tbody></table>`;
    list.querySelectorAll("tr[data-id]").forEach((tr) => (tr.onclick = () => (location.hash = "#/edit/" + tr.dataset.id)));
  } catch (e) { app.querySelector("#list").innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// ---- editor ----
const TOOLBAR = [
  [["heading", "Heading"], ["bold", "Bold (⌘B)"], ["italic", "Italic (⌘I)"]],
  [["quote", "Quote"], ["code", "Code"], ["link", "Link (⌘K)"]],
  [["ul", "Bulleted list"], ["ol", "Numbered list"], ["indent", "Indent"]],
];

async function renderEditor(id) {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let post, markdown;
  try {
    const data = await api("/posts/" + id);
    post = data.post; markdown = data.markdown;
  } catch (e) { app.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }

  const locked = post.status !== "draft";
  const toolbarHtml = TOOLBAR
    .map((group) => group.map(([kind, label]) => `<button type="button" class="tb" data-fmt="${kind}" title="${label}" aria-label="${label}" ${locked ? "disabled" : ""}>${icon(kind)}</button>`).join(""))
    .join(`<span class="sep"></span>`);

  app.innerHTML = `
    <div class="spread">
      <a href="#/posts" class="muted">← Posts</a>
      <span>${badge(post.status)}</span>
    </div>
    <div class="card">
      <div class="grid2">
        <div><label>Subject</label><input id="f-subject" value="${esc(post.subject)}" ${locked ? "disabled" : ""}></div>
        <div><label>Slug</label><input id="f-slug" value="${esc(post.slug)}" ${locked ? "disabled" : ""}></div>
      </div>
      <label>Title</label><input id="f-title" value="${esc(post.title)}" ${locked ? "disabled" : ""}>
      <label>Preheader</label><input id="f-preheader" value="${esc(post.preheader)}" ${locked ? "disabled" : ""}>

      <label>Body</label>
      <div class="composer">
        <div class="composer-head">
          <div class="ctabs">
            <button type="button" class="ctab active" data-tab="write">Write</button>
            <button type="button" class="ctab" data-tab="preview">Preview</button>
          </div>
          <div class="toolbar">${toolbarHtml}</div>
        </div>
        <div class="composer-body" id="composerBody">
          <textarea id="f-markdown" class="editor" placeholder="Type your issue in Markdown…" ${locked ? "disabled" : ""}>${esc(markdown)}</textarea>
          <iframe id="previewFrame" class="preview" sandbox="allow-same-origin" hidden></iframe>
        </div>
        <div class="composer-foot" id="dropFoot" ${locked ? "hidden" : ""}>${icon("paperclip")}<span>Paste, drop, or click to add images</span></div>
        <input type="file" id="imgInput" accept="image/*" multiple hidden>
      </div>
      <div id="warnings"></div>

      <div class="row" style="margin-top:14px">
        <button class="primary" id="saveBtn" ${locked ? "disabled" : ""}>Save</button>
        <button id="testBtn">Send test…</button>
        ${locked ? "" : `<button id="scheduleBtn">Schedule…</button><button id="sendBtn">Send now</button>`}
        ${locked ? `<span class="muted">Scheduled — cancel from Status to edit.</span>` : ""}
      </div>
    </div>`;

  const ta = document.getElementById("f-markdown");
  const get = (k) => document.getElementById("f-" + k).value;
  const collect = () => ({ title: get("title"), subject: get("subject"), preheader: get("preheader"), slug: get("slug"), markdown: get("markdown") });

  // --- tabs ---
  const previewFrame = document.getElementById("previewFrame");
  const tabs = app.querySelectorAll(".ctab");
  function showTab(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    ta.hidden = name !== "write";
    previewFrame.hidden = name !== "preview";
  }
  tabs.forEach((t) => (t.onclick = () => {
    if (t.dataset.tab === "preview") return showPreview();
    showTab("write");
  }));
  async function showPreview() {
    showTab("preview");
    try {
      if (!locked) await saveDraft(true);
      const res = await fetch("/posts/" + id + "/preview", { headers: { Authorization: "Bearer " + token } });
      previewFrame.srcdoc = await res.text();
    } catch (e) { toast(e.message); }
  }

  // --- formatting toolbar ---
  function wrapSel(before, after, placeholder) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || placeholder;
    ta.value = ta.value.slice(0, s) + before + sel + after + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = s + before.length;
    ta.selectionEnd = s + before.length + sel.length;
  }
  function prefixLines(prefix) {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const start = ta.value.lastIndexOf("\n", s - 1) + 1;
    const block = ta.value.slice(start, e) || "";
    const out = block.split("\n").map((l) => prefix + l).join("\n");
    ta.value = ta.value.slice(0, start) + out + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = start;
    ta.selectionEnd = start + out.length;
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
  // keyboard shortcuts
  ta.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "b") { e.preventDefault(); applyFormat("bold"); }
    else if (k === "i") { e.preventDefault(); applyFormat("italic"); }
    else if (k === "k") { e.preventDefault(); applyFormat("link"); }
  });

  // --- save ---
  async function saveDraft(silent) {
    const { post: updated } = await api("/posts/" + id, { method: "PUT", json: collect() });
    if (!silent) toast("Saved");
    return updated;
  }
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.onclick = () => saveDraft(false).catch((e) => toast(e.message));

  // --- image upload: drag/drop, paste, click ---
  async function uploadAndInsert(file) {
    if (!file || !file.type.startsWith("image/")) return;
    try {
      const fd = new FormData(); fd.append("file", file);
      const { image } = await api("/posts/" + id + "/images", { method: "POST", body: fd });
      const s = ta.selectionStart;
      const snippet = `\n![${file.name}](${image.filename})\n`;
      ta.value = ta.value.slice(0, s) + snippet + ta.value.slice(s);
      ta.selectionStart = ta.selectionEnd = s + snippet.length;
      toast("Image added");
    } catch (e) { toast(e.message); }
  }
  if (!locked) {
    const body = document.getElementById("composerBody");
    const imgInput = document.getElementById("imgInput");
    const foot = document.getElementById("dropFoot");
    body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("dragover"); });
    body.addEventListener("dragleave", (e) => { if (e.target === body) body.classList.remove("dragover"); });
    body.addEventListener("drop", (e) => {
      e.preventDefault(); body.classList.remove("dragover"); showTab("write");
      for (const f of e.dataTransfer.files) uploadAndInsert(f);
    });
    ta.addEventListener("paste", (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.type.startsWith("image/")) { const f = it.getAsFile(); if (f) { e.preventDefault(); uploadAndInsert(f); } }
      }
    });
    foot.onclick = () => imgInput.click();
    imgInput.onchange = () => { for (const f of imgInput.files) uploadAndInsert(f); imgInput.value = ""; };
  }

  // --- test ---
  document.getElementById("testBtn").onclick = async () => {
    const to = prompt("Send a test to which address?");
    if (!to) return;
    try { if (!locked) await saveDraft(true); const r = await api("/posts/" + id + "/test", { method: "POST", json: { to } }); showWarnings(r.warnings); toast(r.sent ? "Test sent to " + to : "Send failed"); }
    catch (e) { toast(e.message); }
  };

  // --- schedule / send now ---
  const scheduleBtn = document.getElementById("scheduleBtn");
  if (scheduleBtn) scheduleBtn.onclick = async () => {
    const when = prompt("Schedule for (YYYY-MM-DD HH:MM, at least 5 minutes out):");
    if (!when) return;
    const t = Date.parse(when.replace(" ", "T"));
    if (Number.isNaN(t)) return toast("Couldn't read that date");
    try { await saveDraft(true); await api("/posts/" + id + "/schedule", { method: "POST", json: { fire_at: new Date(t).toISOString() } }); toast("Scheduled"); location.hash = "#/status"; }
    catch (e) { toast(e.message); }
  };
  const sendBtn = document.getElementById("sendBtn");
  if (sendBtn) sendBtn.onclick = async () => {
    if (!confirm("Send now? It will go out after a 5-minute cancelable window.")) return;
    try { await saveDraft(true); await api("/posts/" + id + "/send", { method: "POST" }); toast("Queued — cancelable for 5 minutes"); location.hash = "#/status"; }
    catch (e) { toast(e.message); }
  };

  function showWarnings(ws) {
    const box = document.getElementById("warnings");
    box.innerHTML = ws && ws.length ? `<div class="warnings"><strong>Warnings:</strong> ${ws.map(esc).join("; ")}</div>` : "";
  }
}

// ---- status ----
async function renderStatus() {
  app.innerHTML = `<h1>Status</h1><div id="counts" class="muted">Loading…</div><h2>Scheduled</h2><div id="scheduled"></div><h2>Recent sends</h2><div id="recent"></div>`;
  try {
    const subs = await api("/subscribers");
    const c = subs.counts;
    document.getElementById("counts").innerHTML = `<div class="card row" style="gap:24px"><span><strong>${c.confirmed}</strong> confirmed</span><span>${c.pending} pending</span><span>${c.unsubscribed} unsubscribed</span><span>${c.suppressed} suppressed</span></div>`;
  } catch (e) { document.getElementById("counts").textContent = e.message; }

  try {
    const { sends } = await api("/sends");
    const scheduled = sends.filter((s) => s.status === "scheduled");
    const recent = sends.filter((s) => s.status !== "scheduled").slice(0, 20);

    document.getElementById("scheduled").innerHTML = scheduled.length
      ? scheduled.map((s) => `<div class="card spread"><div><strong>${esc(s.subject)}</strong><div class="muted">fires ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div><button class="danger" data-cancel="${s.id}">Cancel</button></div>`).join("")
      : `<p class="muted">Nothing scheduled.</p>`;
    document.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => {
      if (!confirm("Cancel this scheduled send?")) return;
      try { await api("/sends/" + b.dataset.cancel + "/cancel", { method: "POST" }); toast("Canceled"); renderStatus(); } catch (e) { toast(e.message); }
    }));

    document.getElementById("recent").innerHTML = recent.length
      ? `<table><thead><tr><th>Subject</th><th>Status</th><th>Recipients</th><th>Delivered</th></tr></thead><tbody>${recent
          .map((s) => `<tr><td>${esc(s.subject)}</td><td>${badge(s.status)}</td><td class="muted">${s.recipient_count}</td><td class="muted">${(s.progress && s.progress.accepted) || 0}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p class="muted">No sends yet.</p>`;
  } catch (e) { document.getElementById("scheduled").textContent = e.message; }
}

route();
