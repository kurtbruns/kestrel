// The sent list: scheduled sends with their countdowns, the sends in progress and any that
// need the operator, and the record of what has gone out, kept current by the send-state
// layer (docs/DESIGN.md §9).

import { earlierCursor } from "../../shared/cursor";
import type { LiveSend, SendListItem, SendListResponse } from "../../shared/sends";
import { api } from "../api";
import { noEmailProvider } from "../deployment";
import {
  followSends,
  readSendsNow,
  type SendStage,
  type SendsUpdate,
  stageOf,
} from "../send_state";
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
import {
  activeRowHtml,
  countdownHtml,
  countdowns,
  deliveredCell,
  needsOperator,
  providerWords,
  refusalAdvice,
  rowCounts,
  type SendView,
  sendsNow,
} from "./progress";

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

  // The sends in flight as the page last read them, and every send the layer has reported
  // since, as it now stands: together, what the attention and in-progress sections show.
  let sendingRows: SendListItem[] = [];
  // Until a read of the sends in flight succeeds, the In progress slot keeps its error and
  // Retry: the layer reports only sends that change, so one refused for an hour would
  // otherwise never show.
  let liveRead = false;
  // Each section paints only its latest read, so a slow earlier one (a queue read for a
  // send turning due, landing after the one for its start) never paints over a newer one.
  let scheduledReads = 0;
  let listReads = 0;
  const reported = new Map<string, LiveSend>();

  // Resolving a wedged send or canceling a scheduled one touches several sections at once:
  // re-read the two this page reads itself, and have the layer read now, so the attention
  // and in-progress sections catch up with the act rather than at the next read.
  function afterAct() {
    loadScheduled();
    loadList();
    readSendsNow();
  }

  // The sends in progress: a card each, with a live bar, for every send still sending that
  // doesn't need the operator (that one's home is the attention block above).
  function renderActive(live: SendView[]) {
    const active = live.filter((s) => s.state === "sending" && !needsOperator(s));
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
  // The sends that need the operator (SPEC §12), each an attention card that stays until
  // its condition clears: repainted from every report of the layer.
  function renderStuck(live: SendView[]) {
    const wedged = live.filter((s) => s.attention.wedged);
    // A refused send carries no control: the fix is in the provider's account or the
    // deployment's secrets, and the send resumes on its own once it lands.
    const refused = live.filter((s) => s.attention.refused);
    setHtml(
      stuckEl,
      html`${refused.map(
        (s) =>
          html`<div class="card stuck-card"><div class="stuck-head"><span class="stuck-dot">⚠️</span><div><strong><a href="#/sent/${s.id}">${s.subject}</a></strong><div class="muted">The provider is refusing this account, so the send is paused where it is: ${providerWords(s.provider.halt?.error)} ${refusalAdvice(s.provider.halt?.cause ?? null)} No one has been marked unsent; it resumes on its own once the account is fixed.</div></div></div></div>`,
      )}${wedged.map((s) => {
        const n = s.attention.wedged_count;
        const noun = n === 1 ? "delivery" : "deliveries";
        return html`<div class="card stuck-card"><div class="stuck-head"><span class="stuck-dot">⚠️</span><div><strong><a href="#/sent/${s.id}">${s.subject}</a></strong><div class="muted">${n} ambiguous ${noun} — this send can't finish until you resolve ${n === 1 ? "it" : "them"}.</div></div></div><button class="primary" data-resolve="${s.id}">Resolve…</button></div>`;
      })}`,
    );
    for (const b of $$<HTMLButtonElement>("[data-resolve]", stuckEl)) {
      const s = wedged.find((x) => x.id === b.dataset.resolve);
      if (s) {
        b.onclick = () => openResolveModal({ id: s.id, c_in_flight: s.counts.in_flight }, afterAct);
      }
    }
  }
  // A listed send's Delivered cell follows the layer's counts, so the table moves with its
  // receipts (a late one included) without being read again.
  function patchDelivered() {
    for (const s of reported.values()) {
      const cell = $$<HTMLTableRowElement>("tr[data-id]", listEl)
        .find((tr) => tr.dataset.id === s.id)
        ?.querySelector("td.delivered");
      if (cell) {
        setHtml(cell, deliveredCell(s.counts));
      }
    }
  }
  function paintLive() {
    const live = sendsNow(sendingRows, reported);
    renderStuck(live);
    if (liveRead) {
      renderActive(live);
    }
    patchDelivered();
  }
  // Each report moves sends between this page's sections, whoever changed them. Any change
  // to a send in (or leaving) the queue re-reads it: a cancel, a move, a re-make, or a new
  // schedule by the other client, the fire time passing, a miss, a start. A send reaching
  // the sent side re-reads the records; one that went due to sent between two reads is one
  // change, and still lands there. Everything else is a report's own numbers.
  const inQueue = (st: SendStage | null) => st === "scheduled" || st === "due";
  const sentSide = (st: SendStage | null) => st === "sent" || st === "complete";
  function onUpdate(u: SendsUpdate) {
    for (const s of u.sends) {
      reported.set(s.id, s);
    }
    paintLive();
    if (u.sends.some((s) => inQueue(stageOf(s))) || u.changes.some((c) => inQueue(c.from))) {
      loadScheduled();
    }
    if (u.changes.some((c) => sentSide(c.to) && !sentSide(c.from))) {
      loadList();
    }
  }

  // The layer follows every send from where the page's own reads stood, the earliest of
  // them, so nothing that changed after any of those reads is missed. A section whose first
  // read failed starts it from its Retry instead.
  let following = false;
  function follow(reads: (SendListResponse | null)[]) {
    const ok = reads.filter((r): r is SendListResponse => r !== null);
    if (following || !ok.length) {
      return;
    }
    following = true;
    followSends(
      {
        cursor: ok.map((r) => r.cursor).reduce(earlierCursor),
        sends: ok.flatMap((r) => r.sends),
      },
      onUpdate,
      signal,
    );
  }

  // The sends in flight, for the attention and in-progress sections; from then on the
  // layer's reports keep them current.
  async function loadLive(): Promise<SendListResponse | null> {
    try {
      const res = await api<SendListResponse>("/sends?status=sending&limit=200", { signal });
      sendingRows = res.sends;
      liveRead = true;
      paintLive();
      return res;
    } catch (e) {
      renderError(activeEl, message(e), async () => follow([await loadLive()]));
      return null;
    }
  }

  // The upcoming queue, soonest-first: the next send to fire (and the one you'd reach
  // for the cancel window on) sits at the top. Fetched on its own so it shows every
  // scheduled send regardless of the table's paging/filter below.
  async function loadScheduled(): Promise<SendListResponse | null> {
    const mine = ++scheduledReads;
    try {
      const res = await api<SendListResponse>(
        "/sends?status=scheduled&sort=fire&dir=asc&limit=200",
        { signal },
      );
      if (mine !== scheduledReads) {
        return res; // a later read paints
      }
      const { sends } = res;
      const schedCard = (s: SendListItem) =>
        html`<div class="card spread clickable sched-card" data-post="${s.post_id}"><div><a class="card-link sched-subj" href="#/edit/${s.post_id}">${s.subject}</a><div class="muted">${countdownHtml(s)} · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div><div class="row"><button class="ghost" data-reschedule="${s.id}">Reschedule</button><button class="ghost" data-cancel="${s.id}">Cancel</button></div></div>`;
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
          b.onclick = () => openRescheduleModal(s.id, s.fire_at, afterAct);
        }
      }
      for (const b of $$<HTMLButtonElement>("[data-cancel]", schedEl)) {
        b.onclick = () =>
          busy(b, "Canceling…", async () => {
            try {
              await api(`/sends/${b.dataset.cancel}/cancel`, { method: "POST" });
              toast("Canceled");
              // A cancel drops it from the queue, and a due send from the layer's reads.
              afterAct();
            } catch (e) {
              toast(message(e));
            }
          });
      }
      tickCountdowns();
      return res;
    } catch (e) {
      if (mine === scheduledReads) {
        renderError(schedEl, message(e), async () => follow([await loadScheduled()]));
      }
      return null;
    }
  }

  // The frozen Sent records: every completed post, each opening its read-only record
  // view. Sent-only, so no status column; the "When" is the send's completion.
  async function loadList(): Promise<SendListResponse | null> {
    const mine = ++listReads;
    try {
      const data = await api<SendListResponse>(`/sends?${listQuery(state)}`, { signal });
      if (mine !== listReads) {
        return data; // a later read paints
      }
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
        return data;
      }
      // Cells are named (subject / recipients / delivered) and the count is wrapped in
      // `.n` so the ≤720px layout can stack a row and label its numbers from CSS alone.
      setHtml(
        listEl,
        html`<div class="table-wrap"><table class="list-table sent-table stacks"><colgroup><col><col class="c-date"><col class="c-num"><col class="c-delivered"></colgroup><thead><tr>${th("Subject", "subject", state)}${th("When", "fire", state)}${th("Recipients", "recipients", state, "num")}<th class="num">Delivered</th></tr></thead><tbody>${sends.map(
          (s) =>
            html`<tr class="clickable" data-id="${s.id}"><td class="subject"><a href="#/sent/${s.id}">${s.subject}</a></td><td class="muted">${fmt(s.completed_at ?? s.fire_at)}</td><td class="num recipients"><span class="n">${s.recipient_count.toLocaleString()}</span></td><td class="num delivered">${deliveredCell(rowCounts(s))}</td></tr>`,
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
      patchDelivered();
      return data;
    } catch (e) {
      if (mine === listReads) {
        renderError(listEl, message(e), async () => follow([await loadList()]));
      }
      return null;
    }
  }

  wireToolbar(root, state, loadList);
  // The queue, the sends in flight, and the records are this page's own reads; from them
  // the layer follows every send for the life of the mount, so a send moves through the
  // queue, in progress, and the records on its own.
  follow(await Promise.all([loadScheduled(), loadLive(), loadList()]));
}
