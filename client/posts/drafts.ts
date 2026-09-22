// The drafts list (draft + scheduled).

import type { PostListResponse, PostSavedResponse } from "../../shared/posts";
import { api } from "../api";
import { $, $$ } from "../ui/dom";
import { fmt } from "../ui/format";
import { html, setHtml } from "../ui/html";
import {
  type ListState,
  listQuery,
  listToolbar,
  renderPager,
  th,
  wireSort,
  wireToolbar,
} from "../ui/list_controls";
import { badge, busy, type MenuItem, modal, openMenu, renderError, toast } from "../ui/widgets";

// The writing side: draft + scheduled only — a sent post is a frozen record and lives in
// Sent. "All statuses" is scoped to those two, so it never reaches sent.
const DRAFT_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
];
const DRAFTS_SCOPE = "draft,scheduled";

/**
 * Create a draft and jump into the editor — shared by the Posts list, the Dashboard,
 * and the setup checklist so the "New post" affordance behaves identically everywhere.
 */
export function createNewPost(btn: HTMLButtonElement): Promise<void> {
  return busy(btn, "Creating…", async () => {
    try {
      const { post } = await api<PostSavedResponse>("/posts", {
        method: "POST",
        json: { subject: "Untitled" },
      });
      location.hash = `#/edit/${post.id}`;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  });
}

export async function renderDrafts(root: HTMLElement, signal: AbortSignal): Promise<void> {
  // Default sort left empty so the server keeps its scheduled-first order until the
  // reader clicks a column header.
  const state: ListState = {
    status: DRAFTS_SCOPE,
    search: "",
    sort: "",
    dir: "desc",
    offset: 0,
    limit: 50,
  };
  setHtml(
    root,
    html`<div class="spread page-head"><h1>Drafts</h1><button class="primary" id="newPost">New post</button></div>
    ${listToolbar({ statuses: DRAFT_STATUSES, allValue: DRAFTS_SCOPE, searchPlaceholder: "Search subject…" })}
    <div id="list" class="muted">Loading…</div>
    <div id="postsPager"></div>`,
  );
  const newPost = $<HTMLButtonElement>("#newPost", root);
  newPost.onclick = () => createNewPost(newPost);
  const listEl = $("#list", root);
  const pagerEl = $("#postsPager", root);

  async function load() {
    try {
      const data = await api<PostListResponse>(`/posts?${listQuery(state)}`, { signal });
      const posts = data.posts;
      if (!posts.length) {
        // "Filtered" = a real narrowing beyond the default drafts scope (a search, or a
        // single-status pick) — so a fresh, empty list still reads as an invitation.
        const filtered = state.search || (state.status && state.status !== DRAFTS_SCOPE);
        setHtml(
          listEl,
          html`<p class="muted">${filtered ? "No drafts match." : "No drafts yet — create your first draft."}</p>`,
        );
        setHtml(pagerEl, html``);
        return;
      }
      // Cells are named (when / updated) and an empty Scheduled cell is marked, so the
      // ≤720px layout can stack a row and label its dates from CSS alone.
      setHtml(
        listEl,
        html`<div class="table-wrap"><table class="list-table posts-table stacks has-actions"><colgroup><col><col class="c-status"><col class="c-date"><col class="c-date"><col class="c-act"></colgroup><thead><tr>${th("Title", "title", state)}${th("Status", null, state)}${th("Scheduled", "scheduled", state)}${th("Updated", "updated", state)}<th></th></tr></thead><tbody>${posts.map(
          (p) => {
            // A post whose send is in flight is no longer an editable/cancelable draft —
            // show it as `sending` and route it to the live watch, not the editor.
            const sending = p.active_send_status === "sending";
            const href = sending ? `#/sent/${p.active_send_id}` : `#/edit/${p.id}`;
            return html`<tr class="clickable" data-id="${p.id}" data-target="${href}"><td><a href="${href}">${p.subject || html`<em>untitled</em>`}</a></td><td>${sending ? badge("sending") : badge(p.status)}</td><td class="muted when${p.fire_at ? "" : " empty"}">${p.fire_at ? fmt(p.fire_at) : "—"}</td><td class="muted updated">${fmt(p.updated_at)}</td><td class="act"><button class="icon" data-menu="${p.id}" data-status="${sending ? "sending" : p.status}" data-target="${href}" aria-label="Post actions">⋯</button></td></tr>`;
          },
        )}</tbody></table></div>`,
      );
      wireSort(listEl, state, load);
      for (const tr of $$<HTMLTableRowElement>("tr[data-id]", listEl)) {
        tr.onclick = (e) => {
          const t = e.target;
          if (
            t instanceof Element &&
            t.tagName !== "A" &&
            !t.closest("[data-menu]") &&
            tr.dataset.target
          ) {
            location.hash = tr.dataset.target;
          }
        };
      }
      for (const b of $$<HTMLButtonElement>("[data-menu]", listEl)) {
        b.onclick = (e) => {
          e.stopPropagation();
          const st = b.dataset.status;
          const target = b.dataset.target ?? "";
          const items: MenuItem[] = [
            {
              label: st === "sending" ? "Watch send" : "Open",
              onClick: () => {
                location.hash = target;
              },
            },
          ];
          if (st === "draft" && b.dataset.menu) {
            const id = b.dataset.menu;
            items.push({
              label: "Delete draft",
              danger: true,
              onClick: () => confirmDelete(id, load),
            });
          }
          openMenu(b, items);
        };
      }
      renderPager(pagerEl, state, data.page, load);
    } catch (e) {
      renderError(listEl, e instanceof Error ? e.message : String(e), load);
    }
  }
  wireToolbar(root, state, load);
  load();
}

function confirmDelete(pid: string, reload: () => unknown): void {
  const m = modal(
    html`<h3>Delete draft?</h3><p class="hint">This permanently deletes the draft and its revisions. This can't be undone.</p><div class="actions"><button type="button" id="dCancel">Cancel</button><button type="button" class="danger" id="dGo">Delete</button></div>`,
  );
  const go = $<HTMLButtonElement>("#dGo", m.el);
  $("#dCancel", m.el).onclick = m.close;
  go.onclick = () =>
    busy(go, "Deleting…", async () => {
      try {
        await api(`/posts/${pid}`, { method: "DELETE" });
        m.close();
        toast("Draft deleted");
        reload();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    });
}
