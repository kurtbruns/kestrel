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
async function renderEditor(id) {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let post, markdown;
  try {
    const data = await api("/posts/" + id);
    post = data.post; markdown = data.markdown;
  } catch (e) { app.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }

  const locked = post.status !== "draft";
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
      <div class="tabs" style="margin-top:14px"><button id="tab-write" class="active">Write</button><button id="tab-preview">Preview</button></div>
      <div id="pane-write">
        <textarea id="f-markdown" class="editor" ${locked ? "disabled" : ""}>${esc(markdown)}</textarea>
        <div class="row" style="margin-top:8px">
          <label style="margin:0"><input type="file" id="imgInput" accept="image/*" ${locked ? "disabled" : ""} style="width:auto"></label>
          <span class="muted">Uploads to this post; inserts a Markdown reference.</span>
        </div>
      </div>
      <div id="pane-preview" hidden><iframe id="previewFrame" class="preview" sandbox="allow-same-origin"></iframe></div>
      <div id="warnings"></div>
      <div class="row" style="margin-top:14px">
        <button class="primary" id="saveBtn" ${locked ? "disabled" : ""}>Save</button>
        <button id="testBtn">Send test…</button>
        ${locked ? "" : `<button id="scheduleBtn">Schedule…</button><button id="sendBtn">Send now</button>`}
        ${locked ? `<span class="muted">Scheduled — cancel from Status to edit.</span>` : ""}
      </div>
    </div>`;

  const get = (k) => document.getElementById("f-" + k).value;
  const collect = () => ({ title: get("title"), subject: get("subject"), preheader: get("preheader"), slug: get("slug"), markdown: get("markdown") });

  // tabs
  const tabWrite = document.getElementById("tab-write"), tabPreview = document.getElementById("tab-preview");
  const paneWrite = document.getElementById("pane-write"), panePreview = document.getElementById("pane-preview");
  tabWrite.onclick = () => { tabWrite.classList.add("active"); tabPreview.classList.remove("active"); paneWrite.hidden = false; panePreview.hidden = true; };
  tabPreview.onclick = async () => {
    tabPreview.classList.add("active"); tabWrite.classList.remove("active"); paneWrite.hidden = true; panePreview.hidden = false;
    try {
      if (!locked) await saveDraft(true);
      const res = await fetch("/posts/" + id + "/preview", { headers: { Authorization: "Bearer " + token } });
      document.getElementById("previewFrame").srcdoc = await res.text();
    } catch (e) { toast(e.message); }
  };

  async function saveDraft(silent) {
    const { post: updated } = await api("/posts/" + id, { method: "PUT", json: collect() });
    if (!silent) toast("Saved");
    return updated;
  }
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.onclick = () => saveDraft(false).catch((e) => toast(e.message));

  // image upload
  const imgInput = document.getElementById("imgInput");
  if (imgInput) imgInput.onchange = async () => {
    const file = imgInput.files[0]; if (!file) return;
    try {
      const fd = new FormData(); fd.append("file", file);
      const { image } = await api("/posts/" + id + "/images", { method: "POST", body: fd });
      const ta = document.getElementById("f-markdown");
      const snippet = `\n![${file.name}](${image.filename})\n`;
      ta.value = ta.value.slice(0, ta.selectionStart) + snippet + ta.value.slice(ta.selectionStart);
      toast("Image added");
    } catch (e) { toast(e.message); }
    imgInput.value = "";
  };

  // test
  document.getElementById("testBtn").onclick = async () => {
    const to = prompt("Send a test to which address?");
    if (!to) return;
    try { if (!locked) await saveDraft(true); const r = await api("/posts/" + id + "/test", { method: "POST", json: { to } }); showWarnings(r.warnings); toast(r.sent ? "Test sent to " + to : "Send failed"); }
    catch (e) { toast(e.message); }
  };

  // schedule / send now
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
