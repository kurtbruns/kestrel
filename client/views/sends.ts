// @ts-nocheck
// The sent list and the send actions: countdowns, the wedged-send resolution, and
// rescheduling.

import { api } from "../api";
import { noEmailProvider } from "../build_ref";
import { esc, fmt, modal, toast, toLocalInput, untilStr } from "../helpers";
import { listQuery, listToolbar, renderPager, th, wireSort, wireToolbar } from "../list_controls";
import { busy, renderError } from "../notice";
import { app } from "../shell";
import { appState } from "../state";
import { clampPct, fmtDuration } from "./sent";

export function startCountdowns() {
  // Clear any prior interval first: reloadAll() re-runs loadScheduled (and this) on
  // every cancel/resolve, so without this each refresh would leak a 1s interval.
  if (appState.statusTimer) {
    clearInterval(appState.statusTimer);
  }
  const tick = () =>
    document.querySelectorAll("[data-fire]").forEach((el) => {
      el.textContent = untilStr(Number(el.dataset.fire));
    });
  tick();
  appState.statusTimer = setInterval(tick, 1000);
}

// A send wedged on ambiguous in-flight rows: still `sending`, nothing left pending,
// but one or more in-flight recipients whose fate a transport error left unknown
// (SPEC §12). This is the state the sweep flags and the operator must adjudicate; it
// can't clear on its own without risking a double-mail (I4). Read straight off the row's
// denormalized counters (`sends.c_pending` / `c_in_flight`) — the same signals the
// server's buildSendProgress derives `wedged` from, so the list and the watch agree.
// The lease check is essential: while the loop is ACTIVELY working a send it holds the
// lease (`locked_until` in the future) — so a normal send's final dispatched batch
// (pending 0, in flight > 0) is not a wedge, just work in progress. A genuine wedge has
// released the lease. Without this, every send briefly flashed "needs attention" at the
// tail of its dispatch.
export function isWedged(s) {
  const leaseHeld = s.locked_until != null && s.locked_until > Date.now();
  return s.status === "sending" && !(s.c_pending || 0) && (s.c_in_flight || 0) > 0 && !leaseHeld;
}

// The one manual step for a wedged send: decide whether the ambiguous batch went out
// or not. Both outcomes are safe for I4 — neither re-mails this post — so the modal
// explains the trade-off (record accuracy) rather than warning of a double-send.
export function openResolveModal(send, reload) {
  const n = send.c_in_flight || 0;
  const noun = n === 1 ? "delivery" : "deliveries";
  const m = modal(
    `<h3>Resolve ${n} ambiguous ${noun}</h3>` +
      `<p class="hint">A transport error left ${n} recipient${n === 1 ? "" : "s"} in flight: the request went out but the provider never confirmed, so we can't know if it was accepted. To avoid mailing anyone twice, the send won't retry ${n === 1 ? "it" : "them"} on its own — so it can't finish until you decide. Neither choice re-sends this post.</p>` +
      `<p class="hint"><strong>Assume not sent</strong> — recorded as unsent; ${n === 1 ? "the address is" : "the addresses are"} simply picked up by your next post.</p>` +
      `<p class="hint"><strong>Assume sent</strong> — recorded as delivered. Choose this only if you've confirmed it in your provider's console.</p>` +
      `<div class="actions"><button type="button" id="rCancel">Cancel</button><button type="button" id="rUnsent">Assume not sent</button><button type="button" class="primary" id="rAccepted">Assume sent</button></div>`,
  );
  m.el.querySelector("#rCancel").onclick = m.close;
  const doResolve = (btn, resolution, verb) =>
    busy(btn, "Resolving…", async () => {
      try {
        const res = await api(`/sends/${send.id}/resolve`, {
          method: "POST",
          json: { resolution },
        });
        m.close();
        toast(res.completed ? "Send completed" : `Marked ${verb}`);
        reload();
      } catch (e) {
        toast(e.message);
      }
    });
  m.el.querySelector("#rUnsent").onclick = (e) => doResolve(e.target, "unsent", "not sent");
  m.el.querySelector("#rAccepted").onclick = (e) => doResolve(e.target, "accepted", "sent");
}

// Move a scheduled send's fire time without canceling or re-editing: the content stays
// frozen (I3) and the cancelable review window is preserved (I6) — only fire_at moves, via
// POST /sends/:id/reschedule (SPEC §6). The same datetime picker as the Schedule modal,
// prefilled with the current fire time and floored at the minimum lead. Shared by the
// editor's scheduled banner and the Sent page's scheduled card (SPEC §8), so `onDone`
// re-renders whichever surface opened it.
export function openRescheduleModal(sendId, currentFireAt, onDone) {
  const minStr = toLocalInput(new Date(Date.now() + 6 * 60000));
  const cur = toLocalInput(new Date(currentFireAt));
  const m = modal(
    `<h3 id="rsHead">Reschedule this post</h3>` +
      `<p class="hint">Move when it sends (at least 5 minutes out). The content stays frozen and the cancelable window is kept — only the time changes.</p>` +
      `<label for="rsWhen">Send at</label><input type="datetime-local" id="rsWhen" min="${minStr}" value="${cur}">` +
      `<div class="actions"><button type="button" id="rsCancel">Cancel</button><button type="button" class="primary" id="rsGo">Reschedule</button></div>`,
  );
  const box = m.el.querySelector(".modal");
  box.setAttribute("aria-labelledby", "rsHead");
  box.querySelector("#rsCancel").onclick = m.close;
  box.querySelector("#rsGo").onclick = () =>
    busy(box.querySelector("#rsGo"), "Rescheduling…", async () => {
      const v = box.querySelector("#rsWhen").value;
      const t = v ? new Date(v).getTime() : NaN;
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
        toast(e.message);
      }
    });
  box.querySelector("#rsWhen").focus();
}

// Dispatch/delivery numbers from a `/sends` list row's denormalized counters (SEND_LIST_COLS),
// so the active-send row and the dashboard widget need no per-send /progress read. `done`
// is the dispatch fraction (accepted vs the frozen total), matching the watch's dispatch bar.
function listRowCounts(s) {
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
  let etaMs = null;
  if (s.started_at && done > 0 && t > done) {
    const elapsed = Date.now() - s.started_at;
    if (elapsed > 0) {
      etaMs = ((t - done) * elapsed) / done;
    }
  }
  return { total: t, accepted: done, confirmed, pct, etaMs };
}

// A `/sends` list row's "Delivered" cell, from its denormalized counters (#90). It reports
// TRUE delivered — webhook-confirmed `c_delivered`, not provider-`accepted` — so the Sent
// list and dashboard recent-sends agree with the record view's "Delivered" for the same
// send, and a bounced/complained recipient is never miscounted as delivered. Any bounce /
// complaint / unsent shows as a muted delivery-failure note, so a bad send reads
// as one at a glance instead of a clean number. The note sits on its own line beneath
// the count (`.delivered-note`), not inline: the Sent table's columns are fixed-width,
// and a three-bucket note inline would wrap the numeric column four lines deep. The
// kinds read worst first (complained, bounced, unsent), as plain muted text — no
// swatches; the record view's tiles carry the colors. A clean send prints nothing
// (never "0 bounced"). `deliveries` stays the source of truth.
export function deliveredCell(s) {
  const delivered = s.c_delivered || 0;
  const kinds = [];
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
    ? `<span class="muted delivered-note">${kinds
        .map((text) => `<span class="delivered-kind">${text}</span>`)
        .join(", ")}</span>`
    : "";
  return `<span class="n">${delivered.toLocaleString()}</span>${note}`;
}
// One in-progress send as a card with a live mini dispatch bar, an ETA, and a Watch link.
// The whole card opens the watch; the "Watch" link is the keyboard/middle-click target.
export function activeRowHtml(s) {
  const c = listRowCounts(s);
  const eta = c.etaMs != null ? ` · ~${fmtDuration(c.etaMs)} left` : "";
  return `<div class="card spread clickable active-card" data-watch="${s.id}">
      <div class="active-main">
        <a class="card-link active-subj" href="#/sent/${s.id}">${esc(s.subject) || "<em>untitled</em>"}</a>
        <div class="active-bar"><div class="active-fill" style="width:${clampPct(c.pct)}%"></div></div>
        <div class="muted active-stat">Sending — ${c.accepted.toLocaleString()} of ${c.total.toLocaleString()} accepted${
          c.confirmed ? ` · ${c.confirmed.toLocaleString()} confirmed` : ""
        }${eta}</div>
      </div>
      <a class="ghost-link" href="#/sent/${s.id}">Watch&nbsp;→</a>
    </div>`;
}

export async function renderSent() {
  // The dispatch side (#147): the still-cancelable Scheduled queue on top, then the
  // frozen Sent records. The table is sent-only, so it carries no status column or
  // filter; default sort = fire desc so the "When" header shows its arrow from the start.
  const state = {
    status: "sent",
    search: "",
    failures: "",
    sort: "fire",
    dir: "desc",
    offset: 0,
    limit: 50,
  };
  app.innerHTML = `<h1>Sent</h1>
    ${noEmailProvider() ? `<p class="muted">No email provider is configured, so these sends are recorded here but nothing is delivered.</p>` : ""}
    <div id="stuck"></div>
    <h2>Scheduled</h2><div id="scheduled" class="muted">Loading…</div>
    <div id="active"></div>
    <h2>Sent posts</h2>
    ${listToolbar({ searchPlaceholder: "Search subject…", failures: true })}
    <div id="sendsList" class="muted">Loading…</div>
    <div id="sendsPager"></div>`;
  const stuckEl = document.getElementById("stuck");
  const schedEl = document.getElementById("scheduled");
  const activeEl = document.getElementById("active");
  const listEl = document.getElementById("sendsList");
  const pagerEl = document.getElementById("sendsPager");

  // Resolving a wedged send or canceling a scheduled one touches several sections at
  // once, so refresh them together.
  function reloadAll() {
    loadScheduled();
    loadList();
    refreshSending();
  }

  // The in-flight set drives two sections — the wedged attention block (§12) and the
  // in-progress active rows (#154) — so one fetch renders both. Tracking the set's
  // signature lets us tell a real transition (a send fired or finished) from a mere bar
  // advance: on a transition we also refresh the scheduled queue (it lost this send) and
  // the sent list (it gained it), so a fired post leaves the scheduled slot and lands in
  // the records without a manual reload. Polled every 3s (matching the watch + dashboard).
  let sentActiveSig = "";
  function renderActive(sends) {
    const active = sends.filter((s) => !isWedged(s));
    activeEl.innerHTML = active.length
      ? `<h2>In progress</h2>${active.map(activeRowHtml).join("")}`
      : "";
    activeEl.querySelectorAll("[data-watch]").forEach((card) => {
      card.onclick = (e) => {
        if (e.target.tagName !== "A") {
          location.hash = `#/sent/${card.dataset.watch}`;
        }
      };
    });
  }
  function renderStuck(sends) {
    const wedged = sends.filter(isWedged);
    stuckEl.innerHTML = wedged
      .map((s) => {
        const n = s.c_in_flight || 0;
        const noun = n === 1 ? "delivery" : "deliveries";
        return `<div class="card stuck-card"><div class="stuck-head"><span class="stuck-dot">⚠️</span><div><strong>${esc(s.subject)}</strong><div class="muted">${n} ambiguous ${noun} — this send can't finish until you resolve ${n === 1 ? "it" : "them"}.</div></div></div><button class="primary" data-resolve="${s.id}">Resolve…</button></div>`;
      })
      .join("");
    stuckEl.querySelectorAll("[data-resolve]").forEach((b) => {
      const s = wedged.find((x) => x.id === b.dataset.resolve);
      b.onclick = () => openResolveModal(s, reloadAll);
    });
  }
  async function refreshSending() {
    let sends;
    try {
      ({ sends } = await api("/sends?status=sending&limit=200"));
    } catch {
      // Non-fatal: the in-flight sections just stay empty if this probe fails.
      stuckEl.innerHTML = "";
      activeEl.innerHTML = "";
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

  // The upcoming queue, soonest-first — the next send to fire (and the one you'd reach
  // for the cancel window on) sits at the top. Fetched on its own so it shows every
  // scheduled send regardless of the table's paging/filter below.
  async function loadScheduled() {
    try {
      const { sends } = await api("/sends?status=scheduled&sort=fire&dir=asc&limit=200");
      const schedCard = (s) =>
        `<div class="card spread clickable sched-card" data-post="${s.post_id}"><div><a class="card-link sched-subj" href="#/edit/${s.post_id}">${esc(s.subject)}</a><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div><div class="row"><button class="ghost" data-reschedule="${s.id}">Reschedule</button><button class="ghost" data-cancel="${s.id}">Cancel</button></div></div>`;
      if (!sends.length) {
        schedEl.innerHTML = `<p class="muted">Nothing scheduled.</p>`;
      } else {
        // Show only the soonest to send, so the sent records stay near the top of the
        // page; any others collapse behind a "Show all" toggle (usually there are none —
        // a post has at most one active send).
        const [first, ...rest] = sends;
        schedEl.innerHTML =
          schedCard(first) +
          (rest.length
            ? `<div id="schedMore" hidden>${rest.map(schedCard).join("")}</div><button type="button" class="ghost sched-toggle" id="schedToggle" aria-expanded="false">Show all ${sends.length} scheduled</button>`
            : "");
        const toggle = schedEl.querySelector("#schedToggle");
        if (toggle) {
          toggle.onclick = () => {
            const more = schedEl.querySelector("#schedMore");
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
      schedEl.querySelectorAll(".card.clickable").forEach((card) => {
        card.onclick = (e) => {
          if (e.target.tagName !== "A" && !e.target.closest("button")) {
            location.hash = `#/edit/${card.dataset.post}`;
          }
        };
      });
      schedEl.querySelectorAll("[data-reschedule]").forEach((b) => {
        const s = sends.find((x) => x.id === b.dataset.reschedule);
        b.onclick = () => openRescheduleModal(s.id, s.fire_at, reloadAll);
      });
      schedEl.querySelectorAll("[data-cancel]").forEach((b) => {
        b.onclick = () =>
          busy(b, "Canceling…", async () => {
            try {
              await api(`/sends/${b.dataset.cancel}/cancel`, { method: "POST" });
              toast("Canceled");
              // A cancel drops it from the queue and flips it to canceled in the table.
              reloadAll();
            } catch (e) {
              toast(e.message);
            }
          });
      });
      startCountdowns();
    } catch (e) {
      renderError(schedEl, e.message, loadScheduled);
    }
  }

  // The frozen Sent records — every completed post, each opening its read-only record
  // view (#148). Sent-only, so no status column; the "When" is the send's completion.
  async function loadList() {
    try {
      const data = await api(`/sends?${listQuery(state)}`);
      const sends = data.sends;
      if (!sends.length) {
        listEl.innerHTML = `<p class="muted">${
          state.search
            ? "No sent posts match."
            : state.failures
              ? "Every sent post delivered cleanly."
              : "No sent posts yet."
        }</p>`;
        pagerEl.innerHTML = "";
        return;
      }
      // Cells are named (subject / recipients / delivered) and the count is wrapped in
      // `.n` so the ≤720px layout can stack a row and label its numbers from CSS alone.
      listEl.innerHTML = `<div class="table-wrap"><table class="list-table sent-table stacks"><colgroup><col><col class="c-date"><col class="c-num"><col class="c-delivered"></colgroup><thead><tr>${th("Subject", "subject", state)}${th("When", "fire", state)}${th("Recipients", "recipients", state, "num")}<th class="num">Delivered</th></tr></thead><tbody>${sends
        .map(
          (s) =>
            `<tr class="clickable" data-id="${s.id}"><td class="subject"><a href="#/sent/${s.id}">${esc(s.subject)}</a></td><td class="muted">${fmt(s.completed_at ?? s.fire_at)}</td><td class="num recipients"><span class="n">${s.recipient_count.toLocaleString()}</span></td><td class="num delivered">${deliveredCell(s)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
      wireSort(listEl, state, loadList);
      // The whole row opens the record; the subject link handles keyboard/middle-click.
      listEl.querySelectorAll("tr[data-id]").forEach((tr) => {
        tr.onclick = (e) => {
          if (e.target.tagName !== "A") {
            location.hash = `#/sent/${tr.dataset.id}`;
          }
        };
      });
      renderPager(pagerEl, state, data.page, loadList);
    } catch (e) {
      renderError(listEl, e.message, loadList);
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
      // Navigated off the Sent page mid-fetch — the sections refreshSending paints are gone and
      // the reschedule would leak onto the new view's poll timer. Bail (see navGeneration).
      if (gen !== appState.navGeneration) {
        return;
      }
      scheduleSentPoll();
    }, 3000);
  };
  scheduleSentPoll();
}
