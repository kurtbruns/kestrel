// @ts-nocheck
// The subscribers list and the add-subscriber modal.

import { api } from "./api";
import { confirmUnsubscribe } from "./dashboard";
import { badge, esc, fmt, modal, toast } from "./helpers";
import { listQuery, listToolbar, renderPager, th, wireSort, wireToolbar } from "./list_controls";
import { busy, renderError } from "./notice";
import { infoTip, openMenu } from "./savebar";
import { app } from "./shell";

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
export async function renderSubscribers(initialFilter) {
  const state = {
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

  app.innerHTML = `
    <div class="spread page-head"><h1>Subscribers</h1><button class="primary" id="addSub">Add subscriber</button></div>
    <div id="subCounts" class="muted">Loading…</div>
    ${listToolbar({ statuses: SUB_STATUSES, suppressible: true, searchPlaceholder: "Search email…" })}
    <div id="subList" class="muted">Loading…</div>
    <div id="subPager"></div>`;

  const listEl = document.getElementById("subList");
  const pagerEl = document.getElementById("subPager");

  async function load() {
    try {
      const data = await api(`/subscribers?${listQuery(state)}`);
      const c = data.counts;
      // The counts card stays a global by-status summary (independent of the active
      // filter); the page total below reflects the filtered roster.
      document.getElementById("subCounts").innerHTML =
        `<div class="card row" style="gap:24px"><span><strong>${c.confirmed}</strong> confirmed</span><span>${c.pending} pending</span><span>${c.unsubscribed} unsubscribed</span><span>${c.suppressed} suppressed</span>${infoTip(
          "Pending: subscribed but hasn't clicked the confirmation email. Confirmed: consented — receives sends. Unsubscribed: opted out. Suppressed: bounced or complained — never mailed, whatever the consent state.",
          { below: true },
        )}</div>`;
      renderSubTable(listEl, data.subscribers, state, load);
      renderPager(pagerEl, state, data.page, load);
    } catch (e) {
      renderError(listEl, e.message, load);
    }
  }

  document.getElementById("addSub").onclick = () => addSubscriberModal(load);
  wireToolbar(app, state, load);
  load();
}

// The inline suppression flag rides next to the email (suppression is a deliverability
// overlay, not a consent status) and names WHY: bounced / complaint / blocked, with the
// provider detail in the tooltip. Reasons come from the webhook (bounce, complaint) or a
// manual block; anything unrecognized falls back to a generic label.
const SUPPRESSION_LABELS = { bounce: "bounced", complaint: "complaint", manual: "blocked" };
const SUPPRESSION_TIPS = {
  bounce: "Hard bounce — mail to this address failed, so it won't be mailed again.",
  complaint: "Marked as spam — won't be mailed again, whatever the consent state.",
  manual: "Manually blocked — won't be mailed.",
};
function suppressionFlag(s) {
  if (!s.suppressed) {
    return "";
  }
  const label = SUPPRESSION_LABELS[s.suppression_reason] || "suppressed";
  const base =
    SUPPRESSION_TIPS[s.suppression_reason] ||
    "Suppressed — won't be mailed, whatever the consent state.";
  const tip = s.suppression_detail ? `${base} (${s.suppression_detail})` : base;
  return ` <span class="badge suppressed row-flag" title="${esc(tip)}">${esc(label)}</span>`;
}

function renderSubTable(listEl, rows, state, reload) {
  if (!rows.length) {
    listEl.innerHTML = `<p class="muted">No subscribers match.</p>`;
    return;
  }
  // The joined cell is named so the ≤720px layout can stack a row and label it.
  listEl.innerHTML = `<div class="table-wrap"><table class="list-table subs-table stacks has-actions"><colgroup><col><col class="c-status"><col class="c-date"><col class="c-act"></colgroup><thead><tr>${th("Email", "email", state)}${th("Status", null, state)}${th("Joined", "joined", state)}<th></th></tr></thead><tbody>${rows
    .map(
      (s) =>
        `<tr data-id="${s.id}"><td>${esc(s.email)}${suppressionFlag(s)}</td><td>${badge(s.status)}</td><td class="muted joined">${fmt(s.created_at)}</td><td class="act">${s.status === "confirmed" ? `<button class="icon" data-menu="${s.id}" aria-label="Subscriber actions">⋯</button>` : ""}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
  wireSort(listEl, state, reload);
  listEl.querySelectorAll("[data-menu]").forEach((b) => {
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
export function addSubscriberModal(onDone) {
  const m = modal(
    `<h3>Add subscriber</h3><p class="hint">Starts the normal double opt-in: they get a confirmation email and won't receive posts until they confirm.</p><label for="addEmail">Email address</label><input type="email" id="addEmail" placeholder="person@example.com"><div class="actions"><button type="button" id="aCancel">Cancel</button><button type="button" class="primary" id="aGo">Send confirmation</button></div>`,
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
