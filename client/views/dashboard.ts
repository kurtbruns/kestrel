// @ts-nocheck
// The dashboard (home): counts, the active send widget, drafts and sent tables, the
// setup checklist, and quick actions.

import { api } from "../api";
import { derivePublication } from "../brand";
import { archiveUrlFor, copyText, createNewPost } from "../build_ref";
import { badge, esc, fmt, modal, toast } from "../helpers";
import { busy, notice, renderError } from "../notice";
import { appliedNoticeHtml } from "../remake";
import { app } from "../shell";
import { appState } from "../state";
import { activeRowHtml, deliveredCell, isWedged, startCountdowns } from "./sends";
import { addSubscriberModal } from "./subscribers";

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

// Health (SPEC §8 "is anything wrong", §12 loud failure): calm in the common case,
// loud only when something needs attention. Derived from GET /sends.
function computeHealth(sends) {
  const now = Date.now();
  const alerts = [];
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
  // A healthy in-progress send is NOT surfaced here — the live active-send widget below is
  // its home (a bar + a Watch link, kept live by the poll). The health line is loud-only,
  // so it keeps just the *stuck* case: a send that's been running unusually long.
  const active = sending.filter((s) => !isWedged(s));
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

export async function renderDashboard() {
  app.innerHTML = `<div class="dash" id="dash"><p class="muted">Loading…</p></div>`;
  const root = document.getElementById("dash");
  let posts, sends, counts;
  try {
    // The health line scans every send and the archive-link slug map needs every post,
    // so ask for a full window rather than the list default (50). Subscribers is only
    // read for its (filter-independent) counts, so its row limit doesn't matter.
    const [p, s, subs] = await Promise.all([
      api("/posts?limit=200"),
      api("/sends?limit=200"),
      api("/subscribers"),
    ]);
    posts = p.posts;
    sends = s.sends;
    counts = subs.counts;
  } catch (e) {
    renderError(root, e.message, renderDashboard);
    return;
  }
  const pub = derivePublication(appState.appConfig);
  const deployment = appState.appConfig?.deployment || {};
  const totalSubs = counts.confirmed + counts.pending + counts.unsubscribed + counts.suppressed;

  // First run — nothing written and no one on the list: replace the body with the
  // onboarding checklist (the shared Getting-started component) rather than a wall
  // of empty tiles.
  if (!posts.length && totalSubs === 0) {
    root.innerHTML =
      `<div class="dash-head"><div><h1>${esc(pub.name)}</h1>${
        pub.tagline ? `<p class="muted dash-tagline">${esc(pub.tagline)}</p>` : ""
      }<p class="muted">Let's get your first post out the door.</p></div></div>` +
      setupChecklistHtml(pub, deployment) +
      `<section class="dash-section"><h2>API access</h2>${apiConnectCard(false)}</section>`;
    wireDashActions(root, renderDashboard);
    return;
  }

  // No news is good news: the health line appears only when something needs
  // attention (SPEC §8 / §12 — the only thing that ever surfaces loudly).
  const health = computeHealth(sends);
  const level = health.some((i) => i.level === "red") ? "red" : "amber";
  const healthHtml = health.length
    ? `<div class="health ${level}"><span class="health-dot">⚠️</span><div>${health
        .map((i) => `<div>${esc(i.text)}</div>`)
        .join("")}</div></div>`
    : "";

  // Active-send widget: when a send is in flight (and not wedged — that's a red health
  // line above), show it with a live mini dispatch bar, an ETA, and a Watch link into the
  // record view's live watch (#154). A glanceable entry point sitting with the health area.
  // It lives in its own `#dashActive` container and is polled live (below), so its bar
  // advances and it appears/clears without a manual reload.
  const activeSends = sends.filter((s) => s.status === "sending" && !isWedged(s));

  // Each tile deep-links into the roster pre-filtered on its criterion
  // (#/subscribers/<filter>), so a count is a way in, not just a number.
  const tiles = [
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
  const tilesHtml = `<div class="tiles">${tiles
    .map(
      (t) =>
        `<a class="tile${t.emph ? " tile-emph" : ""}" href="#/subscribers/${t.filter}"><span class="tile-n">${t.v}</span><span class="tile-label">${esc(t.label)}${
          t.sub ? `<span class="tile-sub">${esc(t.sub)}</span>` : ""
        }</span></a>`,
    )
    .join("")}</div>`;

  const scheduled = sends
    .filter((s) => s.status === "scheduled")
    .sort((a, b) => a.fire_at - b.fire_at);
  const nextUpHtml = dashScheduledHtml(scheduled);

  const slugById = new Map(posts.map((p) => [p.id, p.slug]));
  const recent = sends.filter((s) => s.status === "sent" || s.status === "sending").slice(0, 5);
  const recentHtml = recent.length
    ? `<div class="table-wrap"><table><thead><tr><th>Subject</th><th>Status</th><th class="num">Recipients</th><th class="num">Delivered</th><th></th></tr></thead><tbody>${recent
        .map((s) => {
          const slug = slugById.get(s.post_id);
          const url = slug ? archiveUrlFor(deployment, slug) : null;
          // A sent row opens its record view (#148); the subject is the keyboard target.
          const isSent = s.status === "sent";
          const subj = isSent ? `<a href="#/sent/${s.id}">${esc(s.subject)}</a>` : esc(s.subject);
          return `<tr${isSent ? ` class="clickable" data-send="${s.id}"` : ""}><td>${subj}</td><td>${badge(s.status)}</td><td class="num">${s.recipient_count.toLocaleString()}</td><td class="num">${deliveredCell(s)}</td><td class="act">${
            url && isSent
              ? `<a class="ghost-link" href="${esc(url)}" target="_blank" rel="noopener">Archive&nbsp;↗</a>`
              : ""
          }</td></tr>`;
        })
        .join("")}</tbody></table></div>`
    : `<p class="muted">No sends yet.</p>`;

  const drafts = posts.filter((p) => p.status === "draft").slice(0, 5);
  const draftsHtml = drafts.length
    ? `<div class="table-wrap"><table><tbody>${drafts
        .map(
          (p) =>
            `<tr class="clickable" data-id="${p.id}"><td><a href="#/edit/${p.id}">${esc(p.subject) || "<em>untitled</em>"}</a></td><td class="muted">edited ${fmt(p.updated_at)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="muted">No drafts in progress.</p>`;

  const appOrigin = deployment.appOrigin || location.origin;
  const archiveBase =
    (deployment.archiveOrigin || location.origin) + (deployment.archiveBasePath || "");
  const pubCardHtml = `<div class="card pub-card">
    <div class="pub-row"><span class="pub-key muted">Publication</span><code class="pub-val">${esc(appOrigin)}</code><button class="ghost" data-copy="${esc(appOrigin)}">Copy</button></div>
    <div class="pub-row"><span class="pub-key muted">Archive</span><code class="pub-val">${esc(archiveBase)}</code><button class="ghost" data-copy="${esc(archiveBase)}">Copy</button></div>
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
  const quickHtml = `<div class="row quick-actions"><button class="primary" data-act="new-post">New post</button><button data-act="add-sub">Add subscriber</button><button data-nav="#/settings">Edit publication</button></div>`;

  root.innerHTML = `
    <div class="dash-head">
      <div><h1>${esc(pub.name)}</h1>${pub.tagline ? `<p class="muted dash-tagline">${esc(pub.tagline)}</p>` : ""}</div>
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
    </div>`;

  wireDashActions(root, renderDashboard);
  // Row / card clicks open the post (subject links + Cancel opt out — the same guard
  // the Posts table and the Sends cards use).
  root.querySelectorAll("tr[data-id]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.tagName !== "A" && !e.target.closest("button")) {
        location.hash = `#/edit/${tr.dataset.id}`;
      }
    };
  });
  // Recent-sends rows carry a SEND id (not a post id) and open the record view.
  root.querySelectorAll("tr[data-send]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.tagName !== "A") {
        location.hash = `#/sent/${tr.dataset.send}`;
      }
    };
  });
  wireDashActiveCards();
  wireDashScheduledCards();
  paintAppliedNotice(scheduled);
  startCountdowns();
  // Keep the send sections live: advance the active-send widget's bar, and when a send
  // starts or finishes, refresh the Scheduled queue so a fired post clears out of it (its
  // home is now the In-progress widget, then the records). Cleared on navigation.
  scheduleDashActivePoll();
}

// The dashboard's applied-change notice (SPEC §8): one aggregate over every scheduled
// send a template or identity change re-made. Every re-make touches every scheduled
// send, so the re-made ones always share one remade_at (a send scheduled since has
// none), and the notice is always one moment and N posts. Its members are the sends
// by id and remade_at, the same record each post page uses, so clearing it here
// clears them there, and clearing every post hides it here. Re-painted with the
// queue: notice() keeps one aggregate per slot, replaces it when the set changes (a
// re-made send fired or was canceled), and clears it when the set is empty.
function paintAppliedNotice(scheduled) {
  const slot = document.getElementById("dashNotices");
  if (!slot) {
    return;
  }
  const remade = scheduled.filter((s) => s.remade_at);
  const at = remade.length ? Math.max(...remade.map((s) => s.remade_at)) : 0;
  notice(slot, {
    kind: "applied",
    members: remade.map((s) => ({ subject: s.id, version: s.remade_at })),
    markup: appliedNoticeHtml(at, remade.length, false),
  });
}
/** The dashboard's scheduled cards are read-only summaries: the whole card links into the
 *  editor, where the schedule is actually managed. The Sent page keeps the one-call cancel
 *  the review window needs (SPEC §8). */
function dashScheduledHtml(scheduled) {
  if (!scheduled.length) {
    return `<p class="muted">Nothing scheduled.</p>`;
  }
  return scheduled
    .map(
      (s) =>
        `<div class="card spread clickable nextup sched-card" data-post="${s.post_id}"><div><a class="card-link sched-subj" href="#/edit/${s.post_id}">${esc(s.subject)}</a><div class="muted"><span class="countdown" data-fire="${s.fire_at}"></span> · ${fmt(s.fire_at)} · ${s.recipient_count} recipients</div></div></div>`,
    )
    .join("");
}
function wireDashScheduledCards() {
  document.querySelectorAll("#dashScheduled .nextup").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.tagName !== "A") {
        location.hash = `#/edit/${card.dataset.post}`;
      }
    };
  });
}

/** The dashboard active-send section (empty string when nothing is in flight). */
function dashActiveHtml(active) {
  if (!active.length) {
    return "";
  }
  return `<section class="dash-section"><h2>Active send${active.length === 1 ? "" : "s"}</h2>${active
    .map(activeRowHtml)
    .join("")}</section>`;
}
function wireDashActiveCards() {
  document.querySelectorAll("#dashActive .active-card[data-watch]").forEach((card) => {
    card.onclick = (e) => {
      if (e.target.tagName !== "A") {
        location.hash = `#/sent/${card.dataset.watch}`;
      }
    };
  });
}
// Poll the in-flight set (~3s) and repaint ONLY the widget container in place — it slides
// in as a send starts, advances, and clears when it finishes, with no full-page re-render
// (a full re-render flashed the whole dashboard as the send started). The health line and
// Sent table is a glance snapshot that refreshes on navigation. A recursive setTimeout, so
// a slow read never overlaps; `progressTimer` holds it so navigation clears it.
let dashActiveSig = "";
function scheduleDashActivePoll() {
  const gen = appState.navGeneration;
  appState.progressTimer = setTimeout(async () => {
    let sends;
    try {
      ({ sends } = await api("/sends?status=sending&limit=200"));
    } catch {
      if (gen === appState.navGeneration) {
        scheduleDashActivePoll();
      }
      return;
    }
    // Navigated off the dashboard mid-fetch: #dashActive is gone (or belongs to a re-mounted
    // dashboard with its own poll), so don't repaint or reschedule onto it (see navGeneration).
    if (gen !== appState.navGeneration) {
      return;
    }
    const active = sends.filter((s) => !isWedged(s));
    const el = document.getElementById("dashActive");
    if (el) {
      el.innerHTML = dashActiveHtml(active);
      wireDashActiveCards();
    }
    // On a transition (a send started or finished) the scheduled queue changed — a fired
    // send left it — so refresh just that section in place (no full-page re-render).
    const sig = active
      .map((s) => s.id)
      .sort()
      .join(",");
    if (sig !== dashActiveSig) {
      dashActiveSig = sig;
      refreshDashScheduled();
    }
    scheduleDashActivePoll();
  }, 3000);
}
async function refreshDashScheduled() {
  const el = document.getElementById("dashScheduled");
  if (!el) {
    return;
  }
  try {
    const { sends } = await api("/sends?status=scheduled&sort=fire&dir=asc&limit=200");
    el.innerHTML = dashScheduledHtml(sends);
    wireDashScheduledCards();
    paintAppliedNotice(sends);
    startCountdowns(); // re-arm the countdown ticker over the refreshed cards
  } catch {
    /* non-fatal — the scheduled section keeps its last render */
  }
}

// Controls shared by the Dashboard and the Getting-started view: hash navigation,
// "New post", "Add subscriber", and copy buttons.
function wireDashActions(root, reload) {
  root.querySelectorAll("[data-nav]").forEach((b) => {
    b.onclick = () => {
      location.hash = b.dataset.nav;
    };
  });
  root.querySelectorAll("[data-act='new-post']").forEach((b) => {
    b.onclick = () => createNewPost(b);
  });
  root.querySelectorAll("[data-act='add-sub']").forEach((b) => {
    b.onclick = () => addSubscriberModal(reload);
  });
  root.querySelectorAll("[data-copy]").forEach((b) => {
    b.onclick = () => copyText(b.dataset.copy);
  });
}

// The onboarding checklist, shared by the first-run dashboard and Getting-started.
// The "API access" card. Two states: an invitation to connect Claude, or — once Claude
// (the `service` principal, SPEC §4) has edited here — a plain "Claude is connected" note.
// Shared by the populated dashboard and the first-run state (a card below the setup
// checklist), so the two can't drift; connecting an agent is optional, so this is never a
// required setup step. Typography-led with no base-URL field: the operator already knows
// their own origin (it's the Publication card's URL right beside this one), and the
// connect guide is where that URL is actually used.
function apiConnectCard(connected) {
  if (connected) {
    return `<div class="card pub-card">
    <p class="conn-status"><span class="conn-dot" aria-hidden="true"></span>Claude is connected.</p>
    <div class="pub-foot pub-links"><a href="#/reference">API reference →</a><a href="#/docs/connect-claude">Connection guide →</a></div>
  </div>`;
  }
  return `<div class="card pub-card">
    <p class="pub-note">Let Claude draft, proofread, and schedule your posts.</p>
    <p class="pub-cta"><a href="#/docs/connect-claude">Connect Claude →</a></p>
    <p class="pub-foot"><a href="#/reference">API reference →</a></p>
  </div>`;
}

function setupChecklistHtml(pub, deployment) {
  const subscribeUrl = `${deployment.appOrigin || location.origin}/subscribe`;
  return `<div class="card setup">
    <h2 class="setup-title">Set up your publication</h2>
    <ol class="setup-steps">
      <li><div class="setup-step-main"><strong>Name your publication</strong><span class="muted">Currently “${esc(pub.name)}”. Set the name, tagline, and brand in Settings.</span></div><button data-nav="#/settings">Settings</button></li>
      <li><div class="setup-step-main"><strong>Write your first post</strong><span class="muted">Draft a post in Markdown and preview it exactly as the email.</span></div><button class="primary" data-act="new-post">New post</button></li>
      <li><div class="setup-step-main"><strong>Confirm your sending domain</strong><span class="muted">SPF, DKIM, and DMARC on your From address — the setup guide walks through it.</span></div><button data-nav="#/docs">Docs</button></li>
      <li><div class="setup-step-main"><strong>Share your subscribe link</strong><code class="setup-url">${esc(subscribeUrl)}</code></div><button data-copy="${esc(subscribeUrl)}">Copy</button></li>
    </ol>
  </div>`;
}

export function confirmUnsubscribe(sub, onDone) {
  const m = modal(
    `<h3>Unsubscribe this subscriber?</h3><p class="hint">Removes <strong>${esc(sub.email)}</strong> from the send audience immediately. They can re-subscribe later through the double opt-in.</p><div class="actions"><button type="button" id="uCancel">Cancel</button><button type="button" class="danger" id="uGo">Unsubscribe</button></div>`,
  );
  m.el.querySelector("#uCancel").onclick = m.close;
  m.el.querySelector("#uGo").onclick = () =>
    busy(m.el.querySelector("#uGo"), "Unsubscribing…", async () => {
      try {
        await api(`/subscribers/${sub.id}/unsubscribe`, { method: "POST" });
        m.close();
        toast(`Unsubscribed ${sub.email}`);
        onDone?.();
      } catch (e) {
        toast(e.message);
      }
    });
}

// Boot: establish who we are before routing.
// - dev: no valid token yet → mint one from the dev-only endpoint (404 in prod).
// - a stored token can be stale (signed with an old dev secret, or expired). In dev
//   we recover silently — drop it, re-mint, probe once more — so a leftover token
//   never dead-ends the editor on "Session expired". In Access mode the dev endpoint
//   is absent, so re-minting is a no-op and we fall through to the re-login screen.
// - probe /api/whoami with redirect:"manual" so an Access edge bounce surfaces as
//   an opaque redirect (→ re-login) distinct from the app's own clean 401.
