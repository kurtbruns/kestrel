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
import { badge, busy, type MenuItem, openMenu, renderError, toast } from "../ui/widgets";
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
    <div class="card sub-summary"><div class="sub-summary-head"><div id="subCounts" class="row muted">Loading…</div><button type="button" class="sub-legend-toggle" id="subLegendToggle" aria-expanded="false" aria-controls="subLegend">Legend</button></div>${legend()}</div>
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
      // The counts stay a global by-status summary (independent of the active filter);
      // the page total below reflects the filtered roster. Only the counts repaint, so
      // the legend stays open or closed across a reload.
      setHtml(
        $("#subCounts"),
        html`<span><strong>${c.confirmed}</strong> confirmed</span><span>${c.pending} pending</span><span>${c.unsubscribed} unsubscribed</span><span>${c.suppressed} suppressed</span>`,
      );
      // Suppressions alone are no subscribers, so a list of only them still points the way in.
      const listEmpty = c.pending + c.confirmed + c.unsubscribed === 0;
      renderSubTable(listEl, data.subscribers, state, load, signal, listEmpty);
      renderPager(pagerEl, state, data.page, load);
    } catch (e) {
      renderError(listEl, describeError(e), load);
    }
  }

  const legendToggle = $("#subLegendToggle");
  legendToggle.onclick = () => {
    const open = legendToggle.getAttribute("aria-expanded") !== "true";
    legendToggle.setAttribute("aria-expanded", String(open));
    $("#subLegend").hidden = !open;
  };
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
// overlay, not a consent status) and names WHY: bounced / complaint / blocked / erased.
// Reasons come from the webhook (bounce, complaint), an import that brought a bounce or
// complaint from the previous service (shown as the same flag), a manual block, or an
// erasure; anything unrecognized falls back to a generic label. The pills carry no hover tooltip,
// which keyboard, screen-reader, and touch users can't reach: the legend under the counts
// defines each label once, and a subscriber's own detail belongs on their page.
const SUPPRESSIONS: Record<string, { label: string; means: string }> = {
  bounce: {
    label: "bounced",
    means: "Mail to the address failed, here or at the service it was imported from.",
  },
  complaint: {
    label: "complaint",
    means: "Marked as spam, here or at the service it was imported from.",
  },
  manual: { label: "blocked", means: "Suppressed by hand." },
  erased: {
    label: "erased",
    means:
      "A do-not-contact marker kept after an erasure. Only the person’s own confirmation lifts it.",
  },
};
const IMPORTED_AS: Record<string, string> = {
  import_bounce: "bounce",
  import_complaint: "complaint",
};
function flagLabel(s: SubscriberListItem): string {
  const reason = s.suppression_reason ?? "";
  return SUPPRESSIONS[IMPORTED_AS[reason] ?? reason]?.label || "suppressed";
}
function suppressionFlag(s: SubscriberListItem): Html | null {
  if (!s.suppressed) {
    return null;
  }
  return html` <span class="badge suppressed row-flag">${flagLabel(s)}</span>`;
}

// The legend: what each label a row can show means (DESIGN §3), every pill drawn as the
// list draws it beside its definition, so it also says what the colors mean. Its toggle
// sits at the right of the counts and the legend opens below the whole card, a layout a
// <details> can't give, so the toggle is a button carrying aria-expanded.
const STATUS_MEANS: Record<string, string> = {
  pending: "Subscribed but hasn’t clicked the confirmation email.",
  confirmed:
    "Receives your posts. They confirmed here, or opted in at the service you imported them from.",
  unsubscribed: "Opted out.",
};
function legendRow(pill: Html, means: string): Html {
  return html`<dt>${pill}</dt><dd>${means}</dd>`;
}
function legend(): Html {
  return html`<div class="sub-legend" id="subLegend" role="region" aria-labelledby="subLegendToggle" hidden><div class="sub-legend-body">
    <h2>Status</h2>
    <dl>${SUB_STATUSES.map(({ value }) => legendRow(badge(value), STATUS_MEANS[value] ?? ""))}</dl>
    <h2>Suppressed</h2>
    <p>The address isn’t mailed, whatever its status, which stays as it was. The red flag beside the address says why:</p>
    <dl>${Object.values(SUPPRESSIONS).map(({ label, means }) =>
      legendRow(html`<span class="badge suppressed">${label}</span>`, means),
    )}</dl>
  </div></div>`;
}

// A suppressed address keeps its consent status, but the status isn't in effect while the
// suppression stands, so its badge takes the not-mailed grey (DESIGN §3). An erasure's
// marker on a pending sign-up is the one exception: the person's own confirmation lifts
// it, so that pending status is still live. On a confirmed row (an import can put one
// there) nothing lifts it, so it greys like any other suppression.
function statusBadge(s: SubscriberListItem): Html {
  if (!s.suppressed || (s.suppression_reason === "erased" && s.status === "pending")) {
    return badge(s.status);
  }
  return html`<span class="badge ${s.status} held">${s.status}</span>`;
}

// An address that has to wrap breaks before its "@", keeping the mailbox and the domain
// whole where they fit, rather than wherever the column runs out.
function breakableEmail(email: string): Html {
  const at = email.lastIndexOf("@");
  return at > 0 ? html`${email.slice(0, at)}<wbr>${email.slice(at)}` : html`${email}`;
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
  // The joined and how cells are named so the stacked layout can label them. The wrapper is
  // what the stacking measures: this table stacks by its own width, not the viewport's.
  setHtml(
    listEl,
    html`<div class="table-wrap subs-wrap"><table class="list-table subs-table stacks has-actions"><colgroup><col><col class="c-status"><col class="c-how"><col class="c-date"><col class="c-act"></colgroup><thead><tr>${th("Email", "email", state)}${th("Status", null, state)}${th("How they joined", null, state)}${th("Joined", "joined", state)}<th></th></tr></thead><tbody>${rows.map(
      (s) => {
        const how = joinedVia(s);
        return html`<tr data-id="${s.id}"><td>${breakableEmail(s.email)}${suppressionFlag(s)}</td><td>${statusBadge(s)}</td><td class="muted how${how ? "" : " empty"}">${how ?? "—"}</td><td class="muted joined">${fmt(s.created_at)}</td><td class="act"><button class="icon" data-menu="${s.id}" aria-label="Subscriber actions" aria-haspopup="menu">⋯</button></td></tr>`;
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
        {
          label: "View subscriber",
          onClick: () =>
            viewSubscriberModal(
              row,
              signal,
              row.suppressed
                ? { label: flagLabel(row), detail: row.suppression_detail }
                : undefined,
            ),
        },
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
