// The subscribers list: the by-status composition and the filterable roster.

import type { SubscriberListItem, SubscriberListResponse } from "../../shared/subscribers";
import { api } from "../api";
import { $, $$ } from "../ui/dom";
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
import { badge, infoTip, openMenu, renderError } from "../ui/widgets";
import { addSubscriberModal, confirmUnsubscribe } from "./dialogs";

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
    <div class="spread page-head"><h1>Subscribers</h1><button class="primary" id="addSub">Add subscriber</button></div>
    <div id="subCounts" class="muted">Loading…</div>
    ${listToolbar({ statuses: SUB_STATUSES, suppressible: true, searchPlaceholder: "Search email…" })}
    <div id="subList" class="muted">Loading…</div>
    <div id="subPager"></div>`,
  );

  const listEl = $("#subList");
  const pagerEl = $("#subPager");

  async function load() {
    try {
      const data = await api<SubscriberListResponse>(`/subscribers?${listQuery(state)}`, {
        signal,
      });
      const c = data.counts;
      // The counts card stays a global by-status summary (independent of the active
      // filter); the page total below reflects the filtered roster.
      setHtml(
        $("#subCounts"),
        html`<div class="card row" style="gap:24px"><span><strong>${c.confirmed}</strong> confirmed</span><span>${c.pending} pending</span><span>${c.unsubscribed} unsubscribed</span><span>${c.suppressed} suppressed</span>${infoTip(
          "Pending: subscribed but hasn't clicked the confirmation email. Confirmed: consented — receives sends. Unsubscribed: opted out. Suppressed: bounced or complained — never mailed, whatever the consent state.",
          { below: true },
        )}</div>`,
      );
      renderSubTable(listEl, data.subscribers, state, load);
      renderPager(pagerEl, state, data.page, load);
    } catch (e) {
      renderError(listEl, e instanceof Error ? e.message : String(e), load);
    }
  }

  $("#addSub").onclick = () => addSubscriberModal(load);
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
};
const SUPPRESSION_TIPS: Record<string, string> = {
  bounce: "Hard bounce — mail to this address failed, so it won't be mailed again.",
  complaint: "Marked as spam — won't be mailed again, whatever the consent state.",
  manual: "Manually blocked — won't be mailed.",
};
function suppressionFlag(s: SubscriberListItem): Html | null {
  if (!s.suppressed) {
    return null;
  }
  const reason = s.suppression_reason ?? "";
  const label = SUPPRESSION_LABELS[reason] || "suppressed";
  const base =
    SUPPRESSION_TIPS[reason] || "Suppressed — won't be mailed, whatever the consent state.";
  const tip = s.suppression_detail ? `${base} (${s.suppression_detail})` : base;
  return html` <span class="badge suppressed row-flag" title="${tip}">${label}</span>`;
}

function renderSubTable(
  listEl: Element,
  rows: SubscriberListItem[],
  state: ListState,
  reload: () => void,
): void {
  if (!rows.length) {
    setHtml(listEl, html`<p class="muted">No subscribers match.</p>`);
    return;
  }
  // The joined cell is named so the ≤720px layout can stack a row and label it.
  setHtml(
    listEl,
    html`<div class="table-wrap"><table class="list-table subs-table stacks has-actions"><colgroup><col><col class="c-status"><col class="c-date"><col class="c-act"></colgroup><thead><tr>${th("Email", "email", state)}${th("Status", null, state)}${th("Joined", "joined", state)}<th></th></tr></thead><tbody>${rows.map(
      (s) =>
        html`<tr data-id="${s.id}"><td>${s.email}${suppressionFlag(s)}</td><td>${badge(s.status)}</td><td class="muted joined">${fmt(s.created_at)}</td><td class="act">${
          s.status === "confirmed"
            ? html`<button class="icon" data-menu="${s.id}" aria-label="Subscriber actions">⋯</button>`
            : null
        }</td></tr>`,
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
      openMenu(b, [
        { label: "Unsubscribe", danger: true, onClick: () => confirmUnsubscribe(row, reload) },
      ]);
    };
  }
}
