// Settings' Reader pages section: every page a reader can land on (SPEC §5), as an outline
// beside one framed page. The journeys are the outline's headings and never controls, and
// the pages are its rows, so the two levels can't be mistaken for each other and every
// page is in view, the hard-to-reach ones included. A narrow card folds the outline into
// one grouped select. The journeys and their pages are shared/'s list; each page is
// `GET /api/reader-pages/:journey/:state`, exactly as a reader gets it, framed so nothing
// on it acts.

import {
  READER_JOURNEYS,
  type ReaderJourney,
  type ReaderJourneyId,
  type ReaderPageAddress,
  type ReaderPageState,
  readerPagePath,
} from "../../shared/reader_pages";
import type { DeploymentView } from "../../shared/settings";
import { apiText } from "../api";
import { onAbort } from "../lifecycle";
import { $, $$ } from "../ui/dom";
import { framedCopy } from "../ui/email_frame";
import { type Html, html, setHtml } from "../ui/html";
import { type IconName, icon } from "../ui/icons";

/** What on a journey's pages follows the publisher, what they word, and what is fixed. */
const JOURNEY_NOTES: Record<ReaderJourneyId, Html> = {
  subscribe: html`Your name, tagline, and logo head each page; the words are Kestrel’s. The embeddable form in Ways to subscribe posts to these pages too.`,
  confirm: html`Your identity heads each page. You word the email that links here, under Confirmation email; these pages’ words are fixed, so what a reader agrees to can’t be edited away.`,
  unsubscribe: html`Your identity heads each page; the words are fixed, so leaving always reads the same. A mail client’s own Unsubscribe button leaves without a page.`,
  reading: html`Your identity heads each page, and a post page is your <a class="set-link" href="#/template">email template</a> around the post, as its web version shows it. Where a page lists posts, they are samples.`,
};

const JOURNEY_ICONS: Record<ReaderJourneyId, IconName> = {
  subscribe: "mail",
  confirm: "circle-check",
  unsubscribe: "circle-minus",
  reading: "book",
};

/** The width a preview is framed at: the page as a reader's window shows it, or a phone. */
type PreviewWidth = "desktop" | "phone";

/** One row of the outline: a step's number, a peer's dot, or an off-path page's branch. */
function outlineRow(j: ReaderJourney, s: ReaderPageState, mark: Html | string): Html {
  return html`<li><button type="button" class="set-rp-item${s.offPath ? " off" : ""}" data-journey="${j.id}" data-state="${s.id}" aria-current="false"><span class="set-rp-mark" aria-hidden="true">${mark}</span>${s.label}</button></li>`;
}

/** The outline: each journey a heading over its main-path pages, then the ones off it.
 *  A thread joins a journey's steps; peers carry a dot, not a number. The off-path pages
 *  are a list of their own, so the thread ends at the last step and never runs behind
 *  a page a reader reaches only when something goes wrong. */
function outline(): Html {
  return html`${READER_JOURNEYS.map((j) => {
    const states: readonly ReaderPageState[] = j.states;
    const steps = j.flow === "steps";
    return html`<div class="set-rp-journey" data-journey="${j.id}">
      <h3 class="set-rp-jhead" id="rpJourney-${j.id}">${icon(JOURNEY_ICONS[j.id])}${j.label}</h3>
      <ul class="set-rp-list${steps ? " steps" : ""}" aria-labelledby="rpJourney-${j.id}">
        ${states.filter((s) => !s.offPath).map((s, i) => outlineRow(j, s, steps ? String(i + 1) : "·"))}
      </ul>
      <ul class="set-rp-list" aria-label="${j.label}, off the main path">
        ${states.filter((s) => s.offPath).map((s) => outlineRow(j, s, icon("branch")))}
      </ul>
    </div>`;
  })}`;
}

/** The outline as one select, for a card too narrow for it: a group per journey, its
 *  steps numbered as the outline numbers them. An off-path page carries no mark: a branch
 *  glyph alone in an option's text reads as a stray character, not as "off the path",
 *  and these pages' names already say what went wrong. */
function picker(): Html {
  return html`<select id="rpSelect" aria-label="Reader page">${READER_JOURNEYS.map((j) => {
    const states: readonly ReaderPageState[] = j.states;
    let step = 0;
    return html`<optgroup label="${j.label}">${states.map((s) => {
      const n = j.flow === "steps" && !s.offPath ? `${++step}. ` : "";
      return html`<option value="${j.id}/${s.id}">${n}${s.label}</option>`;
    })}</optgroup>`;
  })}</select>`;
}

/** The section's markup, under the head the page builds for every section. */
export function readerPagesSection(head: Html): Html {
  return html`
    <section class="set-sec set-rp-sec" id="readerPages">
      ${head}
      <p class="set-lede">Every page a reader can land on, exactly as they see it, with your publication’s identity and sample values. Nothing here changes a page; it shows the ones that are hard to reach by hand.</p>
      <div class="set-card set-rp">
        <nav class="set-rp-nav" aria-label="Reader pages">${outline()}</nav>
        <div class="set-rp-pick">${picker()}</div>
        <div class="set-rp-main">
          <div class="set-rp-top">
            <div>
              <p class="set-rp-crumb"><span class="set-rp-crumb-j" id="rpJourney"></span><span class="set-rp-crumb-sep">/</span><span id="rpState"></span></p>
              <p class="set-rp-note" id="rpNote"></p>
            </div>
            <span class="set-wtog" id="rpWidth" role="group" aria-label="Preview width">
              <button type="button" class="wtog-btn" data-width="desktop" aria-pressed="true">${icon("desktop")}Desktop</button>
              <button type="button" class="wtog-btn" data-width="phone" aria-pressed="false">${icon("phone")}Phone</button>
            </span>
          </div>
          <div class="set-rp-at"><span class="mono" id="rpAt"></span><span>Sample · links and forms do nothing</span></div>
          <p class="set-rp-error" id="rpError" role="alert" hidden></p>
          <div class="set-rp-stage" id="rpStage">
            <iframe class="set-rp-frame" id="rpFrame" sandbox="allow-same-origin" title="Reader page preview" scrolling="no"></iframe>
          </div>
        </div>
      </div>
    </section>`;
}

/** Where a reader meets a page on this deployment, as the address line shows it: without
 *  its scheme, which says nothing to a publisher. */
export function readerPageAddress(at: ReaderPageAddress, d: DeploymentView): string {
  const base = at.base === "app" ? d.appOrigin : `${d.archiveOrigin}${d.archiveBasePath}`;
  return `${base}${at.path}`.replace(/^https?:\/\//, "");
}

/** The section's controls, once its markup is in the document. `refresh` re-reads the
 *  page shown, for after any save, since one may have changed the identity it wears. */
export function mountReaderPages(
  root: HTMLElement,
  deployment: DeploymentView,
  signal: AbortSignal,
): { refresh(): void } {
  const nav = $(".set-rp-nav", root);
  const select = $<HTMLSelectElement>("#rpSelect", root);
  const widthEl = $("#rpWidth", root);
  const stage = $("#rpStage", root);
  const frame = $<HTMLIFrameElement>("#rpFrame", root);
  const errorEl = $("#rpError", root);

  let journey: ReaderJourney = READER_JOURNEYS[0];
  let state: ReaderPageState = journey.states[0];
  let width: PreviewWidth = "desktop";
  // Only the latest read paints: a slow one answered after a later click is dropped.
  let seq = 0;
  let watch: ResizeObserver | null = null;
  onAbort(signal, () => watch?.disconnect());

  const paintChoice = () => {
    for (const b of $$<HTMLButtonElement>(".set-rp-item", nav)) {
      const on = b.dataset.journey === journey.id && b.dataset.state === state.id;
      b.setAttribute("aria-current", on ? "true" : "false");
    }
    for (const g of $$(".set-rp-journey", nav)) {
      g.classList.toggle("current", g.dataset.journey === journey.id);
    }
    select.value = `${journey.id}/${state.id}`;
    $("#rpJourney", root).textContent = journey.label;
    $("#rpState", root).textContent = state.label;
    setHtml($("#rpNote", root), JOURNEY_NOTES[journey.id]);
    $("#rpAt", root).textContent = readerPageAddress(state.at, deployment);
  };

  const fitHeight = () => {
    const h = frame.contentDocument?.body?.scrollHeight;
    if (h) {
      frame.style.height = `${h}px`;
    }
  };

  const load = async () => {
    const mine = ++seq;
    try {
      const doc = await apiText(readerPagePath(journey.id, state.id), { signal });
      if (mine !== seq || signal.aborted) {
        return;
      }
      errorEl.hidden = true;
      stage.hidden = false;
      // Under the policy a page that submits no form carries, so beside the sandbox no
      // form on it submits (ui/email_frame.ts).
      frame.srcdoc = framedCopy(doc);
    } catch (e) {
      if (mine !== seq || signal.aborted) {
        return;
      }
      // The page named above is not the one the frame last held, so the frame empties
      // rather than show it under the wrong name, and the error takes its place.
      frame.srcdoc = "";
      stage.hidden = true;
      errorEl.textContent = `Couldn’t load this page: ${e instanceof Error ? e.message : String(e)}`;
      errorEl.hidden = false;
    }
  };

  const choose = (journeyId: string | undefined, stateId: string | undefined) => {
    const j = READER_JOURNEYS.find((x) => x.id === journeyId);
    const states: readonly ReaderPageState[] = j?.states ?? [];
    const s = states.find((x) => x.id === stateId);
    if (!j || !s || (j === journey && s === state)) {
      return;
    }
    journey = j;
    state = s;
    paintChoice();
    void load();
  };

  frame.onload = () => {
    const page = frame.contentDocument;
    if (!page || signal.aborted) {
      return;
    }
    // A preview shows a page; following a link would leave it for the real thing.
    page.addEventListener("click", (e) => {
      const target = e.target as Element | null;
      if (target?.closest?.("a[href], area[href]")) {
        e.preventDefault();
      }
    });
    // As tall as the page, so Settings scrolls it, and kept fitted as fonts, images,
    // and the width change it.
    watch?.disconnect();
    fitHeight();
    if (page.body && typeof ResizeObserver !== "undefined") {
      watch = new ResizeObserver(fitHeight);
      watch.observe(page.body);
    }
  };

  nav.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>(".set-rp-item");
    choose(b?.dataset.journey, b?.dataset.state);
  });
  select.addEventListener("change", () => {
    const [j, s] = select.value.split("/");
    choose(j, s);
  });
  widthEl.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-width]");
    const w = b?.dataset.width;
    if ((w !== "desktop" && w !== "phone") || w === width) {
      return;
    }
    width = w;
    for (const o of $$<HTMLButtonElement>("button", widthEl)) {
      o.setAttribute("aria-pressed", String(o.dataset.width === w));
    }
    stage.classList.toggle("phone", w === "phone");
  });

  paintChoice();
  void load();
  return { refresh: () => void load() };
}
