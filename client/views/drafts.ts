// @ts-nocheck
// The drafts list (draft + scheduled).

import { api } from "../api";
import { createNewPost } from "../build_ref";
import { badge, esc, fmt, modal, toast } from "../helpers";
import { listQuery, listToolbar, renderPager, th, wireSort, wireToolbar } from "../list_controls";
import { busy, renderError } from "../notice";
import { openMenu } from "../savebar";
import { app } from "../shell";

// The writing side (#147): draft + scheduled only — a sent post is a frozen record and
// lives in Sent. "All statuses" is scoped to those two, so it never reaches sent.
const DRAFT_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
];
const DRAFTS_SCOPE = "draft,scheduled";
export async function renderDrafts() {
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
      // Cells are named (when / updated) and an empty Scheduled cell is marked, so the
      // ≤720px layout can stack a row and label its dates from CSS alone.
      listEl.innerHTML = `<div class="table-wrap"><table class="list-table posts-table stacks has-actions"><colgroup><col><col class="c-status"><col class="c-date"><col class="c-date"><col class="c-act"></colgroup><thead><tr>${th("Title", "title", state)}${th("Status", null, state)}${th("Scheduled", "scheduled", state)}${th("Updated", "updated", state)}<th></th></tr></thead><tbody>${posts
        .map((p) => {
          // A post whose send is in flight is no longer an editable/cancelable draft —
          // show it as `sending` and route it to the live watch, not the editor (#162).
          const sending = p.active_send_status === "sending";
          const href = sending ? `#/sent/${p.active_send_id}` : `#/edit/${p.id}`;
          return `<tr class="clickable" data-id="${p.id}" data-target="${href}"><td><a href="${href}">${esc(p.subject) || "<em>untitled</em>"}</a></td><td>${sending ? badge("sending") : badge(p.status)}</td><td class="muted when${p.fire_at ? "" : " empty"}">${p.fire_at ? fmt(p.fire_at) : "—"}</td><td class="muted updated">${fmt(p.updated_at)}</td><td class="act"><button class="icon" data-menu="${p.id}" data-status="${sending ? "sending" : p.status}" data-target="${href}" aria-label="Post actions">⋯</button></td></tr>`;
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
