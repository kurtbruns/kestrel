// @ts-nocheck
// The sent record view and the live in-flight watch.

import { api, apiText } from "./api";
import { noEmailProvider } from "./build_ref";
import { esc, fmt, toast } from "./helpers";
import { renderPager, th, wireSort } from "./list_controls";
import { busy, renderError } from "./notice";
import { openResolveModal } from "./sends";
import { app } from "./shell";
import { appState } from "./state";

// A sent post is a frozen record (I3), not an editable object, so it opens this instead
// of a locked editor: how the send went over the frozen audience, with a link to the
// archived post. A send still IN FLIGHT opens the live watch — two bars (dispatch, and
// the lagging delivery), a derived phase, a counts grid, throughput, and a provider-
// health strip — polling /progress until dispatch completes, after which the record keeps
// absorbing delivery receipts as they settle (SPEC §6/§8/§12).
export async function renderSentRecord(id) {
  app.innerHTML = `<p class="muted">Loading…</p>`;
  let data;
  try {
    data = await api(`/sends/${id}`);
  } catch (e) {
    renderError(app, e.message, () => renderSentRecord(id));
    return;
  }
  const { send } = data;

  // A scheduled send is still cancel-to-edit — its home is the editor, not this record.
  if (send.status === "scheduled") {
    location.hash = `#/edit/${send.post_id}`;
    return;
  }
  // A send still in flight opens the live watch, which polls /progress.
  if (send.status === "sending") {
    return startWatch(id, send);
  }
  return renderFrozenRecord(id, data);
}

// Phase → { label, tone } for the derived-phase pill. Tones reuse the status/semantic
// palettes: sending = blue (the in-flight treatment, DESIGN §3), ok = green, warn/danger
// as usual, scheduled = violet.
const PHASE_META = {
  scheduled: { label: "Scheduled", tone: "scheduled" },
  progressing: { label: "Sending", tone: "sending" },
  retrying: { label: "Retrying", tone: "warn" },
  "backing-off": { label: "Backing off", tone: "warn" },
  "needs-attention": { label: "Needs attention", tone: "danger" },
  settling: { label: "Settling", tone: "sending" },
  complete: { label: "Complete", tone: "ok" },
  canceled: { label: "Canceled", tone: "muted" },
};
const PHASE_BLURB = {
  progressing: "Handing recipients to the provider.",
  retrying: "Some recipients hit a transient error and will be retried.",
  "backing-off": "Paused between ticks — it resumes on the next sweep.",
  "needs-attention": "Some deliveries are stuck and need a decision.",
  settling: "Dispatch complete — waiting on delivery receipts.",
};
function phasePill(phase) {
  const m = PHASE_META[phase] || { label: phase, tone: "muted" };
  return `<span class="phase-pill tone-${m.tone}">${esc(m.label)}</span>`;
}
export const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n || 0)));
// A labeled progress bar: `tone` picks the fill color, `sub` is a muted sub-line.
function progressBar(tone, label, value, total, sub) {
  const p = total > 0 ? clampPct((100 * value) / total) : 0;
  return `<div class="wbar-row">
      <div class="wbar-head"><span class="wbar-label">${label}</span><span class="wbar-count">${value.toLocaleString()} / ${total.toLocaleString()}</span></div>
      <div class="wbar" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><div class="wbar-fill tone-${tone}" style="width:${p}%"></div></div>
      ${sub ? `<div class="wbar-sub muted">${sub}</div>` : ""}
    </div>`;
}
// The delivery bar shares the dispatch bar's scale (denominator = the whole audience), so
// the two pair up: a grey `accepted` segment tracks the exact frontier the dispatch bar
// reaches, and green fills in behind it as receipts confirm. Green can never pass grey, so
// delivery visibly LAGS dispatch instead of racing ahead of it (which it did when the two
// bars used different denominators).
function deliveryBar(label, confirmed, accepted, total, sub) {
  const acceptedPct = total > 0 ? clampPct((100 * accepted) / total) : 0;
  const confirmedPct = total > 0 ? clampPct((100 * confirmed) / total) : 0;
  return `<div class="wbar-row">
      <div class="wbar-head"><span class="wbar-label">${label}</span><span class="wbar-count">${confirmed.toLocaleString()} of ${accepted.toLocaleString()} accepted</span></div>
      <div class="wbar dual" role="progressbar" aria-valuenow="${confirmedPct}" aria-valuemin="0" aria-valuemax="100">
        <div class="wbar-fill tone-accepted" style="width:${acceptedPct}%"></div>
        <div class="wbar-fill tone-ok" style="width:${confirmedPct}%"></div>
      </div>
      ${sub ? `<div class="wbar-sub muted">${sub}</div>` : ""}
    </div>`;
}
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) {
    return "—";
  }
  const s = Math.round(ms / 1000);
  if (s < 90) {
    return `${s}s`;
  }
  const m = Math.round(s / 60);
  if (m < 90) {
    return `${m} min`;
  }
  return `${Math.round(m / 60)} hr`;
}

// The counts grid mirrors the eight denormalized buckets; each swatch reuses the record
// tile palette so a bucket reads the same here and on the frozen record.
const WATCH_COUNTS = [
  { key: "pending", label: "Pending", sw: "neutral" },
  { key: "in_flight", label: "In flight", sw: "sending" },
  { key: "accepted", label: "Accepted", sw: "sending" },
  { key: "delivered", label: "Delivered", sw: "ok" },
  { key: "bounced", label: "Bounced", sw: "warn" },
  { key: "complained", label: "Complained", sw: "danger" },
  { key: "unsent", label: "Unsent", sw: "neutral" },
  { key: "skipped", label: "Skipped", sw: "neutral" },
];
function watchCountsHtml(counts) {
  return `<div class="wcounts">${WATCH_COUNTS.map(
    (c) =>
      `<div class="wcount"><div class="wcount-n">${(counts[c.key] || 0).toLocaleString()}</div><div class="wcount-l"><span class="rec-sw sw-${c.sw}"></span>${c.label}</div></div>`,
  ).join("")}</div>`;
}

// The dynamic half of the watch (bars + counts + health strip), repainted on each poll.
function watchBodyHtml(prog) {
  const c = prog.counts;
  const acceptedTotal = c.accepted + c.delivered + c.bounced + c.complained;
  const rate = prog.dispatch.rate_per_min;
  const dispatchSub =
    prog.state === "sending"
      ? `${PHASE_BLURB[prog.phase] || ""}${
          rate ? ` · ~${rate.toLocaleString()}/min · ETA ${fmtDuration(prog.dispatch.eta_ms)}` : ""
        }`
      : "Dispatch complete.";
  const failureCount = (c.unsent || 0) + (c.bounced || 0) + (c.complained || 0);
  const providerText = noEmailProvider()
    ? "No email provider configured — nothing is delivered"
    : `Provider: ${esc(prog.provider?.name || "—")}`;
  return `
    <div class="wbars">
      ${progressBar("sending", "Dispatch — provider-accepted", acceptedTotal, prog.total, dispatchSub)}
      ${deliveryBar(
        "Delivery — webhook-confirmed",
        prog.delivery.confirmed,
        acceptedTotal,
        prog.total,
        "Delivery lags acceptance — grey is accepted-but-unconfirmed, green fills in as receipts arrive.",
      )}
    </div>
    ${watchCountsHtml(c)}
    <div class="whealth${failureCount ? " has-failures" : ""}"><span class="whealth-dot"></span><span>${providerText} · ${
      failureCount
        ? `${failureCount.toLocaleString()} bounced / unsent / complained`
        : "no delivery failures"
    }</span></div>`;
}
function watchMetaHtml(send, prog) {
  const started = send.started_at ? `Started ${esc(fmt(send.started_at))}` : "Sending now";
  return `${started} · ${prog.total.toLocaleString()} recipients`;
}
function watchHtml(send, prog) {
  return `
    <div class="editor-head">
      <a href="#/sent" class="back">← Sent</a>
      ${prog.attention?.wedged ? `<button type="button" class="primary" id="resolveBtn">Resolve…</button>` : ""}
    </div>
    <div class="card rec-card watch-card">
      <div class="rec-head">
        <div class="watch-title"><h1>${esc(send.subject) || "<em>untitled</em>"}</h1><span id="watchPill">${phasePill(prog.phase)}</span></div>
        <div class="rec-meta" id="watchMeta">${watchMetaHtml(send, prog)}</div>
      </div>
      <div id="watchBody">${watchBodyHtml(prog)}</div>
      <p class="rec-note muted">This view updates live while the send is in flight. Delivery receipts keep arriving after dispatch finishes — the record stays accurate as they settle.</p>
    </div>`;
}

// Wire the header's Resolve control (present only when the send is wedged, §12). It
// reuses the same modal the Sent page uses, shimming the shape it reads.
function wireWatchHeader(id, send, prog) {
  const rb = document.getElementById("resolveBtn");
  if (rb) {
    rb.onclick = () =>
      openResolveModal({ id, subject: send.subject, c_in_flight: prog.counts.in_flight }, () =>
        renderSentRecord(id),
      );
  }
}
function paintWatch(send, prog) {
  const pill = document.getElementById("watchPill");
  if (pill) {
    pill.innerHTML = phasePill(prog.phase);
  }
  const meta = document.getElementById("watchMeta");
  if (meta) {
    meta.innerHTML = watchMetaHtml(send, prog);
  }
  const body = document.getElementById("watchBody");
  if (body) {
    body.innerHTML = watchBodyHtml(prog);
  }
}

async function startWatch(id, send) {
  let prog;
  try {
    prog = await api(`/sends/${id}/progress`);
  } catch (e) {
    renderError(app, e.message, () => renderSentRecord(id));
    return;
  }
  // It may have finished between the two reads — fall through to the frozen record.
  if (prog.state !== "sending") {
    return renderSentRecord(id);
  }
  app.innerHTML = watchHtml(send, prog);
  wireWatchHeader(id, send, prog);
  scheduleWatchPoll(id, send);
}

// Poll /progress (~3s) while sending; a recursive setTimeout so a slow read never
// overlaps. `progressTimer` holds the pending id so route() clears it on navigation.
function scheduleWatchPoll(id, send) {
  const gen = appState.navGeneration;
  appState.progressTimer = setTimeout(async () => {
    let prog;
    try {
      prog = await api(`/sends/${id}/progress`);
    } catch {
      // transient — keep the last view, try again (unless we've since navigated away)
      if (gen === appState.navGeneration) {
        scheduleWatchPoll(id, send);
      }
      return;
    }
    // Navigated away while the fetch was in flight: the new view owns the screen and its own
    // poll now — don't renderSentRecord over it, swap it, or reschedule onto its timer.
    if (gen !== appState.navGeneration) {
      return;
    }
    if (prog.state !== "sending") {
      appState.progressTimer = null;
      return renderSentRecord(id); // dispatch done → the frozen record (which settles)
    }
    // If it just wedged, the header needs the Resolve control it didn't have — re-render.
    if (prog.attention?.wedged && !document.getElementById("resolveBtn")) {
      app.innerHTML = watchHtml(send, prog);
      wireWatchHeader(id, send, prog);
    } else {
      paintWatch(send, prog);
    }
    scheduleWatchPoll(id, send);
  }, 3000);
}

// The delivery-outcome tiles + reconciliation line — the frozen record's body, factored
// so the settling poll can repaint them in place as late receipts arrive.
function outcomeTilesHtml(outcomes) {
  const tiles = [
    { n: outcomes.recipients, label: "Recipients", cls: "", sw: "neutral" },
    { n: outcomes.delivered, label: "Delivered", cls: "ok", sw: "ok" },
    { n: outcomes.bounced, label: "Bounced", cls: "warn", sw: "warn" },
    { n: outcomes.complained, label: "Complained", cls: "danger", sw: "danger" },
    { n: outcomes.unsent, label: "Unsent", cls: "", sw: "neutral" },
  ];
  return tiles
    .map(
      (t) =>
        `<div class="rec-tile"><div class="rec-n ${t.cls}">${t.n.toLocaleString()}</div><div class="rec-l"><span class="rec-sw sw-${t.sw}"></span>${t.label}</div></div>`,
    )
    .join("");
}
function outcomeReconHtml(outcomes) {
  const total = outcomes.recipients;
  const residual = outcomes.accepted + outcomes.skipped + outcomes.in_flight;
  const parts = [`${outcomes.delivered.toLocaleString()} delivered`];
  if (outcomes.bounced) {
    parts.push(`${outcomes.bounced.toLocaleString()} bounced`);
  }
  if (outcomes.complained) {
    parts.push(`${outcomes.complained.toLocaleString()} complained`);
  }
  if (outcomes.unsent) {
    parts.push(`${outcomes.unsent.toLocaleString()} unsent`);
  }
  if (residual) {
    parts.push(`${residual.toLocaleString()} accepted, awaiting a delivery receipt`);
  }
  const reconciled = `All ${total.toLocaleString()} accounted for: ${parts.join(", ")}.`;
  // The suppression note is scoped to what actually suppresses: hard bounces and complaints,
  // never soft bounces (counted, left on the list — SPEC §8). The aggregate counters don't
  // split soft from hard, so gate on any bounce or complaint and state the rule rather than
  // claim a count; a clean send says nothing about suppression at all.
  const suppression =
    outcomes.bounced || outcomes.complained
      ? " Hard bounces and spam complaints are suppressed automatically, so those addresses won't be mailed again."
      : "";
  return `${reconciled}${suppression}`;
}

// The per-recipient record (#164): the outcome tiles summarize, this shows the actual
// rows. A row's OUTCOME is derived from the same two facts the tiles bucket — the webhook
// `event` winning over the send-loop `status` — so a row reads the same bucket (and reuses
// the same swatch palette) as its tile. A bounce splits soft vs hard on `bounce_kind` — the
// provider's permanent/transient signal frozen onto the row when the event landed (SPEC §8),
// a fact of THIS send, not a read of the current suppression list. Null = kind unknown.
function deliveryOutcome(r) {
  if (r.event === "delivered") {
    return { label: "Delivered", sw: "ok" };
  }
  if (r.event === "bounced") {
    if (r.bounce_kind === "hard") {
      return { label: "Hard bounce", sw: "warn", hint: "permanent — suppressed the address" };
    }
    if (r.bounce_kind === "soft") {
      return { label: "Soft bounce", sw: "warn", hint: "transient — counted, not suppressed" };
    }
    return { label: "Bounce", sw: "warn" };
  }
  if (r.event === "complained") {
    return { label: "Complained", sw: "danger", hint: "suppressed" };
  }
  switch (r.status) {
    case "unsent":
      return { label: "Unsent", sw: "neutral" };
    case "skipped":
      return { label: "Skipped", sw: "neutral" };
    case "accepted":
      return { label: "Accepted", sw: "sending", hint: "awaiting a delivery receipt" };
    default:
      return { label: "In flight", sw: "sending" };
  }
}

// The three view tabs the record opens on — failures first (the rows that went wrong).
const DELIVERY_VIEWS = [
  { v: "failures", label: "Failures" },
  { v: "delivered", label: "Delivered" },
  { v: "all", label: "All" },
];

// A positive/neutral empty state per view — an empty "failures" list is good news, not a gap.
function deliveryEmpty(dstate) {
  if (dstate.search) {
    return "No recipients match that address.";
  }
  if (dstate.view === "failures") {
    return "No delivery failures — every recipient was accepted or delivered.";
  }
  if (dstate.view === "delivered") {
    return "No delivery receipts confirmed yet.";
  }
  return "No recipients on this send.";
}

function recordDeliveryQuery(d) {
  const p = new URLSearchParams();
  p.set("view", d.view);
  const term = (d.search || "").trim();
  if (term) {
    p.set("search", term);
  }
  if (d.sort) {
    p.set("sort", d.sort);
    p.set("dir", d.dir);
  }
  p.set("limit", String(d.limit));
  p.set("offset", String(d.offset));
  return p.toString();
}

function deliveryRowsHtml(rows, dstate) {
  const body = rows
    .map((r) => {
      const o = deliveryOutcome(r);
      // The label names the bucket; its consequence (suppressed or not, awaiting a receipt)
      // is taught once in prose by the reconciliation line above and kept on the row only as
      // a hover tooltip — so a row stays a clean one-liner instead of restating the taxonomy
      // on every line.
      const outcome = `<span class="rec-out"${o.hint ? ` title="${esc(o.hint)}"` : ""}><span class="rec-sw sw-${o.sw}"></span>${esc(o.label)}</span>`;
      const detail = r.error || r.event_detail || "";
      const when = r.event_at ? fmt(r.event_at) : "";
      return `<tr><td class="rec-email">${esc(r.email)}</td><td>${outcome}</td><td class="muted">${
        detail ? esc(detail) : "—"
      }</td><td class="muted">${when ? esc(when) : "—"}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table class="list-table rec-people-table"><colgroup><col><col class="c-out"><col><col class="c-date"></colgroup><thead><tr>${th(
    "Recipient",
    "email",
    dstate,
  )}<th class="c-out">Outcome</th><th>Detail</th><th class="c-date">When</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderFrozenRecord(id, data) {
  const { send, outcomes, archive_url, published, slug } = data;
  const total = outcomes.recipients;
  const sentAt = send.completed_at ?? send.fire_at;

  app.innerHTML = `
    <div class="editor-head">
      <a href="#/sent" class="back">← Sent</a>
      ${published && archive_url ? `<button type="button" class="primary" id="viewPublished">View published post&nbsp;↗</button>` : ""}
    </div>
    <div class="card rec-card">
      <div class="rec-head">
        <h1>${esc(send.subject) || "<em>untitled</em>"}</h1>
        <div class="rec-meta">Sent ${esc(fmt(sentAt))} · ${total.toLocaleString()} recipients</div>
      </div>
      <p class="rec-tiles-cap muted">Delivery outcomes — these keep updating as receipts arrive; the audience and the published post are fixed as sent.</p>
      <div class="rec-tiles">${outcomeTilesHtml(outcomes)}</div>
      <p class="rec-recon muted">${outcomeReconHtml(outcomes)}</p>
      <div class="rec-actions">
        <button type="button" class="ghost" id="csvBtn">Export recipients (CSV)</button>
      </div>
      <div class="rec-people">
        <div class="rec-people-head">
          <h2 class="rec-people-title">Recipients</h2>
          <div class="rec-views" role="group" aria-label="Which recipients to show">
            ${DELIVERY_VIEWS.map(
              (t, i) =>
                `<button type="button" class="rec-view-btn" data-view="${t.v}" aria-pressed="${i === 0 ? "true" : "false"}">${t.label}</button>`,
            ).join("")}
          </div>
        </div>
        <input class="rec-people-search" type="search" placeholder="Search email…" aria-label="Search recipients by email" autocomplete="off">
        <div id="recRows" class="muted">Loading…</div>
        <div id="recPager"></div>
      </div>
      <p class="rec-note muted">This is the record of what went out — the published post is the exact frozen copy readers received, and nothing here is editable.</p>
    </div>`;

  const viewBtn = document.getElementById("viewPublished");
  if (viewBtn && archive_url) {
    viewBtn.onclick = () => window.open(archive_url, "_blank", "noopener");
  }

  // The per-recipient record, its own paged/filtered state (independent of the tiles).
  // Default view is "failures" so the rows that went wrong lead; default sort mirrors the
  // CSV (email asc). The tiles above stay the live summary as receipts settle; this list
  // reloads on interaction (a view/search/sort/page change, or re-clicking the view).
  const dstate = { view: "failures", search: "", sort: "email", dir: "asc", offset: 0, limit: 50 };
  const rowsEl = document.getElementById("recRows");
  const recPagerEl = document.getElementById("recPager");
  const loadDeliveries = async () => {
    try {
      const d = await api(`/sends/${id}/deliveries?${recordDeliveryQuery(dstate)}`);
      if (!d.deliveries.length) {
        rowsEl.innerHTML = `<p class="rec-people-empty muted">${esc(deliveryEmpty(dstate))}</p>`;
        recPagerEl.innerHTML = "";
        return;
      }
      rowsEl.innerHTML = deliveryRowsHtml(d.deliveries, dstate);
      wireSort(rowsEl, dstate, loadDeliveries);
      renderPager(recPagerEl, dstate, d.page, loadDeliveries);
    } catch (e) {
      renderError(rowsEl, e.message, loadDeliveries);
    }
  };
  app.querySelectorAll(".rec-view-btn").forEach((b) => {
    b.onclick = () => {
      dstate.view = b.dataset.view;
      dstate.offset = 0;
      app.querySelectorAll(".rec-view-btn").forEach((x) => {
        x.setAttribute("aria-pressed", String(x === b));
      });
      loadDeliveries();
    };
  });
  const recSearch = app.querySelector(".rec-people-search");
  if (recSearch) {
    let t = null;
    recSearch.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        dstate.search = recSearch.value;
        dstate.offset = 0;
        loadDeliveries();
      }, 250);
    };
  }
  loadDeliveries();

  const csvBtn = document.getElementById("csvBtn");
  csvBtn.onclick = () =>
    busy(csvBtn, "Exporting…", async () => {
      try {
        const csv = await apiText(`/sends/${id}/deliveries.csv`);
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const a = document.createElement("a");
        a.href = url;
        // Match the server's content-disposition (routes/sends.ts) so the file is named
        // the same however it's fetched — the archive slug, not a re-slug of the subject.
        a.download = `${slug ?? "send"}-deliveries.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) {
        toast(e.message);
      }
    });

  // Still settling: the record keeps absorbing delivery receipts after dispatch (§6), so
  // poll ~15s and repaint the tiles until every accepted recipient is confirmed. Capped
  // so a provider that never confirms doesn't leave the poll running forever.
  if (outcomes.accepted > 0) {
    scheduleSettlePoll(id, 0);
  }
}

function scheduleSettlePoll(id, count) {
  if (count > 40) {
    return; // ~10 min ceiling — stop chasing receipts that may never arrive
  }
  const gen = appState.navGeneration;
  appState.progressTimer = setTimeout(async () => {
    let data;
    try {
      data = await api(`/sends/${id}`);
    } catch {
      if (gen === appState.navGeneration) {
        scheduleSettlePoll(id, count + 1);
      }
      return;
    }
    // Navigated away mid-fetch — the tiles we'd repaint belong to a view that's gone, and the
    // reschedule would leak onto the new view's poll timer. Bail (see navGeneration).
    if (gen !== appState.navGeneration) {
      return;
    }
    if (data.send.status === "sending") {
      appState.progressTimer = null;
      return renderSentRecord(id); // resumed (a wedged resolve, say) → back to the watch
    }
    const tiles = app.querySelector(".rec-tiles");
    const recon = app.querySelector(".rec-recon");
    if (tiles) {
      tiles.innerHTML = outcomeTilesHtml(data.outcomes);
    }
    if (recon) {
      recon.innerHTML = outcomeReconHtml(data.outcomes);
    }
    if (data.outcomes.accepted > 0) {
      scheduleSettlePoll(id, count + 1);
    } else {
      appState.progressTimer = null;
    }
  }, 15000);
}
