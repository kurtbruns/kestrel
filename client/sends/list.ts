// The sent list: scheduled sends with their countdowns, the active send, and the record
// of what has gone out.

import type { SendListResponse, SendSummary } from "../../shared/sends";
import { api } from "../api";
import { noEmailProvider } from "../deployment";
import { poll } from "../lifecycle";
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
import { busy, renderError, toast } from "../ui/widgets";
import { openRescheduleModal, openResolveModal } from "./dialogs";
import { activeRowHtml, countdowns, deliveredCell, isWedged } from "./progress";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function renderSent(root: HTMLElement, signal: AbortSignal): Promise<void> {
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
    root,
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
  const stuckEl = $("#stuck", root);
  const schedEl = $("#scheduled", root);
  const activeEl = $("#active", root);
  const listEl = $("#sendsList", root);
  const pagerEl = $("#sendsPager", root);
  const tickCountdowns = countdowns(root, signal);

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
      ({ sends } = await api<SendListResponse>("/sends?status=sending&limit=200", { signal }));
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
        { signal },
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
      tickCountdowns();
    } catch (e) {
      renderError(schedEl, message(e), loadScheduled);
    }
  }

  // The frozen Sent records: every completed post, each opening its read-only record
  // view. Sent-only, so no status column; the "When" is the send's completion.
  async function loadList() {
    try {
      const data = await api<SendListResponse>(`/sends?${listQuery(state)}`, { signal });
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

  wireToolbar(root, state, loadList);
  reloadAll();
  // Poll the in-flight sections every 3s (matching the watch + dashboard): the active
  // bar advances, and a fired/finished send moves through the queue → in-progress →
  // records on its own. Ends with the mount.
  poll(3000, refreshSending, signal);
}
