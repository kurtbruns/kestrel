// The subscribers list: the by-status composition and the filterable roster.

import type { SubscriberListItem, SubscriberListResponse } from "../../shared/subscribers";
import { api, describeError } from "../api";
import { $, $$ } from "../ui/dom";
import { saveFile } from "../ui/download";
import { fmt } from "../ui/format";
import { type Html, html, setHtml } from "../ui/html";
import {
  type ListState,
  listQuery,
  listToolbar,
  renderPager,
  th,
  wireSort,
  wireToolbar,
} from "../ui/list_controls";
import { badge, busy, infoTip, type MenuItem, openMenu, renderError, toast } from "../ui/widgets";
import {
  addSubscriberModal,
  confirmErase,
  confirmUnsubscribe,
  viewSubscriberModal,
} from "./dialogs";
import { exportFile } from "./export";
import { joinedVia } from "./provenance";

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

export async function renderSubscribers(
  initialFilter: string | undefined,
  root: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  const state: ListState = {
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

  setHtml(
    root,
    html`
    <div class="spread page-head"><h1>Subscribers</h1><span class="row"><button type="button" class="ghost" id="importSubs">Import</button><button type="button" class="ghost" id="exportSubs">Export</button><button class="primary" id="addSub">Add subscriber</button></span></div>
    <div id="subCounts" class="muted">Loading…</div>
    ${listToolbar({ statuses: SUB_STATUSES, suppressible: true, searchPlaceholder: "Search email…" })}
    <div id="subList" class="muted">Loading…</div>
    <div id="subPager"></div>`,
  );

  const listEl = $("#subList");
  const pagerEl = $("#subPager");

  async function load() {
    try {
      const data = await api<SubscriberListResponse>(`/api/subscribers?${listQuery(state)}`, {
        signal,
      });
      const c = data.counts;
      // The counts card stays a global by-status summary (independent of the active
      // filter); the page total below reflects the filtered roster.
      setHtml(
        $("#subCounts"),
        html`<div class="card row" style="gap:24px"><span><strong>${c.confirmed}</strong> confirmed</span><span>${c.pending} pending</span><span>${c.unsubscribed} unsubscribed</span><span>${c.suppressed} suppressed</span>${infoTip(
          "Pending: subscribed but hasn’t clicked the confirmation email. Confirmed: agreed to receive your posts, here or at the service they were imported from, and receives them. Unsubscribed: opted out. Suppressed: bounced, complained, blocked, or erased, and never mailed, whatever their status.",
          { below: true },
        )}</div>`,
      );
      // Suppressions alone are no subscribers, so a list of only them still points the way in.
      const listEmpty = c.pending + c.confirmed + c.unsubscribed === 0;
      renderSubTable(listEl, data.subscribers, state, load, signal, listEmpty);
      renderPager(pagerEl, state, data.page, load);
    } catch (e) {
      renderError(listEl, describeError(e), load);
    }
  }

  $("#addSub").onclick = () => addSubscriberModal(load, signal);
  $("#importSubs").onclick = () => {
    location.hash = "#/subscribers/import";
  };
  const exportBtn = $<HTMLButtonElement>("#exportSubs");
  exportBtn.onclick = () =>
    busy(exportBtn, "Exporting…", async () => {
      try {
        const file = await exportFile();
        saveFile(file.text, file.name, "text/csv");
      } catch (e) {
        // The export has no surface of its own to say a failure in (DESIGN §5).
        toast(describeError(e));
      }
    });
  wireToolbar(root, state, load);
  load();
}

// The inline suppression flag rides next to the email (suppression is a deliverability
// overlay, not a consent status) and names WHY: bounced / complaint / blocked, with the
// provider detail in the tooltip. Reasons come from the webhook (bounce, complaint) or a
// manual block; anything unrecognized falls back to a generic label.
const SUPPRESSION_LABELS: Record<string, string> = {
  bounce: "bounced",
  complaint: "complaint",
  manual: "blocked",
  erased: "erased",
};
const SUPPRESSION_TIPS: Record<string, string> = {
  bounce: "Hard bounce: mail to this address failed, so it won’t be mailed again.",
  complaint: "Marked as spam, so it won’t be mailed again, whatever their status.",
  manual: "Manually blocked, so it won’t be mailed.",
  erased:
    "Erased at the person’s request, then subscribed again. Not mailed until they confirm, which lifts the erasure.",
};
function suppressionFlag(s: SubscriberListItem): Html | null {
  if (!s.suppressed) {
    return null;
  }
  const reason = s.suppression_reason ?? "";
  const label = SUPPRESSION_LABELS[reason] || "suppressed";
  const base =
    SUPPRESSION_TIPS[reason] || "Suppressed, so it won’t be mailed, whatever their status.";
  const tip = s.suppression_detail ? `${base} (${s.suppression_detail})` : base;
  return html` <span class="badge suppressed row-flag" title="${tip}">${label}</span>`;
}

function renderSubTable(
  listEl: Element,
  rows: SubscriberListItem[],
  state: ListState,
  reload: () => void,
  signal: AbortSignal,
  listEmpty: boolean,
): void {
  if (!rows.length) {
    // An empty list, rather than a filter that matches no one, points the way in.
    setHtml(
      listEl,
      listEmpty
        ? html`<p class="muted">No subscribers yet. <a href="#/subscribers/import">Import your list</a> from another service, or share your subscribe page.</p>`
        : html`<p class="muted">No subscribers match.</p>`,
    );
    return;
  }
  // The joined and how cells are named so the ≤720px layout can stack a row and label them.
  setHtml(
    listEl,
    html`<div class="table-wrap"><table class="list-table subs-table stacks has-actions"><colgroup><col><col class="c-status"><col class="c-how"><col class="c-date"><col class="c-act"></colgroup><thead><tr>${th("Email", "email", state)}${th("Status", null, state)}${th("How they joined", null, state)}${th("Joined", "joined", state)}<th></th></tr></thead><tbody>${rows.map(
      (s) => {
        const how = joinedVia(s);
        return html`<tr data-id="${s.id}"><td>${s.email}${suppressionFlag(s)}</td><td>${badge(s.status)}</td><td class="muted how${how ? "" : " empty"}">${how ?? "—"}</td><td class="muted joined">${fmt(s.created_at)}</td><td class="act"><button class="icon" data-menu="${s.id}" aria-label="Subscriber actions" aria-haspopup="menu">⋯</button></td></tr>`;
      },
    )}</tbody></table></div>`,
  );
  wireSort(listEl, state, reload);
  for (const b of $$<HTMLButtonElement>("[data-menu]", listEl)) {
    b.onclick = (e) => {
      e.stopPropagation();
      const row = rows.find((r) => r.id === b.dataset.menu);
      if (!row) {
        return;
      }
      // Anyone can be viewed and anyone can be erased (SPEC §7); only a
      // confirmed subscriber has anything to unsubscribe from.
      const items: MenuItem[] = [
        { label: "View subscriber", onClick: () => viewSubscriberModal(row, signal) },
      ];
      if (row.status === "confirmed") {
        items.push({
          label: "Unsubscribe",
          danger: true,
          onClick: () => confirmUnsubscribe(row, reload, signal),
        });
      }
      items.push({
        label: "Erase",
        danger: true,
        onClick: () => confirmErase(row, reload, signal),
      });
      openMenu(b, items, signal);
    };
  }
}
