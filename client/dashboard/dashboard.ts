// The dashboard (home): counts, the active send widget, drafts and sent tables, the
// setup checklist, and quick actions.

import type { PostListItem, PostListResponse } from "../../shared/posts";
import type { SendListResponse, SendSummary } from "../../shared/sends";
import type { DeploymentView } from "../../shared/settings";
import type { SubscriberCounts, SubscriberListResponse } from "../../shared/subscribers";
import { api } from "../api";
import { derivePublication, type Publication } from "../brand";
import { archiveUrlFor } from "../deployment";
import { mount, poll } from "../lifecycle";
import { createNewPost } from "../posts/drafts";
import {
  activeRowHtml,
  countdowns,
  deliveredCell,
  isRefused,
  isWedged,
  needsOperator,
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

// SES puts a sender under review at a 5% bounce rate, so that danger-zone threshold is
// what the health line treats as a "bounce spike" (SPEC §8/§12). It sits well above the
// dev send simulator's normal ~2% simulated bounce rate (src/providers/simulate.ts), so a
// demo send never false-alarms. A small absolute floor keeps a tiny audience's inherently
// noisy rate (one bad address out of a handful) from tripping it.
const BOUNCE_SPIKE_RATE = 0.05;
const BOUNCE_SPIKE_MIN = 3;

/** One line of the health block: red needs a decision, amber a look. */
interface HealthAlert {
  level: "red" | "amber";
  text: string;
}

// Health (SPEC §8 "is anything wrong", §12 loud failure): calm in the common case,
// loud only when something needs attention. Derived from GET /sends.
function computeHealth(sends: SendSummary[]): HealthAlert[] {
  const now = Date.now();
  const alerts: HealthAlert[] = [];
  const missed = sends.filter((s) => s.status === "scheduled" && s.fire_at <= now);
  if (missed.length) {
    alerts.push({
      level: "red",
      text: `${missed.length} scheduled send${missed.length === 1 ? "" : "s"} passed the fire time without going out.`,
    });
  }
  const sending = sends.filter((s) => s.status === "sending");
  // A send wedged on ambiguous in-flight rows needs a decision, not just patience —
  // flag it red and actionable, and keep it out of the generic in-progress lines
  // below so it isn't reported twice (SPEC §12; resolve on the Sends page).
  const wedged = sending.filter(isWedged);
  if (wedged.length) {
    const n = wedged.reduce((sum, s) => sum + (s.c_in_flight || 0), 0);
    alerts.push({
      level: "red",
      text: `${n} ambiguous ${n === 1 ? "delivery needs" : "deliveries need"} a decision — resolve on the Sent page.`,
    });
  }
  // The provider refusing the account stops every send it touches until the operator
  // fixes the account (SPEC §12): one red line, carrying the provider's own words.
  const refused = sending.filter(isRefused);
  const [firstRefused] = refused;
  if (firstRefused) {
    const noun = refused.length === 1 ? "a send" : `${refused.length} sends`;
    alerts.push({
      level: "red",
      text: `The email provider is refusing this account, pausing ${noun}: ${firstRefused.halt_error ?? "no detail given"}. Fix it with the provider; sending resumes on its own.`,
    });
  }
  // A healthy in-progress send is NOT surfaced here — the live active-send widget below is
  // its home (a bar + a Watch link, kept live by the poll). The health line is loud-only,
  // so it keeps just the *stuck* case: a send that's been running unusually long.
  const active = sending.filter((s) => !needsOperator(s));
  const stuck = active.filter((s) => s.started_at && now - s.started_at > 10 * 60 * 1000);
  if (stuck.length) {
    alerts.push({
      level: "amber",
      text: "A send has been in progress over 10 minutes — it may be retrying.",
    });
  }
  // Bounce spike (SPEC §8 "is anything wrong", §12): a recent send whose real bounce rate
  // is in the danger zone. This reads the true webhook-confirmed bounce count off the send
  // row's `c_bounced` counter over the frozen audience — not the old
  // send-time-`unsent` proxy, which couldn't see asynchronous bounce events at all. The
  // threshold is BOUNCE_SPIKE_RATE; the absolute floor keeps a tiny audience's noisy rate
  // from tripping it. Read-only reporting — it never throttles or halts a send (§12 leaves
  // an automatic deliverability circuit-breaker deferred).
  const spiky = sends
    .filter((s) => s.status === "sent")
    .slice(0, 5)
    .find((s) => {
      const bounced = s.c_bounced || 0;
      return (
        s.recipient_count > 0 &&
        bounced >= BOUNCE_SPIKE_MIN &&
        bounced / s.recipient_count >= BOUNCE_SPIKE_RATE
      );
    });
  if (spiky) {
    const pct = Math.round((100 * (spiky.c_bounced || 0)) / spiky.recipient_count);
    alerts.push({
      level: "amber",
      text: `Elevated bounce rate (${pct}%) on a recent send — check the Sent page.`,
    });
  }
  return alerts;
}

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
  let sends: SendSummary[];
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
    sends = s.sends;
    counts = subs.counts;
  } catch (e) {
    renderError(root, e instanceof Error ? e.message : String(e), remount);
    return;
  }
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

  // No news is good news: the health line appears only when something needs
  // attention (SPEC §8 / §12 — the only thing that ever surfaces loudly).
  const health = computeHealth(sends);
  const level = health.some((i) => i.level === "red") ? "red" : "amber";
  const healthHtml = health.length
    ? html`<div class="health ${level}"><span class="health-dot">⚠️</span><div>${health.map(
        (i) => html`<div>${i.text}</div>`,
      )}</div></div>`
    : null;

  // Active-send widget: when a send is in flight (and not wedged — that's a red health
  // line above), show it with a live mini dispatch bar, an ETA, and a Watch link into the
  // record view's live watch (#154). A glanceable entry point sitting with the health area.
  // It lives in its own `#dashActive` container and is polled live (below), so its bar
  // advances and it appears/clears without a manual reload.
  const activeSends = sends.filter((s) => s.status === "sending" && !needsOperator(s));

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

  const scheduled = sends
    .filter((s) => s.status === "scheduled")
    .sort((a, b) => a.fire_at - b.fire_at);
  const nextUpHtml = dashScheduledHtml(scheduled);

  const slugById = new Map(posts.map((p) => [p.id, p.slug] as const));
  const recent = sends.filter((s) => s.status === "sent" || s.status === "sending").slice(0, 5);
  const recentHtml = recent.length
    ? html`<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th><th></th></tr></thead><tbody>${recent.map(
        (s) => {
          const slug = slugById.get(s.post_id);
          const url = slug ? archiveUrlFor(deployment, slug) : null;
          // A sent row opens its record view (#148); the subject is the keyboard target.
          const isSent = s.status === "sent";
          const subj = isSent ? html`<a href="#/sent/${s.id}">${s.subject}</a>` : s.subject;
          const cells = html`<td>${subj}</td><td>${badge(s.status)}</td><td class="num">${s.recipient_count.toLocaleString()}</td><td class="num">${deliveredCell(s)}</td><td class="act">${
            url && isSent
              ? html`<a class="ghost-link" href="${url}" target="_blank" rel="noopener">Archive&nbsp;↗</a>`
              : null
          }</td>`;
          return isSent
            ? html`<tr class="clickable" data-send="${s.id}">${cells}</tr>`
            : html`<tr>${cells}</tr>`;
        },
      )}</tbody></table></div>`
    : html`<p class="muted">No sends yet.</p>`;

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

  setHtml(
    root,
    html`
    <div class="dash-head">
      <div><h1>${pub.name}</h1>${pub.tagline ? html`<p class="muted dash-tagline">${pub.tagline}</p>` : null}</div>
      <button class="primary" data-act="new-post">New post</button>
    </div>
    ${healthHtml}
    <div id="dashActive">${dashActiveHtml(activeSends)}</div>
    <section class="dash-section"><h2>Subscribers</h2>${tilesHtml}</section>
    <div id="dashNotices"></div>
    <div class="dash-cols">
      <section class="dash-section"><h2>Scheduled</h2><div id="dashScheduled">${nextUpHtml}</div></section>
      <section class="dash-section"><h2>Drafts</h2>${draftsHtml}</section>
    </div>
    <section class="dash-section"><h2>Sent</h2>${recentHtml}</section>
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
  // Recent-sends rows carry a SEND id (not a post id) and open the record view.
  for (const tr of $$<HTMLTableRowElement>("tr[data-send]", root)) {
    tr.onclick = (e) => {
      const t = e.target;
      if (t instanceof Element && t.tagName !== "A") {
        location.hash = `#/sent/${tr.dataset.send}`;
      }
    };
  }
  wireDashActiveCards(root);
  wireDashScheduledCards(root);
  paintAppliedNotice(root, scheduled);
  const tickCountdowns = countdowns(root, signal);
  tickCountdowns();
  // Keep the send sections live: advance the active-send widget's bar, and when a send
  // starts or finishes, refresh the Scheduled queue so a fired post clears out of it (its
  // home is now the In-progress widget, then the records). Ends with the mount.
  liveSendSections(root, signal, tickCountdowns);
}

// The dashboard's applied-change notice (SPEC §8): one aggregate over every scheduled
// send a template or identity change re-made. Every re-make touches every scheduled
// send, so the re-made ones always share one remade_at (a send scheduled since has
// none), and the notice is always one moment and N posts. Its members are the sends
// by id and remade_at, the same record each post page uses, so clearing it here
// clears them there, and clearing every post hides it here. Re-painted with the
// queue: notice() keeps one aggregate per slot, replaces it when the set changes (a
// re-made send fired or was canceled), and clears it when the set is empty.
function paintAppliedNotice(root: HTMLElement, scheduled: SendSummary[]): void {
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
function dashScheduledHtml(scheduled: SendSummary[]): Html {
  if (!scheduled.length) {
    return html`<p class="muted">Nothing scheduled.</p>`;
  }
  return html`${scheduled.map(
    (s) =>
      html`<div class="card spread clickable nextup sched-card" data-post="${s.post_id}"><div><a class="card-link sched-subj" href="#/edit/${s.post_id}">${s.subject}</a><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div></div>`,
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
function dashActiveHtml(active: SendSummary[]): Html {
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
// Poll the in-flight set (~3s) and repaint ONLY the widget container in place — it slides
// in as a send starts, advances, and clears when it finishes, with no full-page re-render
// (a full re-render flashed the whole dashboard as the send started). The health line and
// Sent table is a glance snapshot that refreshes on navigation. Ends with the mount.
function liveSendSections(
  root: HTMLElement,
  signal: AbortSignal,
  tickCountdowns: () => void,
): void {
  let activeSig = "";
  poll(
    3000,
    async () => {
      const { sends } = await api<SendListResponse>("/sends?status=sending&limit=200", {
        signal,
      });
      const active = sends.filter((s) => !needsOperator(s));
      setHtml($("#dashActive", root), dashActiveHtml(active));
      wireDashActiveCards(root);
      // On a transition (a send started or finished) the scheduled queue changed — a fired
      // send left it — so refresh just that section in place (no full-page re-render).
      const sig = active
        .map((s) => s.id)
        .sort()
        .join(",");
      if (sig !== activeSig) {
        activeSig = sig;
        await refreshScheduled(root, signal, tickCountdowns);
      }
    },
    signal,
  );
}
async function refreshScheduled(
  root: HTMLElement,
  signal: AbortSignal,
  tickCountdowns: () => void,
): Promise<void> {
  const el = $("#dashScheduled", root);
  try {
    const { sends } = await api<SendListResponse>(
      "/sends?status=scheduled&sort=fire&dir=asc&limit=200",
      { signal },
    );
    setHtml(el, dashScheduledHtml(sends));
    wireDashScheduledCards(root);
    paintAppliedNotice(root, sends);
    tickCountdowns(); // the fresh cards are empty until the next tick
  } catch {
    /* non-fatal — the scheduled section keeps its last render */
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
