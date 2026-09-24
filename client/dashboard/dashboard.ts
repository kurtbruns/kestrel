// The dashboard (home): counts, the active send widget, drafts and sent tables, the
// setup checklist, and quick actions.

import type { PostListItem, PostListResponse } from "../../shared/posts";
import type { SendListResponse, SendView } from "../../shared/sends";
import type { DeploymentView } from "../../shared/settings";
import type { SubscriberCounts, SubscriberListResponse } from "../../shared/subscribers";
import { api } from "../api";
import { derivePublication, type Publication } from "../brand";
import { mount } from "../lifecycle";
import { createNewPost } from "../posts/drafts";
import { followSends, type SendStage, type SendsUpdate, stageOf } from "../send_state";
import {
  activeRowHtml,
  conditionOf,
  countdownHtml,
  countdowns,
  deliveredCell,
  has,
  needsOperator,
  sendsNow,
} from "../sends/progress";
import { appliedNoticeHtml } from "../settings/remake";
import { appState } from "../state";
import { addSubscriberModal } from "../subscribers/dialogs";
import { $, $$ } from "../ui/dom";
import { fmt } from "../ui/format";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { notice } from "../ui/notice";
import { badge, copyText, renderError } from "../ui/widgets";

// The post-login landing and the brand's target (the default route). Built entirely
// from existing authed endpoints — GET /posts, /sends, /subscribers, and the cached
// /api/settings — so it adds no surface and can't touch an invariant. It answers
// SPEC §8's questions at a glance: is anything wrong, who's on the list, what's
// scheduled, what went out, and what's still in progress.

/** One line of the health block: red needs a decision, amber a look. */
interface HealthAlert {
  level: "red" | "amber";
  text: string | Html;
}

// Health (SPEC §8 "is anything wrong", §12 loud failure): calm in the common case, loud
// only when something needs attention. Every line is a condition the server reports on a
// send as it stands (the page's rows, overlaid by the layer's reports), so a line appears
// within a read of its condition and stays until the condition clears, and the dashboard
// keeps no rule of its own: the bounce spike included, which the server reads off each
// recently sent send. Only the loud kinds are lines here; a re-made send's note and a
// provider outage short of the stuck threshold are shown where the send is.
function computeHealth(live: SendView[]): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  // Missed only past the server's tolerance: an ordinary slow tick is never a miss (§12).
  const missed = live.filter((s) => has(s, "missed"));
  if (missed.length) {
    alerts.push({
      level: "red",
      text: `${missed.length} scheduled send${missed.length === 1 ? "" : "s"} passed the fire time without going out.`,
    });
  }
  // A send wedged on ambiguous in-flight rows needs a decision, not just patience: red,
  // linking to where Resolve is (its page; the Sent page for several), and kept out of the
  // in-progress lines below so it isn't reported twice (SPEC §12).
  const wedged = live.flatMap((s) => {
    const c = conditionOf(s, "wedged");
    return c ? [{ s, count: c.count }] : [];
  });
  const [firstWedged] = wedged;
  if (firstWedged) {
    const n = wedged.reduce((sum, w) => sum + w.count, 0);
    const noun = n === 1 ? "delivery" : "deliveries";
    alerts.push({
      level: "red",
      text:
        wedged.length === 1
          ? html`<a href="#/sent/${firstWedged.s.id}">${firstWedged.s.subject}</a> has ${n} ambiguous ${noun} awaiting a decision; resolve ${n === 1 ? "it" : "them"} on its page.`
          : html`${n} ambiguous ${noun} across <a href="#/sent">${wedged.length} sends</a> await a decision; resolve them on the Sent page.`,
    });
  }
  // The provider refusing the account stops every send it touches until the operator
  // fixes the account (SPEC §12): one red line, in the server's words for it.
  const refused = live.flatMap((s) => {
    const c = conditionOf(s, "refused");
    return c ? [{ s, c }] : [];
  });
  const [firstRefused] = refused;
  if (firstRefused) {
    // One send links to its watch; several, to the Sent page that lists them all.
    const which =
      refused.length === 1
        ? html`<a href="#/sent/${firstRefused.s.id}">${firstRefused.s.subject}</a>`
        : html`<a href="#/sent">${refused.length} sends</a>`;
    alerts.push({ level: "red", text: html`${which}: ${firstRefused.c.message}` });
  }
  // A healthy in-progress send is NOT surfaced here: the active-send widget below is its
  // home (a bar and a Watch link). The health line is loud-only, so it keeps just the
  // *stuck* case: a send the server reports in flight too long.
  const stuck = live.filter((s) => has(s, "stuck") && !needsOperator(s));
  const [firstStuck] = stuck;
  if (firstStuck) {
    alerts.push({
      level: "amber",
      text:
        stuck.length === 1
          ? html`<a href="#/sent/${firstStuck.id}">${firstStuck.subject}</a>: ${conditionOf(firstStuck, "stuck")?.message}`
          : html`<a href="#/sent">${stuck.length} sends</a> have been sending longer than they should; they may be retrying.`,
    });
  }
  // Bounce spike (SPEC §8): the server's reading of a recent send's confirmed bounces over
  // its audience at fire. Read-only reporting: it never throttles or halts a send.
  const spiky = live.flatMap((s) => {
    const c = conditionOf(s, "bounce_spike");
    return c ? [{ s, c }] : [];
  });
  const [firstSpike] = spiky;
  if (firstSpike) {
    alerts.push({
      level: "amber",
      text: html`<a href="#/sent/${firstSpike.s.id}">${firstSpike.s.subject}</a>: ${firstSpike.c.message}`,
    });
  }
  return alerts;
}

/** The health block: nothing at all when nothing needs attention. */
function healthHtml(alerts: HealthAlert[]): Html {
  if (!alerts.length) {
    return html``;
  }
  const level = alerts.some((i) => i.level === "red") ? "red" : "amber";
  return html`<div class="health ${level}"><span class="health-dot">⚠️</span><div>${alerts.map(
    (i) => html`<div>${i.text}</div>`,
  )}</div></div>`;
}

/** The sends the active-send widget shows: in flight, and not needing the operator (that
 *  one's home is its red line). */
const activeOf = (live: SendView[]) =>
  live.filter((s) => s.status === "sending" && !needsOperator(s));

/** A subscriber-count tile; each deep-links into the roster on its own filter. */
interface Tile {
  label: string;
  emph?: boolean;
  v: number;
  filter: string;
  sub?: string;
}

export async function renderDashboard(view: HTMLElement, signal: AbortSignal): Promise<void> {
  const remount = () => {
    if (!signal.aborted) {
      mount(renderDashboard); // never over wherever the reader went since
    }
  };
  setHtml(view, html`<div class="dash" id="dash"><p class="muted">Loading…</p></div>`);
  const root = $("#dash", view);
  let posts: PostListItem[];
  let first: SendListResponse;
  let counts: SubscriberCounts;
  try {
    // The health line scans every send and the archive-link slug map needs every post,
    // so ask for a full window rather than the list default (50). Subscribers is only
    // read for its (filter-independent) counts, so its row limit doesn't matter.
    const [p, s, subs] = await Promise.all([
      api<PostListResponse>("/posts?limit=200", { signal }),
      api<SendListResponse>("/sends?limit=200", { signal }),
      api<SubscriberListResponse>("/subscribers", { signal }),
    ]);
    posts = p.posts;
    first = s;
    counts = subs.counts;
  } catch (e) {
    renderError(root, e instanceof Error ? e.message : String(e), remount);
    return;
  }
  let sends = first.sends;
  // Every send the layer has reported since the page's read, as it now stands.
  const reported = new Map<string, SendView>();
  const pub = derivePublication(appState.appConfig);
  const deployment = appState.appConfig?.deployment ?? null;
  const totalSubs = counts.confirmed + counts.pending + counts.unsubscribed + counts.suppressed;

  // First run — nothing written and no one on the list: replace the body with the
  // onboarding checklist (the shared Getting-started component) rather than a wall
  // of empty tiles.
  if (!posts.length && totalSubs === 0) {
    setHtml(
      root,
      html`<div class="dash-head"><div><h1>${pub.name}</h1>${
        pub.tagline ? html`<p class="muted dash-tagline">${pub.tagline}</p>` : null
      }<p class="muted">Let's get your first post out the door.</p></div></div>${setupChecklistHtml(pub, deployment)}<section class="dash-section"><h2>API access</h2>${apiConnectCard(false)}</section>`,
    );
    wireDashActions(root, remount);
    return;
  }

  // Each tile deep-links into the roster pre-filtered on its criterion
  // (#/subscribers/<filter>), so a count is a way in, not just a number. Confirmed is
  // the figure read first, so it is who the next send reaches: a suppressed address
  // stays `confirmed` in consent but is never mailed, and already has its own tile.
  const tiles: Tile[] = [
    {
      label: "Confirmed",
      emph: true,
      v: counts.audience,
      filter: "audience",
    },
    { label: "Pending", v: counts.pending, filter: "pending" },
    { label: "Unsubscribed", v: counts.unsubscribed, filter: "unsubscribed" },
    { label: "Suppressed", v: counts.suppressed, filter: "suppressed" },
  ];
  const tilesHtml = html`<div class="tiles">${tiles.map(
    (t) =>
      html`<a class="tile${t.emph ? " tile-emph" : ""}" href="#/subscribers/${t.filter}"><span class="tile-n">${t.v}</span><span class="tile-label">${t.label}${
        t.sub ? html`<span class="tile-sub">${t.sub}</span>` : null
      }</span></a>`,
  )}</div>`;

  const drafts = posts.filter((p) => p.status === "draft").slice(0, 5);
  const draftsHtml = drafts.length
    ? html`<div class="table-wrap"><table><tbody>${drafts.map(
        (p) =>
          html`<tr class="clickable" data-id="${p.id}"><td><a href="#/edit/${p.id}">${p.subject || html`<em>untitled</em>`}</a></td><td class="muted">edited ${fmt(p.updated_at)}</td></tr>`,
      )}</tbody></table></div>`
    : html`<p class="muted">No drafts in progress.</p>`;

  const appOrigin = deployment?.appOrigin || location.origin;
  const archiveBase =
    (deployment?.archiveOrigin || location.origin) + (deployment?.archiveBasePath || "");
  const pubCardHtml = html`<div class="card pub-card">
    <div class="pub-row"><span class="pub-key muted">Publication</span><code class="pub-val">${appOrigin}</code><button class="ghost" data-copy="${appOrigin}">Copy</button></div>
    <div class="pub-row"><span class="pub-key muted">Archive</span><code class="pub-val">${archiveBase}</code><button class="ghost" data-copy="${archiveBase}">Copy</button></div>
    <div class="pub-foot"><a href="/" target="_blank" rel="noopener">View publication&nbsp;↗</a></div>
  </div>`;

  // Has Claude (the `service` principal) edited here? Authorship on any current revision
  // flips the API-access card to "connected" (SPEC §4). Uses the author already on each
  // list row, so no extra fetch; a post a human later re-edited no longer counts.
  const claudeConnected = posts.some((p) => p.author === "service");
  const apiCardHtml = apiConnectCard(claudeConnected);

  // The notice slot (#dashNotices, DESIGN §2 home ⑥) sits above the Scheduled section: a
  // problem (the health block) outranks news, and the notices that exist are about
  // scheduled sends, so the eye lands on the queue right after reading one.
  const quickHtml = html`<div class="row quick-actions"><button class="primary" data-act="new-post">New post</button><button data-act="add-sub">Add subscriber</button><button data-nav="#/settings">Edit publication</button></div>`;

  // No news is good news: the health block appears only when something needs attention
  // (SPEC §8 / §12, the only thing that ever surfaces loudly). The active-send widget sits
  // with it, a glanceable entry into the watch while a send is in flight.
  setHtml(
    root,
    html`
    <div class="dash-head">
      <div><h1>${pub.name}</h1>${pub.tagline ? html`<p class="muted dash-tagline">${pub.tagline}</p>` : null}</div>
      <button class="primary" data-act="new-post">New post</button>
    </div>
    <div id="dashHealth">${healthHtml(computeHealth(sendsNow(sends, reported)))}</div>
    <div id="dashActive">${dashActiveHtml(activeOf(sendsNow(sends, reported)))}</div>
    <section class="dash-section"><h2>Subscribers</h2>${tilesHtml}</section>
    <div id="dashNotices"></div>
    <div class="dash-cols">
      <section class="dash-section"><h2>Scheduled</h2><div id="dashScheduled">${dashScheduledHtml(scheduledOf(sends))}</div></section>
      <section class="dash-section"><h2>Drafts</h2>${draftsHtml}</section>
    </div>
    <section class="dash-section"><h2>Sent</h2><div id="dashSent">${dashSentHtml(sends)}</div></section>
    <section class="dash-section"><h2>Quick actions</h2>${quickHtml}</section>
    <div class="dash-cols">
      <section class="dash-section"><h2>Publication</h2>${pubCardHtml}</section>
      <section class="dash-section"><h2>API access</h2>${apiCardHtml}</section>
    </div>`,
  );

  wireDashActions(root, remount);
  // Row / card clicks open the post (subject links + Cancel opt out — the same guard
  // the Posts table and the Sends cards use).
  for (const tr of $$<HTMLTableRowElement>("tr[data-id]", root)) {
    tr.onclick = (e) => {
      const t = e.target;
      if (t instanceof Element && t.tagName !== "A" && !t.closest("button")) {
        location.hash = `#/edit/${tr.dataset.id}`;
      }
    };
  }
  wireDashSentRows(root);
  wireDashActiveCards(root);
  wireDashScheduledCards(root);
  paintAppliedNotice(root, scheduledOf(sends));
  const tickCountdowns = countdowns(root, signal);
  tickCountdowns();

  // From here the send-state layer keeps the send sections current (docs/DESIGN.md §9),
  // following every send from where the page's own read stood. Each report repaints what it
  // carries directly (the health block, the active-send widget, a listed send's Delivered).
  // A stage change, or any change to a scheduled or due send (a cancel, a move, a re-make,
  // a new schedule, the fire time passing, a miss), reads the sends again for the queue,
  // the notice, and the Sent table, whoever made it: a send that went due to sent between
  // two reads lands straight in the Sent table, and the other client's move shows within
  // one idle read.
  let reading = 0;
  const readSends = async () => {
    const mine = ++reading;
    try {
      const fresh = await api<SendListResponse>("/sends?limit=200", { signal });
      if (mine !== reading) {
        return; // a later change's read is the one to paint
      }
      sends = fresh.sends;
      setHtml($("#dashScheduled", root), dashScheduledHtml(scheduledOf(sends)));
      wireDashScheduledCards(root);
      paintAppliedNotice(root, scheduledOf(sends));
      tickCountdowns(); // the fresh cards are empty until the next tick
      setHtml($("#dashSent", root), dashSentHtml(sends));
      wireDashSentRows(root);
      paintLive();
    } catch {
      /* a background read: the sections keep their last render until the next change */
    }
  };
  const paintLive = () => {
    const now = sendsNow(sends, reported);
    setHtml($("#dashHealth", root), healthHtml(computeHealth(now)));
    setHtml($("#dashActive", root), dashActiveHtml(activeOf(now)));
    wireDashActiveCards(root);
    patchDelivered(root, [...reported.values()]);
  };
  const inQueue = (st: SendStage | null) => st === "scheduled" || st === "due";
  followSends(
    first,
    {
      update: (u: SendsUpdate) => {
        for (const s of u.sends) {
          reported.set(s.id, s);
        }
        for (const id of u.removed) {
          reported.delete(id);
        }
        paintLive();
        if (u.changes.length || u.removed.length || u.sends.some((s) => inQueue(stageOf(s)))) {
          readSends();
        }
      },
      // The database is behind the page's read (a reset or a restore): read it all again.
      stale: remount,
    },
    signal,
  );
}

/** The scheduled sends, soonest first. */
const scheduledOf = (sends: SendView[]) =>
  sends.filter((s) => s.status === "scheduled").sort((a, b) => a.fire_at - b.fire_at);

/** The dashboard's Sent table: the latest five sends that have started, each opening its
 *  page (the watch while it sends, the record once sent). */
function dashSentHtml(sends: SendView[]): Html {
  const recent = sends.filter((s) => s.status === "sent" || s.status === "sending").slice(0, 5);
  if (!recent.length) {
    return html`<p class="muted">No sends yet.</p>`;
  }
  return html`<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th><th></th></tr></thead><tbody>${recent.map(
    (s) => {
      // The published post, which the send's view links once it is sent.
      const url = s.links.archive;
      return html`<tr class="clickable" data-send="${s.id}"><td><a href="#/sent/${s.id}">${s.subject}</a></td><td>${badge(s.status)}</td><td class="num">${s.audience.count.toLocaleString()}</td><td class="num delivered">${deliveredCell(s.counts)}</td><td class="act">${
        url
          ? html`<a class="ghost-link" href="${url}" target="_blank" rel="noopener">Archive&nbsp;↗</a>`
          : null
      }</td></tr>`;
    },
  )}</tbody></table></div>`;
}
// Sent-table rows carry a SEND id (not a post id) and open the send's page.
function wireDashSentRows(root: HTMLElement): void {
  for (const tr of $$<HTMLTableRowElement>("tr[data-send]", root)) {
    tr.onclick = (e) => {
      const t = e.target;
      if (t instanceof Element && t.tagName !== "A") {
        location.hash = `#/sent/${tr.dataset.send}`;
      }
    };
  }
}
/** A listed send still sending or settling: its Delivered cell follows the layer's counts,
 *  so the table moves with its receipts without being read again. */
function patchDelivered(root: HTMLElement, sends: SendView[]): void {
  for (const s of sends) {
    const cell = $$<HTMLTableRowElement>("#dashSent tr[data-send]", root)
      .find((tr) => tr.dataset.send === s.id)
      ?.querySelector("td.delivered");
    if (cell) {
      setHtml(cell, deliveredCell(s.counts));
    }
  }
}

// The dashboard's applied-change notice (SPEC §8): one aggregate over every scheduled
// send a template or identity change re-made. Every re-make touches every scheduled
// send, so the re-made ones always share one remade_at (a send scheduled since has
// none), and the notice is always one moment and N posts. Its members are the sends
// by id and remade_at, the same record each post page uses, so clearing it here
// clears them there, and clearing every post hides it here. Re-painted with the
// queue: notice() keeps one aggregate per slot, replaces it when the set changes (a
// re-made send fired or was canceled), and clears it when the set is empty.
function paintAppliedNotice(root: HTMLElement, scheduled: SendView[]): void {
  const slot = $("#dashNotices", root);
  const remade = scheduled.flatMap((s) => (s.remade_at ? [{ id: s.id, at: s.remade_at }] : []));
  const at = remade.length ? Math.max(...remade.map((r) => r.at)) : 0;
  notice(slot, {
    kind: "applied",
    members: remade.map((r) => ({ subject: r.id, version: r.at })),
    markup: appliedNoticeHtml(at, remade.length, false),
  });
}
/** The dashboard's scheduled cards are read-only summaries: the whole card links into the
 *  editor, where the schedule is actually managed. The Sent page keeps the one-call cancel
 *  the review window needs (SPEC §8). */
function dashScheduledHtml(scheduled: SendView[]): Html {
  if (!scheduled.length) {
    return html`<p class="muted">Nothing scheduled.</p>`;
  }
  return html`${scheduled.map(
    (s) =>
      html`<div class="card spread clickable nextup sched-card" data-post="${s.post_id}"><div><a class="card-link sched-subj" href="#/edit/${s.post_id}">${s.subject}</a><div class="muted">${countdownHtml(s)} · ${fmt(s.fire_at)} · ${s.audience.count} recipients</div></div></div>`,
  )}`;
}
function wireDashScheduledCards(root: HTMLElement): void {
  for (const card of $$("#dashScheduled .nextup", root)) {
    card.onclick = (e) => {
      const t = e.target;
      if (t instanceof Element && t.tagName !== "A") {
        location.hash = `#/edit/${card.dataset.post}`;
      }
    };
  }
}

/** The dashboard active-send section (nothing when nothing is in flight). */
function dashActiveHtml(active: SendView[]): Html {
  if (!active.length) {
    return html``;
  }
  return html`<section class="dash-section"><h2>Active send${active.length === 1 ? "" : "s"}</h2>${active.map(
    activeRowHtml,
  )}</section>`;
}
function wireDashActiveCards(root: HTMLElement): void {
  for (const card of $$("#dashActive .active-card[data-watch]", root)) {
    card.onclick = (e) => {
      const t = e.target;
      if (t instanceof Element && t.tagName !== "A") {
        location.hash = `#/sent/${card.dataset.watch}`;
      }
    };
  }
}

// Controls shared by the Dashboard and the Getting-started view: hash navigation,
// "New post", "Add subscriber", and copy buttons.
function wireDashActions(root: HTMLElement, reload: () => void): void {
  for (const b of $$("[data-nav]", root)) {
    b.onclick = () => {
      location.hash = b.dataset.nav ?? "";
    };
  }
  for (const b of $$<HTMLButtonElement>("[data-act='new-post']", root)) {
    b.onclick = () => createNewPost(b);
  }
  for (const b of $$("[data-act='add-sub']", root)) {
    b.onclick = () => addSubscriberModal(reload);
  }
  for (const b of $$("[data-copy]", root)) {
    b.onclick = () => copyText(b.dataset.copy ?? "");
  }
}

// The onboarding checklist, shared by the first-run dashboard and Getting-started.
// The "API access" card. Two states: an invitation to connect Claude, or — once Claude
// (the `service` principal, SPEC §4) has edited here — a plain "Claude is connected" note.
// Shared by the populated dashboard and the first-run state (a card below the setup
// checklist), so the two can't drift; connecting an agent is optional, so this is never a
// required setup step. Both states have one shape — a line, then the card's links stacked
// at one weight, each led by a glyph for what it is (the guide, the reference) — because
// neither link is an action: connecting happens outside the app (an Access service token),
// so nothing here may look like a button that would do it. Typography-led with no base-URL
// field: the operator already knows their own origin (it's the Publication card's URL right
// beside this one), and the connect guide is where that URL is actually used.
function apiConnectCard(connected: boolean): Html {
  if (connected) {
    return html`<div class="card pub-card">
    <p class="conn-status"><span class="conn-dot" aria-hidden="true"></span>Claude is connected.</p>
    <div class="pub-foot pub-links"><a href="#/reference">${icon("code")}API reference →</a><a href="#/docs/connect-claude">${icon("article")}Connection guide →</a></div>
  </div>`;
  }
  return html`<div class="card pub-card">
    <p class="pub-note">Let Claude draft, proofread, and schedule your posts.</p>
    <div class="pub-foot pub-links"><a href="#/docs/connect-claude">${icon("article")}Connect Claude →</a><a href="#/reference">${icon("code")}API reference →</a></div>
  </div>`;
}

function setupChecklistHtml(pub: Publication, deployment: DeploymentView | null): Html {
  const subscribeUrl = `${deployment?.appOrigin || location.origin}/subscribe`;
  return html`<div class="card setup">
    <h2 class="setup-title">Set up your publication</h2>
    <ol class="setup-steps">
      <li><div class="setup-step-main"><strong>Name your publication</strong><span class="muted">Currently “${pub.name}”. Set the name, tagline, and brand in Settings.</span></div><button data-nav="#/settings">Settings</button></li>
      <li><div class="setup-step-main"><strong>Write your first post</strong><span class="muted">Draft a post in Markdown and preview it exactly as the email.</span></div><button class="primary" data-act="new-post">New post</button></li>
      <li><div class="setup-step-main"><strong>Confirm your sending domain</strong><span class="muted">SPF, DKIM, and DMARC on your From address — the setup guide walks through it.</span></div><button data-nav="#/docs">Docs</button></li>
      <li><div class="setup-step-main"><strong>Share your subscribe link</strong><code class="setup-url">${subscribeUrl}</code></div><button data-copy="${subscribeUrl}">Copy</button></li>
    </ol>
  </div>`;
}
