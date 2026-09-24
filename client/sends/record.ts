// The sent record view and the live in-flight watch.

import type {
  DeliveryListResponse,
  DeliveryOutcomes,
  DeliveryRecord,
  DeliveryView,
  SendCounts,
  SendPhase,
  SendResponse,
  SendView,
} from "../../shared/sends";
import { api, apiFile } from "../api";
import { noEmailProvider } from "../deployment";
import { every, mount } from "../lifecycle";
import { followSend } from "../send_state";
import { $, $$ } from "../ui/dom";
import { fmt } from "../ui/format";
import { type Html, html, setHtml } from "../ui/html";
import { type ListState, renderPager, th, wireSort } from "../ui/list_controls";
import { busy, renderError, toast } from "../ui/widgets";
import { openResolveModal } from "./dialogs";
import { can, clampPct, conditionOf, fmtDuration, has } from "./progress";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A sent post is a frozen record (I3), not an editable object, so it opens this instead
 * of a locked editor: how the send went over the audience at fire, with a link to the
 * archived post. A send still IN FLIGHT opens the live watch (two bars, dispatch and the
 * lagging delivery, a derived phase, a counts grid, throughput, and a provider-health
 * strip), following the send through the send-state layer until dispatch completes, after
 * which the record keeps absorbing delivery receipts as they settle (SPEC §6/§8/§12).
 */
export async function renderSentRecord(
  id: string,
  root: HTMLElement,
  signal: AbortSignal,
): Promise<void> {
  // The watch re-enters here when dispatch ends, and the record when it resumes; each is
  // a fresh mount (its own root and signal), so the poll that noticed ends with its own.
  const remount = () => {
    if (!signal.aborted) {
      mount((r, s) => renderSentRecord(id, r, s)); // never over wherever the reader went since
    }
  };
  setHtml(root, html`<p class="muted">Loading…</p>`);
  let data: SendResponse;
  try {
    data = await api<SendResponse>(`/sends/${id}`, { signal });
  } catch (e) {
    renderError(root, message(e), remount);
    return;
  }
  if (signal.aborted) {
    return; // navigated away while loading: the redirect below must not hijack that
  }
  const { send } = data;

  // A scheduled send is still cancel-to-edit: its home is the editor, not this record. The
  // editor takes this page's history entry, so Back goes where the reader came from, never
  // to this URL that would only hand them to the editor again (DESIGN §9).
  if (send.status === "scheduled") {
    location.replace(`#/edit/${send.post_id}`);
    return;
  }
  // A send still in flight opens the live watch, which follows it from this read.
  if (send.status === "sending") {
    return startWatch(data, root, signal, remount);
  }
  return renderFrozenRecord(id, data, root, signal, remount);
}

// Phase → { label, tone } for the derived-phase pill. Tones reuse the status/semantic
// palettes: sending = blue (the in-flight treatment, DESIGN §3), ok = green, warn/danger
// as usual, scheduled = violet.
const PHASE_META: Record<SendPhase, { label: string; tone: string }> = {
  scheduled: { label: "Scheduled", tone: "scheduled" },
  due: { label: "Due", tone: "scheduled" },
  progressing: { label: "Sending", tone: "sending" },
  retrying: { label: "Retrying", tone: "warn" },
  "backing-off": { label: "Backing off", tone: "warn" },
  "needs-attention": { label: "Needs attention", tone: "danger" },
  settling: { label: "Settling", tone: "sending" },
  complete: { label: "Complete", tone: "ok" },
  canceled: { label: "Canceled", tone: "muted" },
};
const PHASE_BLURB: Partial<Record<SendPhase, string>> = {
  progressing: "Handing recipients to the provider.",
  retrying: "Some recipients hit a transient error and will be retried.",
  "backing-off": "Paused between ticks — it resumes on the next sweep.",
  "needs-attention": "Some deliveries are stuck and need a decision.",
  settling: "Dispatch complete — waiting on delivery receipts.",
};
/** When a halted send's next retry is due, relative to now (SPEC §12). */
function nextRetry(retryAt: number | null): string {
  if (retryAt === null) {
    return "it is retried on its own";
  }
  const wait = retryAt - Date.now();
  return wait > 0 ? `next retry in ${fmtDuration(wait)}` : "next retry due now";
}
/** The phase's one-line gloss, said for the cause when the phase has more than one. */
function phaseBlurb(prog: SendView): string {
  const halt = prog.provider.halt;
  if (has(prog, "refused") && halt) {
    return `The provider is refusing this account — nothing more goes out until it is fixed; ${nextRetry(halt.retry_at)}.`;
  }
  if (prog.phase === "backing-off" && halt?.reason === "unavailable") {
    return `The provider is unavailable — ${nextRetry(halt.retry_at)}.`;
  }
  return PHASE_BLURB[prog.phase] || "";
}
function phasePill(phase: SendPhase): Html {
  const m = PHASE_META[phase] ?? { label: phase, tone: "muted" };
  return html`<span class="phase-pill tone-${m.tone}">${m.label}</span>`;
}

// A labeled progress bar: `tone` picks the fill color, `sub` is a muted sub-line.
function progressBar(
  tone: string,
  label: string,
  value: number,
  total: number,
  sub: string | null,
): Html {
  const p = total > 0 ? clampPct((100 * value) / total) : 0;
  return html`<div class="wbar-row">
      <div class="wbar-head"><span class="wbar-label">${label}</span><span class="wbar-count">${value.toLocaleString()} / ${total.toLocaleString()}</span></div>
      <div class="wbar" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><div class="wbar-fill tone-${tone}" style="width:${p}%"></div></div>
      ${sub ? html`<div class="wbar-sub muted">${sub}</div>` : null}
    </div>`;
}
// The delivery bar shares the dispatch bar's scale (denominator = the whole audience), so
// the two pair up: a grey `accepted` segment tracks the exact frontier the dispatch bar
// reaches, and green fills in behind it as receipts confirm. Green can never pass grey, so
// delivery visibly LAGS dispatch instead of racing ahead of it.
function deliveryBar(
  label: string,
  confirmed: number,
  accepted: number,
  total: number,
  sub: string,
): Html {
  const acceptedPct = total > 0 ? clampPct((100 * accepted) / total) : 0;
  const confirmedPct = total > 0 ? clampPct((100 * confirmed) / total) : 0;
  return html`<div class="wbar-row">
      <div class="wbar-head"><span class="wbar-label">${label}</span><span class="wbar-count">${confirmed.toLocaleString()} of ${accepted.toLocaleString()} accepted</span></div>
      <div class="wbar dual" role="progressbar" aria-valuenow="${confirmedPct}" aria-valuemin="0" aria-valuemax="100">
        <div class="wbar-fill tone-accepted" style="width:${acceptedPct}%"></div>
        <div class="wbar-fill tone-ok" style="width:${confirmedPct}%"></div>
      </div>
      <div class="wbar-sub muted">${sub}</div>
    </div>`;
}

// The counts grid mirrors the eight denormalized buckets; each swatch reuses the record
// tile palette so a bucket reads the same here and on the frozen record.
const WATCH_COUNTS: { key: keyof SendCounts; label: string; sw: string }[] = [
  { key: "pending", label: "Pending", sw: "neutral" },
  { key: "in_flight", label: "In flight", sw: "sending" },
  { key: "accepted", label: "Accepted", sw: "sending" },
  { key: "delivered", label: "Delivered", sw: "ok" },
  { key: "bounced", label: "Bounced", sw: "warn" },
  { key: "complained", label: "Complained", sw: "danger" },
  { key: "unsent", label: "Unsent", sw: "neutral" },
  { key: "skipped", label: "Skipped", sw: "neutral" },
];
function watchCountsHtml(counts: SendCounts): Html {
  return html`<div class="wcounts">${WATCH_COUNTS.map(
    (c) =>
      html`<div class="wcount"><div class="wcount-n">${(counts[c.key] || 0).toLocaleString()}</div><div class="wcount-l"><span class="rec-sw sw-${c.sw}"></span>${c.label}</div></div>`,
  )}</div>`;
}

// The dynamic half of the watch (bars + counts + health strip), repainted on each poll.
function watchBodyHtml(prog: SendView): Html {
  const c = prog.counts;
  const acceptedTotal = c.accepted + c.delivered + c.bounced + c.complained;
  const rate = prog.dispatch.rate_per_min;
  // The server gives a time to finish only while the send is handing off, never while it
  // is paused (backing off, refused, or wedged), where a rate from before the pause would
  // promise an end nothing is working toward.
  const eta = prog.dispatch.eta_ms;
  const dispatchSub =
    prog.status === "sending"
      ? `${phaseBlurb(prog)}${rate ? ` · ~${rate.toLocaleString()}/min` : ""}${
          eta ? ` · ETA ${fmtDuration(eta)}` : ""
        }`
      : "Dispatch complete.";
  const failureCount = (c.unsent || 0) + (c.bounced || 0) + (c.complained || 0);
  const providerText = noEmailProvider()
    ? "No email provider configured — nothing is delivered"
    : `Provider: ${prog.provider?.name || "—"}`;
  // The provider refusing the account is the one loud condition here without a control:
  // the fix is outside the app, and the send resumes on its own once it lands (SPEC §12).
  const refused = conditionOf(prog, "refused");
  // In flight too long (SPEC §12): the amber the dashboard's health line and the Sent
  // page's card give the same condition, in the server's words.
  const stuck = conditionOf(prog, "stuck");
  return html`
    ${stuck ? html`<div class="health amber" role="status"><span class="health-dot">⚠️</span><div>${stuck.message}</div></div>` : null}
    ${
      refused
        ? html`<div class="health red" role="alert"><span class="health-dot">⚠️</span><div><strong>The provider is refusing this account</strong><div>${refused.error}</div><div>${refused.advice}</div><div>${refused.since === null ? null : `Since ${fmt(refused.since)}. `}No one has been marked unsent, and once this is fixed the send resumes at its next retry${refused.retry_at === null ? "" : `, ${fmt(refused.retry_at)}`}.</div></div></div>`
        : null
    }
    <div class="wbars">
      ${progressBar("sending", "Dispatch — provider-accepted", acceptedTotal, prog.audience.count, dispatchSub)}
      ${deliveryBar(
        "Delivery — webhook-confirmed",
        prog.delivery.confirmed,
        acceptedTotal,
        prog.audience.count,
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
function watchMetaHtml(send: SendView): Html {
  const started = send.started_at ? `Started ${fmt(send.started_at)}` : "Sending now";
  return html`${started} · ${send.audience.count.toLocaleString()} recipients`;
}
function watchHtml(send: SendView): Html {
  const prog = send;
  return html`
    <div class="editor-head">
      <a href="#/sent" class="back">← Sent</a>
      ${can(prog, "resolve") ? html`<button type="button" class="primary" id="resolveBtn">Resolve…</button>` : null}
    </div>
    <div class="card rec-card watch-card">
      <div class="rec-head">
        <div class="watch-title"><h1>${send.subject || html`<em>untitled</em>`}</h1><span id="watchPill">${phasePill(prog.phase)}</span></div>
        <div class="rec-meta" id="watchMeta">${watchMetaHtml(send)}</div>
      </div>
      <div id="watchBody">${watchBodyHtml(prog)}</div>
      <p class="rec-note muted">This view updates live while the send is in flight. Delivery receipts keep arriving after dispatch finishes — the record stays accurate as they settle.</p>
    </div>`;
}

// Wire the header's Resolve control (present only while the server offers it, §12). It
// reuses the same modal the Sent page uses, with the wedged count the send reports.
function wireWatchHeader(root: HTMLElement, send: SendView, remount: () => void): void {
  const rb = root.querySelector<HTMLButtonElement>("#resolveBtn");
  if (rb) {
    const count = conditionOf(send, "wedged")?.count ?? send.counts.in_flight;
    rb.onclick = () => openResolveModal({ id: send.id, c_in_flight: count }, remount);
  }
}
function paintWatch(root: HTMLElement, prog: SendView): void {
  const pill = root.querySelector("#watchPill");
  if (pill) {
    setHtml(pill, phasePill(prog.phase));
  }
  const meta = root.querySelector("#watchMeta");
  if (meta) {
    setHtml(meta, watchMetaHtml(prog));
  }
  const body = root.querySelector("#watchBody");
  if (body) {
    setHtml(body, watchBodyHtml(prog));
  }
}

function startWatch(
  data: SendResponse,
  root: HTMLElement,
  signal: AbortSignal,
  remount: () => void,
): void {
  setHtml(root, watchHtml(data.send));
  wireWatchHeader(root, data.send, remount);
  // The latest report, repainted on the clock between reports: a halt's "next retry in …"
  // counts down while nothing about the send is written.
  let latest = data.send;
  every(1000, () => paintWatch(root, latest), signal);
  // From the page's own read, the send-state layer reports each change to the send, at the
  // server's pace; the watch keeps no poll of its own. Once dispatch ends it re-enters as the
  // frozen record (which settles).
  followSend(
    data,
    {
      update: (fresh) => {
        if (fresh.status !== "sending") {
          remount();
          return;
        }
        latest = fresh;
        // If Resolve just became possible, or stopped being, the header changes: re-render.
        if (can(fresh, "resolve") !== Boolean(root.querySelector("#resolveBtn"))) {
          setHtml(root, watchHtml(fresh));
          wireWatchHeader(root, fresh, remount);
        } else {
          paintWatch(root, fresh);
        }
      },
      removed: remount,
      stale: remount,
    },
    signal,
  );
}

// The delivery-outcome tiles + reconciliation line: the frozen record's body, factored
// so the settling poll can repaint them in place as late receipts arrive.
function outcomeTilesHtml(outcomes: DeliveryOutcomes): Html {
  const tiles = [
    { n: outcomes.recipients, label: "Recipients", cls: "", sw: "neutral" },
    { n: outcomes.delivered, label: "Delivered", cls: "ok", sw: "ok" },
    { n: outcomes.bounced, label: "Bounced", cls: "warn", sw: "warn" },
    { n: outcomes.complained, label: "Complained", cls: "danger", sw: "danger" },
    { n: outcomes.unsent, label: "Unsent", cls: "", sw: "neutral" },
  ];
  return html`${tiles.map(
    (t) =>
      html`<div class="rec-tile"><div class="rec-n ${t.cls}">${t.n.toLocaleString()}</div><div class="rec-l"><span class="rec-sw sw-${t.sw}"></span>${t.label}</div></div>`,
  )}`;
}
function outcomeReconHtml(outcomes: DeliveryOutcomes): string {
  const total = outcomes.recipients;
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
  // Each leftover recipient is named for what it is: only an accepted one can still get a
  // receipt. A skipped one was left out at hand-off (unsubscribed or suppressed by then)
  // and never mailed, so it is final (SPEC §6, §8), and one in flight is still being handed.
  if (outcomes.accepted) {
    parts.push(`${outcomes.accepted.toLocaleString()} accepted, awaiting a delivery receipt`);
  }
  if (outcomes.skipped) {
    parts.push(
      `${outcomes.skipped.toLocaleString()} skipped (unsubscribed or suppressed before hand-off, never mailed)`,
    );
  }
  if (outcomes.in_flight) {
    parts.push(`${outcomes.in_flight.toLocaleString()} in flight`);
  }
  const reconciled = `All ${total.toLocaleString()} accounted for: ${parts.join(", ")}.`;
  // The suppression note is scoped to what actually suppresses: hard bounces and complaints,
  // never soft bounces (counted, left on the list, SPEC §8). The aggregate counters don't
  // split soft from hard, so gate on any bounce or complaint and state the rule rather than
  // claim a count; a clean send says nothing about suppression at all.
  const suppression =
    outcomes.bounced || outcomes.complained
      ? " Hard bounces and spam complaints are suppressed automatically, so those addresses won't be mailed again."
      : "";
  return `${reconciled}${suppression}`;
}
// Whether two readings of the record agree on every bucket, so a settling tick that
// brought nothing new leaves the page as it is.
function sameOutcomes(a: DeliveryOutcomes, b: DeliveryOutcomes): boolean {
  return (Object.keys(a) as (keyof DeliveryOutcomes)[]).every((k) => a[k] === b[k]);
}

interface Outcome {
  label: string;
  sw: string;
  hint?: string;
}

// The per-recipient record: the outcome tiles summarize, this shows the actual rows. A
// row's OUTCOME is derived from the same two facts the tiles bucket (the webhook `event`
// winning over the send-loop `status`), so a row reads the same bucket (and reuses the
// same swatch palette) as its tile. A bounce splits soft vs hard on `bounce_kind`, the
// provider's permanent/transient signal frozen onto the row when the event landed (SPEC
// §8), a fact of THIS send, not a read of the current suppression list. Null = unknown.
function deliveryOutcome(r: DeliveryRecord): Outcome {
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

// The three view tabs the record opens on, failures first (the rows that went wrong).
const DELIVERY_TABS: { v: DeliveryView; label: string }[] = [
  { v: "failures", label: "Failures" },
  { v: "delivered", label: "Delivered" },
  { v: "all", label: "All" },
];

/** The per-recipient list's state: the list controls' plus which bucket it shows. */
interface DeliveryListState extends ListState {
  view: DeliveryView;
}

// A positive/neutral empty state per view: an empty "failures" list is good news, not a gap.
function deliveryEmpty(dstate: DeliveryListState): string {
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

function recordDeliveryQuery(d: DeliveryListState): string {
  const p = new URLSearchParams();
  p.set("view", d.view);
  const term = (d.search || "").trim();
  if (term) {
    p.set("search", term);
  }
  if (d.sort) {
    p.set("sort", d.sort);
    p.set("dir", d.dir ?? "asc");
  }
  p.set("limit", String(d.limit));
  p.set("offset", String(d.offset));
  return p.toString();
}

function deliveryRowsHtml(rows: DeliveryRecord[], dstate: DeliveryListState): Html {
  const body = rows.map((r) => {
    const o = deliveryOutcome(r);
    // The label names the bucket; its consequence (suppressed or not, awaiting a receipt)
    // is taught once in prose by the reconciliation line above and kept on the row only as
    // a hover tooltip, so a row stays a clean one-liner instead of restating the taxonomy
    // on every line.
    const outcome = o.hint
      ? html`<span class="rec-out" title="${o.hint}"><span class="rec-sw sw-${o.sw}"></span>${o.label}</span>`
      : html`<span class="rec-out"><span class="rec-sw sw-${o.sw}"></span>${o.label}</span>`;
    const detail = r.error || r.event_detail || "";
    const when = r.event_at ? fmt(r.event_at) : "";
    return html`<tr><td class="rec-email">${r.email}</td><td>${outcome}</td><td class="muted">${detail || "—"}</td><td class="muted">${when || "—"}</td></tr>`;
  });
  return html`<div class="table-wrap"><table class="list-table rec-people-table"><colgroup><col><col class="c-out"><col><col class="c-date"></colgroup><thead><tr>${th(
    "Recipient",
    "email",
    dstate,
  )}<th class="c-out">Outcome</th><th>Detail</th><th class="c-date">When</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderFrozenRecord(
  id: string,
  data: SendResponse,
  root: HTMLElement,
  signal: AbortSignal,
  remount: () => void,
): void {
  const { send, outcomes } = data;
  if (send.status === "canceled") {
    renderCanceled(send, root);
    return;
  }
  // The published post, which the send's view links once it is sent.
  const archive = send.links.archive;
  const total = outcomes.recipients;
  const sentAt = send.completed_at ?? send.fire_at;

  setHtml(
    root,
    html`
    <div class="editor-head">
      <a href="#/sent" class="back">← Sent</a>
      ${archive ? html`<button type="button" class="primary" id="viewPublished">View published post&nbsp;↗</button>` : null}
    </div>
    <div class="card rec-card">
      <div class="rec-head">
        <div class="watch-title"><h1>${send.subject || html`<em>untitled</em>`}</h1><span id="recPill">${phasePill(send.phase)}</span></div>
        <div class="rec-meta">Sent ${fmt(sentAt)} · ${total.toLocaleString()} recipients</div>
      </div>
      <p class="rec-tiles-cap muted">Delivery outcomes — these keep updating as receipts arrive; the audience at fire and the published post are fixed.</p>
      <div class="rec-tiles">${outcomeTilesHtml(outcomes)}</div>
      <p class="rec-recon muted">${outcomeReconHtml(outcomes)}</p>
      <div class="rec-actions">
        <button type="button" class="ghost" id="csvBtn">Export recipients (CSV)</button>
      </div>
      <div class="rec-people">
        <div class="rec-people-head">
          <h2 class="rec-people-title">Recipients</h2>
          <div class="rec-views" role="group" aria-label="Which recipients to show">
            ${DELIVERY_TABS.map(
              (t, i) =>
                html`<button type="button" class="rec-view-btn" data-view="${t.v}" aria-pressed="${i === 0 ? "true" : "false"}">${t.label}</button>`,
            )}
          </div>
        </div>
        <input class="rec-people-search" type="search" placeholder="Search email…" aria-label="Search recipients by email" autocomplete="off">
        <div id="recRows" class="muted">Loading…</div>
        <div id="recPager"></div>
      </div>
      <p class="rec-note muted">This is the record of what went out — the published post is the exact frozen copy readers received, and nothing here is editable.</p>
    </div>`,
  );

  const viewBtn = document.getElementById("viewPublished");
  if (viewBtn && archive) {
    viewBtn.onclick = () => window.open(archive, "_blank", "noopener");
  }

  // The per-recipient record, its own paged/filtered state. Default view is "failures" so
  // the rows that went wrong lead; default sort mirrors the CSV (email asc). It reloads on
  // interaction (a view/search/sort/page change, or re-clicking the view), and on each
  // settling refresh that moved the tiles, so the list follows the counts above it. The
  // two are separate reads, so between refreshes they can differ by what one tick brought.
  const dstate: DeliveryListState = {
    view: "failures",
    search: "",
    sort: "email",
    dir: "asc",
    offset: 0,
    limit: 50,
  };
  const rowsEl = $("#recRows", root);
  const recPagerEl = $("#recPager", root);
  // Loads can overlap (a refresh's reload racing the reader's click), so only the latest
  // paints. A load the reader started that a refresh then overtook still owes them an
  // answer, so the refresh's failure is theirs to see.
  let latest = 0;
  let readerWaiting = false;
  const load = async (background: boolean): Promise<void> => {
    const mine = ++latest;
    if (!background) {
      readerWaiting = true;
    }
    try {
      const d = await api<DeliveryListResponse>(
        `/sends/${id}/deliveries?${recordDeliveryQuery(dstate)}`,
        { signal },
      );
      if (mine !== latest) {
        return;
      }
      // The reader's page, past the end now that the total shrank: the last page instead.
      const last =
        d.page.total > 0 ? Math.floor((d.page.total - 1) / d.page.limit) * d.page.limit : 0;
      if (!d.deliveries.length && dstate.offset > last) {
        dstate.offset = last;
        return load(background);
      }
      readerWaiting = false;
      keepFocus(() => {
        if (!d.deliveries.length) {
          setHtml(rowsEl, html`<p class="rec-people-empty muted">${deliveryEmpty(dstate)}</p>`);
          setHtml(recPagerEl, html``);
          return;
        }
        setHtml(rowsEl, deliveryRowsHtml(d.deliveries, dstate));
        wireSort(rowsEl, dstate, loadDeliveries);
        renderPager(recPagerEl, dstate, d.page, loadDeliveries);
      });
    } catch (e) {
      // A refresh that fails leaves the rows the reader is reading; the next refresh that
      // moves the counts tries again. Only a load the reader is waiting on says so.
      if (mine === latest && (!background || readerWaiting)) {
        readerWaiting = false;
        renderError(rowsEl, message(e), loadDeliveries);
      }
    }
  };
  const loadDeliveries = () => load(false);
  // A repaint replaces the table and the pager, so a keyboard reader on a sort header or a
  // pager button would lose their place: put focus back on the same control, if it's there.
  const keepFocus = (paint: () => void) => {
    const had = document.activeElement;
    const within = had instanceof HTMLElement && (rowsEl.contains(had) || recPagerEl.contains(had));
    const sortKey = within ? had.dataset.sort : undefined;
    const pagerCls = within
      ? ["pager-prev", "pager-next"].find((c) => had.classList.contains(c))
      : undefined;
    paint();
    const again = sortKey
      ? rowsEl.querySelector<HTMLButtonElement>(`.th-sort[data-sort="${sortKey}"]`)
      : pagerCls
        ? recPagerEl.querySelector<HTMLButtonElement>(`.${pagerCls}`)
        : null;
    if (again && !again.disabled) {
      again.focus();
    }
  };
  const viewButtons = $$<HTMLButtonElement>(".rec-view-btn", root);
  for (const b of viewButtons) {
    b.onclick = () => {
      const v = b.dataset.view;
      if (v === "failures" || v === "delivered" || v === "all") {
        dstate.view = v;
      }
      dstate.offset = 0;
      for (const x of viewButtons) {
        x.setAttribute("aria-pressed", String(x === b));
      }
      loadDeliveries();
    };
  }
  const recSearch = root.querySelector<HTMLInputElement>(".rec-people-search");
  if (recSearch) {
    let t: number | undefined;
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

  const csvBtn = $<HTMLButtonElement>("#csvBtn");
  csvBtn.onclick = () =>
    busy(csvBtn, "Exporting…", async () => {
      try {
        const csv = await apiFile(send.links.deliveries_csv);
        const url = URL.createObjectURL(new Blob([csv.text], { type: "text/csv" }));
        const a = document.createElement("a");
        a.href = url;
        // The server's name for it (the archive slug), so the file is named the same
        // however it's fetched.
        a.download = csv.filename ?? "deliveries.csv";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } catch (e) {
        toast(message(e));
      }
    });

  // The record keeps absorbing delivery receipts after dispatch (§6), and follows them
  // through the send-state layer at the server's pace (DESIGN §9): closely while they
  // arrive, easing off as they slow, then about once a minute, for as long as the page is
  // open, since a complaint can land long after the last delivery. Each report carries the
  // send's counters, which give every tile, so a read that brings nothing costs nothing
  // here. One that moved a count repaints the tiles and reloads the list on the reader's
  // page, in their view, search, and sort; the pill turns from Settling to Complete in place.
  let shown = outcomes;
  followSend(
    data,
    {
      update(fresh) {
        if (fresh.status === "sending") {
          remount(); // resumed (a Resolve that put recipients back, say) → back to the watch
          return;
        }
        setHtml($("#recPill", root), phasePill(fresh.phase));
        const now = outcomesOf(fresh);
        if (sameOutcomes(shown, now)) {
          return;
        }
        shown = now;
        setHtml($(".rec-tiles", root), outcomeTilesHtml(now));
        $(".rec-recon", root).textContent = outcomeReconHtml(now);
        void load(true);
      },
      removed: remount,
      stale: remount,
    },
    signal,
  );
}

/** A sent send's outcomes from its counters: the same buckets as the record's own read,
 *  one per recipient, over the audience fixed at fire. As there, a recipient not yet handed
 *  off (pending) counts as in flight. */
function outcomesOf(send: SendView): DeliveryOutcomes {
  const c = send.counts;
  return {
    recipients: send.audience.count,
    delivered: c.delivered,
    bounced: c.bounced,
    complained: c.complained,
    unsent: c.unsent,
    skipped: c.skipped,
    accepted: c.accepted,
    in_flight: c.pending + c.in_flight,
  };
}

/**
 * A canceled send's page: it never fired, so there is no audience, outcome, or published
 * post to show, only that it was canceled, when, and when it would have sent.
 */
function renderCanceled(send: SendView, root: HTMLElement): void {
  setHtml(
    root,
    html`
    <div class="editor-head">
      <a href="#/sent" class="back">← Sent</a>
    </div>
    <div class="card rec-card">
      <div class="rec-head">
        <div class="watch-title"><h1>${send.subject || html`<em>untitled</em>`}</h1><span id="recPill">${phasePill(send.phase)}</span></div>
        <div class="rec-meta">Canceled ${fmt(send.completed_at)} · was scheduled for ${fmt(send.fire_at)}</div>
      </div>
      <p class="rec-note muted">This send was canceled before it fired, so no one was mailed.</p>
    </div>`,
  );
}
