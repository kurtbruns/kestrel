// The sent list and the send actions: countdowns, the wedged-send resolution, and
// rescheduling.

import type {
  ResolveResponse,
  SendListResponse,
  SendSummary,
  StuckResolution,
} from "../../shared/sends";
import { api } from "../api";
import { noEmailProvider } from "../build_ref";
import { $, $$ } from "../dom";
import { fmt, modal, toast, toLocalInput, untilStr } from "../helpers";
import { type Html, html, setHtml } from "../html";
import {
  type ListState,
  listQuery,
  listToolbar,
  renderPager,
  th,
  wireSort,
  wireToolbar,
} from "../list_controls";
import { busy, renderError } from "../notice";
import { app } from "../shell";
import { appState } from "../state";
import { clampPct, fmtDuration } from "./sent";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function startCountdowns(): void {
  // Clear any prior interval first: reloadAll() re-runs loadScheduled (and this) on
  // every cancel/resolve, so without this each refresh would leak a 1s interval.
  if (appState.statusTimer) {
    clearInterval(appState.statusTimer);
  }
  const tick = () => {
    for (const el of $$<HTMLElement>("[data-fire]")) {
      el.textContent = untilStr(Number(el.dataset.fire));
    }
  };
  tick();
  appState.statusTimer = setInterval(tick, 1000);
}

/**
 * A send wedged on ambiguous in-flight rows: still `sending`, nothing left pending, but
 * one or more in-flight recipients whose fate a transport error left unknown (SPEC §12).
 * This is the state the sweep flags and the operator must adjudicate; it can't clear on
 * its own without risking a double-mail (I4). Read straight off the row's denormalized
 * counters, the same signals the server derives `wedged` from, so the list and the
 * watch agree. The lease check is essential: while the loop is actively working a send
 * it holds the lease (`locked_until` in the future), so a normal send's final dispatched
 * batch (pending 0, in flight > 0) is not a wedge, just work in progress. A genuine wedge
 * has released the lease.
 */
export function isWedged(s: SendSummary): boolean {
  const leaseHeld = s.locked_until != null && s.locked_until > Date.now();
  return s.status === "sending" && !(s.c_pending || 0) && (s.c_in_flight || 0) > 0 && !leaseHeld;
}

/**
 * The one manual step for a wedged send: decide whether the ambiguous batch went out or
 * not. Both outcomes are safe for I4 (neither re-mails this post), so the modal explains
 * the trade-off (record accuracy) rather than warning of a double-send.
 */
export function openResolveModal(send: SendSummary, reload: () => void): void {
  const n = send.c_in_flight || 0;
  const noun = n === 1 ? "delivery" : "deliveries";
  const m = modal(
    html`<h3>Resolve ${n} ambiguous ${noun}</h3>
      <p class="hint">A transport error left ${n} recipient${n === 1 ? "" : "s"} in flight: the request went out but the provider never confirmed, so we can't know if it was accepted. To avoid mailing anyone twice, the send won't retry ${n === 1 ? "it" : "them"} on its own — so it can't finish until you decide. Neither choice re-sends this post.</p>
      <p class="hint"><strong>Assume not sent</strong> — recorded as unsent; ${n === 1 ? "the address is" : "the addresses are"} simply picked up by your next post.</p>
      <p class="hint"><strong>Assume sent</strong> — recorded as delivered. Choose this only if you've confirmed it in your provider's console.</p>
      <div class="actions"><button type="button" id="rCancel">Cancel</button><button type="button" id="rUnsent">Assume not sent</button><button type="button" class="primary" id="rAccepted">Assume sent</button></div>`,
  );
  $("#rCancel", m.el).onclick = m.close;
  const doResolve = (btn: HTMLButtonElement, resolution: StuckResolution, verb: string) =>
    busy(btn, "Resolving…", async () => {
      try {
        const res = await api<ResolveResponse>(`/sends/${send.id}/resolve`, {
          method: "POST",
          json: { resolution },
        });
        m.close();
        toast(res.completed ? "Send completed" : `Marked ${verb}`);
        reload();
      } catch (e) {
        toast(message(e));
      }
    });
  const unsent = $<HTMLButtonElement>("#rUnsent", m.el);
  const accepted = $<HTMLButtonElement>("#rAccepted", m.el);
  unsent.onclick = () => doResolve(unsent, "unsent", "not sent");
  accepted.onclick = () => doResolve(accepted, "accepted", "sent");
}

/**
 * Move a scheduled send's fire time without canceling or re-editing: the content stays
 * frozen (I3) and the cancelable review window is preserved (I6); only fire_at moves,
 * via POST /sends/:id/reschedule (SPEC §6). The same datetime picker as the Schedule
 * modal, prefilled with the current fire time and floored at the minimum lead. Shared
 * by the editor's scheduled banner and the Sent page's scheduled card (SPEC §8), so
 * `onDone` re-renders whichever surface opened it.
 */
export function openRescheduleModal(
  sendId: string,
  currentFireAt: number,
  onDone: () => void,
): void {
  const minStr = toLocalInput(new Date(Date.now() + 6 * 60000));
  const cur = toLocalInput(new Date(currentFireAt));
  const m = modal(
    html`<h3 id="rsHead">Reschedule this post</h3>
      <p class="hint">Move when it sends (at least 5 minutes out). The content stays frozen and the cancelable window is kept — only the time changes.</p>
      <label for="rsWhen">Send at</label><input type="datetime-local" id="rsWhen" min="${minStr}" value="${cur}">
      <div class="actions"><button type="button" id="rsCancel">Cancel</button><button type="button" class="primary" id="rsGo">Reschedule</button></div>`,
  );
  const box = $(".modal", m.el);
  box.setAttribute("aria-labelledby", "rsHead");
  const go = $<HTMLButtonElement>("#rsGo", box);
  const when = $<HTMLInputElement>("#rsWhen", box);
  $("#rsCancel", box).onclick = m.close;
  go.onclick = () =>
    busy(go, "Rescheduling…", async () => {
      const v = when.value;
      const t = v ? new Date(v).getTime() : Number.NaN;
      if (Number.isNaN(t)) {
        toast("Pick a valid date & time");
        return;
      }
      try {
        await api(`/sends/${sendId}/reschedule`, {
          method: "POST",
          json: { fire_at: new Date(t).toISOString() },
        });
        m.close();
        toast("Rescheduled");
        onDone();
      } catch (e) {
        toast(message(e));
      }
    });
  when.focus();
}

// Dispatch/delivery numbers from a `/sends` list row's denormalized counters, so the
// active-send row and the dashboard widget need no per-send /progress read. `done` is
// the dispatch fraction (accepted vs the frozen total), matching the watch's dispatch bar.
function listRowCounts(s: SendSummary) {
  const total =
    (s.c_pending || 0) +
    (s.c_in_flight || 0) +
    (s.c_accepted || 0) +
    (s.c_delivered || 0) +
    (s.c_bounced || 0) +
    (s.c_complained || 0) +
    (s.c_skipped || 0) +
    (s.c_unsent || 0);
  const t = total > 0 ? total : s.recipient_count || 0;
  const done =
    (s.c_accepted || 0) + (s.c_delivered || 0) + (s.c_bounced || 0) + (s.c_complained || 0);
  const confirmed = (s.c_delivered || 0) + (s.c_bounced || 0) + (s.c_complained || 0);
  const pct = t > 0 ? Math.round((100 * done) / t) : 0;
  // Rough ETA from the average rate since the send started — the same cumulative
  // estimate /progress reports, computed here off the list row so no extra read is needed.
  let etaMs: number | null = null;
  if (s.started_at && done > 0 && t > done) {
    const elapsed = Date.now() - s.started_at;
    if (elapsed > 0) {
      etaMs = ((t - done) * elapsed) / done;
    }
  }
  return { total: t, accepted: done, confirmed, pct, etaMs };
}

/**
 * A `/sends` list row's "Delivered" cell, from its denormalized counters. It reports TRUE
 * delivered (webhook-confirmed `c_delivered`, not provider-`accepted`), so the Sent list
 * and dashboard recent-sends agree with the record view's "Delivered" for the same send,
 * and a bounced/complained recipient is never miscounted as delivered. Any bounce /
 * complaint / unsent shows as a muted delivery-failure note beneath the count, worst
 * first, so a bad send reads as one at a glance. A clean send prints nothing.
 */
export function deliveredCell(s: SendSummary): Html {
  const delivered = s.c_delivered || 0;
  const kinds: string[] = [];
  if (s.c_complained) {
    kinds.push(`${s.c_complained.toLocaleString()} complained`);
  }
  if (s.c_bounced) {
    kinds.push(`${s.c_bounced.toLocaleString()} bounced`);
  }
  if (s.c_unsent) {
    kinds.push(`${s.c_unsent.toLocaleString()} unsent`);
  }
  // Each kind is one unbreakable unit, so a wrap lands between kinds, never inside one.
  const note = kinds.length
    ? html`<span class="muted delivered-note">${kinds.map((text, i) => html`${i ? ", " : ""}<span class="delivered-kind">${text}</span>`)}</span>`
    : null;
  return html`<span class="n">${delivered.toLocaleString()}</span>${note}`;
}

/**
 * One in-progress send as a card with a live mini dispatch bar, an ETA, and a Watch link.
 * The whole card opens the watch; the "Watch" link is the keyboard/middle-click target.
 */
export function activeRowHtml(s: SendSummary): Html {
  const c = listRowCounts(s);
  const eta = c.etaMs != null ? ` · ~${fmtDuration(c.etaMs)} left` : "";
  return html`<div class="card spread clickable active-card" data-watch="${s.id}">
      <div class="active-main">
        <a class="card-link active-subj" href="#/sent/${s.id}">${s.subject || html`<em>untitled</em>`}</a>
        <div class="active-bar"><div class="active-fill" style="width:${clampPct(c.pct)}%"></div></div>
        <div class="muted active-stat">Sending — ${c.accepted.toLocaleString()} of ${c.total.toLocaleString()} accepted${
          c.confirmed ? ` · ${c.confirmed.toLocaleString()} confirmed` : ""
        }${eta}</div>
      </div>
      <a class="ghost-link" href="#/sent/${s.id}">Watch&nbsp;→</a>
    </div>`;
}

export async function renderSent(): Promise<void> {
  // The dispatch side: the still-cancelable Scheduled queue on top, then the frozen Sent
  // records. The table is sent-only, so it carries no status column or filter; default
  // sort = fire desc so the "When" header shows its arrow from the start.
  const state: ListState = {
    status: "sent",
    search: "",
    failures: "",
    sort: "fire",
    dir: "desc",
    offset: 0,
    limit: 50,
  };
  setHtml(
    app,
    html`<h1>Sent</h1>
    ${noEmailProvider() ? html`<p class="muted">No email provider is configured, so these sends are recorded here but nothing is delivered.</p>` : null}
    <div id="stuck"></div>
    <h2>Scheduled</h2><div id="scheduled" class="muted">Loading…</div>
    <div id="active"></div>
    <h2>Sent posts</h2>
    ${listToolbar({ searchPlaceholder: "Search subject…", failures: true })}
    <div id="sendsList" class="muted">Loading…</div>
    <div id="sendsPager"></div>`,
  );
  const stuckEl = $("#stuck");
  const schedEl = $("#scheduled");
  const activeEl = $("#active");
  const listEl = $("#sendsList");
  const pagerEl = $("#sendsPager");

  // Resolving a wedged send or canceling a scheduled one touches several sections at
  // once, so refresh them together.
  function reloadAll() {
    loadScheduled();
    loadList();
    refreshSending();
  }

  // The in-flight set drives two sections, the wedged attention block (§12) and the
  // in-progress active rows, so one fetch renders both. Tracking the set's signature
  // lets us tell a real transition (a send fired or finished) from a mere bar advance:
  // on a transition we also refresh the scheduled queue (it lost this send) and the sent
  // list (it gained it), so a fired post leaves the scheduled slot and lands in the
  // records without a manual reload. Polled every 3s (matching the watch + dashboard).
  let sentActiveSig = "";
  function renderActive(sends: SendSummary[]) {
    const active = sends.filter((s) => !isWedged(s));
    setHtml(
      activeEl,
      active.length ? html`<h2>In progress</h2>${active.map(activeRowHtml)}` : html``,
    );
    for (const card of $$<HTMLElement>("[data-watch]", activeEl)) {
      card.onclick = (e) => {
        if (!(e.target instanceof Element && e.target.tagName === "A")) {
          location.hash = `#/sent/${card.dataset.watch}`;
        }
      };
    }
  }
  function renderStuck(sends: SendSummary[]) {
    const wedged = sends.filter(isWedged);
    setHtml(
      stuckEl,
      html`${wedged.map((s) => {
        const n = s.c_in_flight || 0;
        const noun = n === 1 ? "delivery" : "deliveries";
        return html`<div class="card stuck-card"><div class="stuck-head"><span class="stuck-dot">⚠️</span><div><strong>${s.subject}</strong><div class="muted">${n} ambiguous ${noun} — this send can't finish until you resolve ${n === 1 ? "it" : "them"}.</div></div></div><button class="primary" data-resolve="${s.id}">Resolve…</button></div>`;
      })}`,
    );
    for (const b of $$<HTMLButtonElement>("[data-resolve]", stuckEl)) {
      const s = wedged.find((x) => x.id === b.dataset.resolve);
      if (s) {
        b.onclick = () => openResolveModal(s, reloadAll);
      }
    }
  }
  async function refreshSending() {
    let sends: SendSummary[];
    try {
      ({ sends } = await api<SendListResponse>("/sends?status=sending&limit=200"));
    } catch {
      // Non-fatal: the in-flight sections just stay empty if this probe fails.
      setHtml(stuckEl, html``);
      setHtml(activeEl, html``);
      return;
    }
    renderStuck(sends);
    renderActive(sends);
    const sig = sends
      .map((s) => s.id)
      .sort()
      .join(",");
    if (sig !== sentActiveSig) {
      sentActiveSig = sig;
      loadScheduled(); // a fired send left the queue; the next one moves up
      loadList(); // a finished send joins the records
    }
  }

  // The upcoming queue, soonest-first: the next send to fire (and the one you'd reach
  // for the cancel window on) sits at the top. Fetched on its own so it shows every
  // scheduled send regardless of the table's paging/filter below.
  async function loadScheduled() {
    try {
      const { sends } = await api<SendListResponse>(
        "/sends?status=scheduled&sort=fire&dir=asc&limit=200",
      );
      const schedCard = (s: SendSummary) =>
        html`<div class="card spread clickable sched-card" data-post="${s.post_id}"><div><a class="card-link sched-subj" href="#/edit/${s.post_id}">${s.subject}</a><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div><div class="row"><button class="ghost" data-reschedule="${s.id}">Reschedule</button><button class="ghost" data-cancel="${s.id}">Cancel</button></div></div>`;
      const [first, ...rest] = sends;
      if (!first) {
        setHtml(schedEl, html`<p class="muted">Nothing scheduled.</p>`);
      } else {
        // Show only the soonest to send, so the sent records stay near the top of the
        // page; any others collapse behind a "Show all" toggle (usually there are none:
        // a post has at most one active send).
        setHtml(
          schedEl,
          html`${schedCard(first)}${
            rest.length
              ? html`<div id="schedMore" hidden>${rest.map(schedCard)}</div><button type="button" class="ghost sched-toggle" id="schedToggle" aria-expanded="false">Show all ${sends.length} scheduled</button>`
              : null
          }`,
        );
        const toggle = schedEl.querySelector<HTMLButtonElement>("#schedToggle");
        if (toggle) {
          toggle.onclick = () => {
            const more = $("#schedMore", schedEl);
            const show = more.hidden;
            more.hidden = !show;
            toggle.setAttribute("aria-expanded", String(show));
            toggle.textContent = show ? "Show fewer" : `Show all ${sends.length} scheduled`;
          };
        }
      }
      // The whole card opens the post; the subject link handles keyboard/middle-click,
      // and the schedule-management buttons (Reschedule, Cancel) opt out of navigation
      // (like the posts table's row-click guard).
      for (const card of $$<HTMLElement>(".card.clickable", schedEl)) {
        card.onclick = (e) => {
          const t = e.target;
          if (t instanceof Element && t.tagName !== "A" && !t.closest("button")) {
            location.hash = `#/edit/${card.dataset.post}`;
          }
        };
      }
      for (const b of $$<HTMLButtonElement>("[data-reschedule]", schedEl)) {
        const s = sends.find((x) => x.id === b.dataset.reschedule);
        if (s) {
          b.onclick = () => openRescheduleModal(s.id, s.fire_at, reloadAll);
        }
      }
      for (const b of $$<HTMLButtonElement>("[data-cancel]", schedEl)) {
        b.onclick = () =>
          busy(b, "Canceling…", async () => {
            try {
              await api(`/sends/${b.dataset.cancel}/cancel`, { method: "POST" });
              toast("Canceled");
              // A cancel drops it from the queue and flips it to canceled in the table.
              reloadAll();
            } catch (e) {
              toast(message(e));
            }
          });
      }
      startCountdowns();
    } catch (e) {
      renderError(schedEl, message(e), loadScheduled);
    }
  }

  // The frozen Sent records: every completed post, each opening its read-only record
  // view. Sent-only, so no status column; the "When" is the send's completion.
  async function loadList() {
    try {
      const data = await api<SendListResponse>(`/sends?${listQuery(state)}`);
      const sends = data.sends;
      if (!sends.length) {
        setHtml(
          listEl,
          html`<p class="muted">${
            state.search
              ? "No sent posts match."
              : state.failures
                ? "Every sent post delivered cleanly."
                : "No sent posts yet."
          }</p>`,
        );
        setHtml(pagerEl, html``);
        return;
      }
      // Cells are named (subject / recipients / delivered) and the count is wrapped in
      // `.n` so the ≤720px layout can stack a row and label its numbers from CSS alone.
      setHtml(
        listEl,
        html`<div class="table-wrap"><table class="list-table sent-table stacks"><colgroup><col><col class="c-date"><col class="c-num"><col class="c-delivered"></colgroup><thead><tr>${th("Subject", "subject", state)}${th("When", "fire", state)}${th("Recipients", "recipients", state, "num")}<th class="num">Delivered</th></tr></thead><tbody>${sends.map(
          (s) =>
            html`<tr class="clickable" data-id="${s.id}"><td class="subject"><a href="#/sent/${s.id}">${s.subject}</a></td><td class="muted">${fmt(s.completed_at ?? s.fire_at)}</td><td class="num recipients"><span class="n">${s.recipient_count.toLocaleString()}</span></td><td class="num delivered">${deliveredCell(s)}</td></tr>`,
        )}</tbody></table></div>`,
      );
      wireSort(listEl, state, loadList);
      // The whole row opens the record; the subject link handles keyboard/middle-click.
      for (const tr of $$<HTMLTableRowElement>("tr[data-id]", listEl)) {
        tr.onclick = (e) => {
          if (!(e.target instanceof Element && e.target.tagName === "A")) {
            location.hash = `#/sent/${tr.dataset.id}`;
          }
        };
      }
      renderPager(pagerEl, state, data.page, loadList);
    } catch (e) {
      renderError(listEl, message(e), loadList);
    }
  }

  wireToolbar(app, state, loadList);
  reloadAll();
  // Poll the in-flight sections every 3s (matching the watch + dashboard): the active
  // bar advances, and a fired/finished send moves through the queue → in-progress →
  // records on its own. A recursive setTimeout so a slow read never overlaps; cleared on
  // navigation (route() clears progressTimer). Countdowns run on statusTimer.
  const scheduleSentPoll = () => {
    const gen = appState.navGeneration;
    appState.progressTimer = setTimeout(async () => {
      await refreshSending();
      // Navigated off the Sent page mid-fetch: the sections refreshSending paints are gone
      // and the reschedule would leak onto the new view's poll timer. Bail (see navGeneration).
      if (gen !== appState.navGeneration) {
        return;
      }
      scheduleSentPoll();
    }, 3000);
  };
  scheduleSentPoll();
}
