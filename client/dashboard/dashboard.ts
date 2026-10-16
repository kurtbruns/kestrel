// The dashboard (home): counts, the active send widget, drafts and sent tables, the
// setup steps (the first-run checklist, then the Finish setting up card), and quick actions.

import type { PostListItem, PostListResponse } from "../../shared/posts";
import type { SendListResponse, SendView } from "../../shared/sends";
import type { DeploymentView } from "../../shared/settings";
import type { SubscriberCounts, SubscriberListResponse } from "../../shared/subscribers";
import { api, describeError } from "../api";
import { derivePublication, type Publication } from "../brand";
import {
  CONNECT_PROVIDER_HREF,
  connectProviderLink,
  heldSendsHtml,
  heldWhenFiresHtml,
  providerNotConnected,
} from "../deployment";
import { mount } from "../lifecycle";
import { createNewPost } from "../posts/drafts";
import { followSends, type SendStage, type SendsUpdate, stageOf } from "../send_state";
import {
  activeRowHtml,
  conditionOf,
  countdownHtml,
  countdowns,
  deliveredCell,
  emailOnlyNote,
  has,
  needsOperator,
  sendsNow,
  titleWithLabel,
} from "../sends/progress";
import { appState } from "../state";
import { addSubscriberModal } from "../subscribers/dialogs";
import { copyButton, copyFace, wireCopy } from "../ui/copy";
import { $, $$ } from "../ui/dom";
import { fmt } from "../ui/format";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { badge, renderError } from "../ui/widgets";

// The post-login landing and the brand's target (the default route). Built entirely
// from existing authed endpoints — GET /api/posts, /sends, /subscribers, and the cached
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
// provider outage, which its retry explains, are shown where the send is. The one line
// not about a send is the deployment's: no email provider connected (SPEC §9), an amber
// standing state with no time, read from the deployment reflection, gone once one is set.
// When that state is holding a send, the two are said as one red line instead of two.
// While the Finish setting up card carries its Connect Amazon SES step, the card says the
// not-connected state and the amber line is left out, so it is said once (DESIGN §3).
function computeHealth(live: SendView[], setupSaysNotConnected = false): HealthAlert[] {
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
  // A send held for want of a provider (SPEC §9) is the deployment's state showing on a
  // send, so while the deployment is not connected the two are one line: the state, the
  // held sends, and the fix once, as a link. Red, since a send is waiting on the operator.
  const notConnected = providerNotConnected();
  const allRefused = live.flatMap((s) => {
    const c = conditionOf(s, "refused");
    return c ? [{ s, c }] : [];
  });
  const held = notConnected ? allRefused.filter((r) => r.c.cause === "not_connected") : [];
  const refused = allRefused.filter((r) => !held.includes(r));
  // One send links to its watch; several, to the Sent page that lists them all.
  const which = (sends: { s: SendView }[]) =>
    sends.length === 1 && sends[0]
      ? html`<a href="#/sent/${sends[0].s.id}">${sends[0].s.subject}</a>`
      : html`<a href="#/sent">${sends.length} sends</a>`;
  if (held.length) {
    alerts.push({
      level: "red",
      text: html`<span class="dash-not-connected">${heldSendsHtml(which(held), held.length)}</span>`,
    });
  }
  const [firstRefused] = refused;
  if (firstRefused) {
    alerts.push({ level: "red", text: html`${which(refused)}: ${firstRefused.c.message}` });
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
          : html`<a href="#/sent">${stuck.length} sends</a> have handed off no one for a while, with no retry or provider problem to explain it.`,
    });
  }
  // A rate limit the deployment causes itself (SPEC §12): the server marks it worth a look,
  // since a burst never lasts, and its words name the setting.
  const throttled = live.flatMap((s) => {
    const c = conditionOf(s, "provider_unavailable");
    return c?.severity === "warn" ? [{ s, c }] : [];
  });
  const [firstThrottled] = throttled;
  if (firstThrottled) {
    alerts.push({
      level: "amber",
      text: html`<a href="#/sent/${firstThrottled.s.id}">${firstThrottled.s.subject}</a>: ${firstThrottled.c.message}`,
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
  // No receipts (SPEC §8): a recent send that has heard nothing back for anyone the
  // provider took, long after dispatch, so its events may not be reaching the app and its
  // bounces and complaints suppress no one. One line, since one broken destination silences
  // every send alike.
  const silent = live.flatMap((s) => {
    const c = conditionOf(s, "no_receipts");
    return c ? [{ s, c }] : [];
  });
  const [firstSilent] = silent;
  if (firstSilent) {
    alerts.push({
      level: "amber",
      text:
        silent.length === 1
          ? html`<a href="#/sent/${firstSilent.s.id}">${firstSilent.s.subject}</a>: ${firstSilent.c.message}`
          : html`<a href="#/sent">${silent.length} sends</a> have had no delivery receipt long after they went out. The provider's events may not be reaching this app, so its bounces and complaints suppress no one.`,
    });
  }
  if (notConnected && !held.length && !setupSaysNotConnected) {
    alerts.push({
      level: "amber",
      text: html`<span class="dash-not-connected">No email provider connected, so nothing can be sent yet. ${connectProviderLink()} to start sending.</span>`,
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
  let workersPlanAdvice: string | null;
  try {
    // The health line scans every send and the archive-link slug map needs every post,
    // so ask for a full window rather than the list default (50). Subscribers is only
    // read for its (filter-independent) counts, so its row limit doesn't matter.
    const [p, s, subs] = await Promise.all([
      api<PostListResponse>("/api/posts?limit=200", { signal }),
      api<SendListResponse>("/api/sends?limit=200", { signal }),
      api<SubscriberListResponse>("/api/subscribers", { signal }),
    ]);
    posts = p.posts;
    first = s;
    counts = subs.counts;
    workersPlanAdvice = subs.workers_plan_advice;
  } catch (e) {
    renderError(root, describeError(e), remount);
    return;
  }
  let sends = first.sends;
  // Every send the layer has reported since the page's read, as it now stands.
  const reported = new Map<string, SendView>();
  const pub = derivePublication(appState.appConfig);
  const deployment = appState.appConfig?.deployment ?? null;

  // A post listed in the archive has been published (its send started): the step that ends
  // setup. An email-only post (Verify it works' test send) doesn't count (SPEC §5).
  const archived = () =>
    sends.some((s) => (s.status === "sending" || s.status === "sent") && !s.email_only);
  // What the setup steps read as done, from what the app already knows (DESIGN §3).
  const setupProgress = (): SetupProgress => ({
    named: Boolean(appState.appConfig?.settings.publication?.name?.trim()),
    onList: counts.confirmed + counts.pending,
    archived: archived(),
  });

  // First run, with nothing written yet: replace the body with the setup checklist rather
  // than a wall of empty tiles. It ends at the first post, not the first subscriber, so
  // bringing a list in (a step on it) doesn't take away the steps after it; from the first
  // post the same steps are the Finish setting up card below.
  if (!posts.length) {
    setHtml(
      root,
      html`<div class="dash-head"><div><h1>${pub.name}</h1>${
        pub.tagline ? html`<p class="muted dash-tagline">${pub.tagline}</p>` : null
      }<p class="muted">Let’s get your first post out the door.</p></div></div>${setupStepsHtml(pub, deployment, setupProgress(), "checklist")}<section class="dash-section"><h2>API access</h2>${apiConnectCard(false)}</section>`,
    );
    wireDashActions(root, remount, signal);
    return;
  }

  // The Finish setting up card, while setup is open: until its last step, a post listed in
  // the archive published, is done, so the step's check and the card ending are one moment.
  const setupOpen = () => !archived();
  const setupCardHtml = () =>
    setupOpen() ? setupStepsHtml(pub, deployment, setupProgress(), "card") : html``;
  const healthNow = () =>
    healthHtml(computeHealth(sendsNow(sends, reported), setupOpen() && providerNotConnected()));

  // Each tile deep-links into the roster pre-filtered on its criterion
  // (#/subscribers/<filter>), so a count is a way in, not just a number.
  const tiles: Tile[] = [
    {
      label: "Confirmed",
      emph: true,
      v: counts.confirmed,
      filter: "confirmed",
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
    ? html`<div class="table-wrap"><table class="dash-drafts"><tbody>${drafts.map(
        (p) =>
          html`<tr class="clickable" data-id="${p.id}"><td>${titleWithLabel(html`<a href="#/edit/${p.id}">${p.subject || html`<em>untitled</em>`}</a>`, p)}</td><td class="muted edited">edited ${fmt(p.updated_at)}</td></tr>`,
      )}</tbody></table></div>`
    : html`<p class="muted">No drafts in progress.</p>`;

  // The publication's home is the landing page at the app's own origin (SPEC §11); the
  // archive and every post are a click from it, so the card names the one address to share.
  const homeUrl = deployment?.appOrigin || location.origin;
  const pubCardHtml = html`<div class="card pub-card">
    <div class="pub-row"><code class="pub-val">${homeUrl}</code>${copyButton(homeUrl, "Copy the publication’s address")}</div>
    <div class="pub-foot"><a href="/" target="_blank" rel="noopener">View publication&nbsp;↗</a></div>
  </div>`;

  // Has Claude (the `service` principal) edited here? Authorship on any current revision
  // flips the API-access card to "connected" (SPEC §4). Uses the author already on each
  // list row, so no extra fetch; a post a human later re-edited no longer counts.
  const claudeConnected = posts.some((p) => p.author === "service");
  const apiCardHtml = apiConnectCard(claudeConnected);

  const quickHtml = html`<div class="row quick-actions"><button data-act="new-post">New post</button><button data-act="add-sub">Add subscriber</button><button data-nav="#/settings">Edit publication</button></div>`;

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
    <div id="dashHealth">${healthNow()}</div>
    <div id="dashSetup">${setupCardHtml()}</div>
    <div id="dashActive">${dashActiveHtml(activeOf(sendsNow(sends, reported)))}</div>
    <section class="dash-section"><h2>Subscribers</h2>${tilesHtml}${
      workersPlanAdvice
        ? html`<p class="workers-plan" id="dashWorkersPlan" role="status">${workersPlanAdvice}</p>`
        : null
    }</section>
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

  wireDashActions(root, remount, signal);
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
  const tickCountdowns = countdowns(root, signal);
  tickCountdowns();

  // From here the send-state layer keeps the send sections current (docs/DESIGN.md §4),
  // following every send from where the page's own read stood. Each report repaints what it
  // carries directly (the health block, the active-send widget, a listed send's Delivered).
  // A stage change, or any change to a scheduled or due send (a cancel, a move, a re-make,
  // a new schedule, the fire time passing, a miss), reads the sends again for the queue,
  // and the Sent table, whoever made it: a send that went due to sent between
  // two reads lands straight in the Sent table, and the other client's move shows within
  // one idle read.
  let reading = 0;
  const readSends = async () => {
    const mine = ++reading;
    try {
      const fresh = await api<SendListResponse>("/api/sends?limit=200", { signal });
      if (mine !== reading) {
        return; // a later change's read is the one to paint
      }
      sends = fresh.sends;
      setHtml($("#dashScheduled", root), dashScheduledHtml(scheduledOf(sends)));
      wireDashScheduledCards(root);
      tickCountdowns(); // the fresh cards are empty until the next tick
      setHtml($("#dashSent", root), dashSentHtml(sends));
      wireDashSentRows(root);
      setHtml($("#dashSetup", root), setupCardHtml());
      wireDashButtons($("#dashSetup", root), remount, signal); // Copy is delegated from root
      paintLive();
    } catch {
      /* a background read: the sections keep their last render until the next change */
    }
  };
  const paintLive = () => {
    const now = sendsNow(sends, reported);
    setHtml($("#dashHealth", root), healthNow());
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
  return html`<div class="table-wrap"><table class="dash-sent"><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th><th></th></tr></thead><tbody>${recent.map(
    (s) => {
      // The published post, which the send's view links once it has started: its archive
      // page, or an email-only post's page at its unlisted link, so the link says which.
      const url = s.email_only ? s.links.unlisted : s.links.archive;
      return html`<tr class="clickable" data-send="${s.id}"><td>${titleWithLabel(html`<a href="#/sent/${s.id}">${s.subject}</a>`, s)}</td><td>${badge(s.status)}</td><td class="num">${s.audience.count.toLocaleString()}</td><td class="num delivered">${deliveredCell(s.counts)}</td><td class="act">${
        url
          ? html`<a class="ghost-link" href="${url}" target="_blank" rel="noopener">${s.email_only ? html`Web version&nbsp;↗` : html`Archive&nbsp;↗`}</a>`
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

/** The dashboard's scheduled cards are read-only summaries: the whole card links into the
 *  editor, where the schedule is actually managed. A send the server reports as re-made
 *  since its last test says so, and the editor, where the test is, says what to do. The
 *  Sent page keeps the one-call cancel the review window needs (SPEC §8). */
function dashScheduledHtml(scheduled: SendView[]): Html {
  if (!scheduled.length) {
    return html`<p class="muted">Nothing scheduled.</p>`;
  }
  const held = heldWhenFiresHtml("card");
  return html`${scheduled.map(
    (s) =>
      html`<div class="card spread clickable nextup sched-card" data-post="${s.post_id}"><div><a class="card-link sched-subj" href="#/edit/${s.post_id}">${s.subject}</a><div class="muted">${countdownHtml(s)} · ${fmt(s.fire_at)} · ${s.audience.count} recipients${emailOnlyNote(s)}</div>${held}${has(s, "remade") ? html`<div class="sched-remade-mark">Look changed since your last test</div>` : null}</div></div>`,
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
  // The health line above already says a send is in flight too long, so its card doesn't.
  return html`<section class="dash-section"><h2>Active send${active.length === 1 ? "" : "s"}</h2>${active.map(
    (s) => activeRowHtml(s, { stuckNote: false }),
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

// The dashboard's controls, on the regular dashboard, the first-run checklist, and the Finish
// setting up card: hash navigation, "New post", "Add subscriber", and copy buttons.
function wireDashActions(root: HTMLElement, reload: () => void, signal: AbortSignal): void {
  wireDashButtons(root, reload, signal);
  wireCopy(root);
}

/** The buttons under `root`, each wired by assignment, so wiring a repainted part again is safe. */
function wireDashButtons(root: HTMLElement, reload: () => void, signal: AbortSignal): void {
  for (const b of $$("[data-nav]", root)) {
    b.onclick = () => {
      location.hash = b.dataset.nav ?? "";
    };
  }
  for (const b of $$<HTMLButtonElement>("[data-act='new-post']", root)) {
    b.onclick = () => createNewPost(b);
  }
  for (const b of $$("[data-act='add-sub']", root)) {
    b.onclick = () => addSubscriberModal(reload, signal);
  }
}

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

/**
 * What the setup steps read as done, each from what the app already knows (DESIGN §3).
 * Checking the setup is never read as done: a send the operator made to verify the instance
 * says nothing about whether the publisher has checked theirs.
 */
interface SetupProgress {
  /** A name has been set in Settings. */
  named: boolean;
  /** Confirmed and pending subscribers on the list. */
  onList: number;
  /** A post listed in the archive has been published: setup is done. */
  archived: boolean;
}

/**
 * The setup steps, in one of two layouts: the first-run `checklist` that stands in for the
 * dashboard until the first post, and the compact `card` the regular dashboard carries until
 * the first post listed in the archive is published. One list, so the two can't drift. The
 * steps go in the order they depend on each other, each the publisher's to take except
 * connecting a provider, which shows only until one is: while none is, connecting replaces
 * the check-your-setup step (nothing can be checked before it) and the subscribe step says
 * signups wait for it. A step reads as done only from what the app knows. Checking the setup
 * and sharing the link are guidance and never read as done; sending a post to the archive is
 * the one that ends setup, so its check and the card clearing happen together. The Publishing docs'
 * section of the same name (docs/publishing/README.md) follows these steps, so a change here
 * changes it.
 */
function setupStepsHtml(
  pub: Publication,
  deployment: DeploymentView | null,
  progress: SetupProgress,
  layout: "checklist" | "card",
): Html {
  const subscribeUrl = `${deployment?.appOrigin || location.origin}/subscribe`;
  const notConnected = providerNotConnected();
  const { onList } = progress;
  const done = (yes: boolean) => (yes ? " setup-done" : "");
  return html`<div class="card setup${layout === "card" ? " setup-card" : ""}">
    <h2 class="setup-title">${layout === "card" ? "Finish setting up" : "Set up your publication"}</h2>
    <ol class="setup-steps">
      <li class="setup-name${done(progress.named)}"><div class="setup-step-main"><strong>Name your publication</strong><span class="muted">Currently “${pub.name}”. Set the name, tagline, and brand in Settings.</span></div><button data-nav="#/settings">Settings</button></li>
      ${
        notConnected
          ? html`<li class="setup-connect"><div class="setup-step-main"><strong>Connect Amazon SES</strong><span class="muted">Nothing can be sent, and signups stay closed, until SES is connected.</span></div><button data-nav="${CONNECT_PROVIDER_HREF}">Connect Amazon SES</button></li>`
          : html`<li class="setup-check"><div class="setup-step-main"><strong>Check your setup</strong><span class="muted">Send yourself a test, and see how Kestrel tells you when something needs attention.</span></div><button data-nav="#/docs/check-your-setup">Docs</button></li>`
      }
      ${
        onList
          ? html`<li class="setup-done setup-list"><div class="setup-step-main"><strong>Bring your existing list</strong><span class="muted">${onList.toLocaleString()} ${onList === 1 ? "subscriber" : "subscribers"} on your list.</span></div><button data-nav="#/subscribers">Subscribers</button></li>`
          : html`<li class="setup-list"><div class="setup-step-main"><strong>Bring your existing list</strong><span class="muted">Import the subscribers you have on another service, with the consent they gave there. Skip this if you’re starting fresh.</span></div><button data-nav="#/subscribers/import">Import</button></li>`
      }
      <li class="setup-write${done(progress.archived)}"><div class="setup-step-main"><strong>Publish your first post</strong><span class="muted">Write a post, test it, and send it. It goes to your subscribers and onto your site.</span></div>${layout === "card" ? html`<button data-act="new-post">New post</button>` : html`<button class="primary" data-act="new-post">New post</button>`}</li>
      ${
        notConnected
          ? html`<li class="setup-subscribe"><div class="setup-step-main"><strong>Share your subscribe link</strong><span class="muted">Signups open once an email provider is connected; until then the page says they aren’t open yet.</span></div></li>`
          : html`<li class="setup-subscribe"><div class="setup-step-main"><strong>Share your subscribe link</strong><code class="setup-url">${subscribeUrl}</code></div><button type="button" data-copy="${subscribeUrl}" aria-label="Copy the subscribe link">${copyFace()}</button></li>`
      }
    </ol>
  </div>`;
}
