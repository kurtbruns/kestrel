// Settings' Reader pages section: every page a reader can land on (SPEC §5), one at a
// time, as the Worker renders it for a reader, with the publication's saved identity and
// sample values under a Preview strip. The journeys and their states are shared/'s list;
// each page is `GET /api/reader-pages/:journey/:state`, framed so nothing on it acts.

import { pagePolicy } from "../../shared/page_policy";
import { READER_JOURNEYS, type ReaderJourneyId, readerPagePath } from "../../shared/reader_pages";
import { apiText } from "../api";
import { onAbort } from "../lifecycle";
import { $, $$ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";

/** What on a journey's pages follows the publisher, what they word, and what is fixed. */
const JOURNEY_NOTES: Record<ReaderJourneyId, Html> = {
  subscribe: html`Your name, tagline, and logo head each page; the words are Kestrel’s. The embeddable form in Ways to subscribe posts to these pages too.`,
  confirm: html`Your identity heads each page. You word the email that links here, under Confirmation email; these pages’ words are fixed, so what a reader agrees to can’t be edited away.`,
  unsubscribe: html`Your identity heads each page; the words are fixed, so leaving always reads the same. A mail client’s own Unsubscribe button leaves without a page.`,
  reading: html`Your identity heads each page, and a post page is your <a class="set-link" href="#/template">email template</a> around the post, as its web version shows it. Shown with sample posts.`,
};

/** The width a preview is framed at: the page as a reader's window shows it, or a phone. */
type PreviewWidth = "desktop" | "phone";

/** The section's markup, under the head the page builds for every section. */
export function readerPagesSection(head: Html): Html {
  return html`
    <section class="set-sec" id="readerPages">
      ${head}
      <p class="set-lede">Every page a reader can land on, shown with your publication’s identity and sample values by the same code that serves the real page. Nothing here is a setting, and nothing on a preview acts.</p>
      <div class="set-preview set-rp">
        <div class="set-preview-bar set-rp-bar">
          <div class="set-ce-modetog" id="rpJourneys" role="group" aria-label="Journey">
            ${READER_JOURNEYS.map(
              (j, i) =>
                html`<button type="button" class="set-ce-modebtn" data-journey="${j.id}" aria-pressed="${i === 0 ? "true" : "false"}">${j.label}</button>`,
            )}
          </div>
          <span class="set-wtog" id="rpWidth" role="group" aria-label="Preview width">
            <button type="button" class="wtog-btn" data-width="desktop" aria-pressed="true">Desktop</button>
            <button type="button" class="wtog-btn" data-width="phone" aria-pressed="false">Phone</button>
          </span>
        </div>
        <div class="set-rp-head">
          <span class="set-wtog" id="rpStates" role="group" aria-label="Page"></span>
          <p class="set-rp-note" id="rpNote"></p>
        </div>
        <div class="set-rp-stage" id="rpStage">
          <iframe class="set-rp-frame" id="rpFrame" sandbox="allow-same-origin" title="Reader page preview" scrolling="no"></iframe>
        </div>
        <p class="set-rp-error" id="rpError" role="alert" hidden></p>
      </div>
    </section>`;
}

/** A page's HTML as the frame holds it: under the policy a page carrying no form of its
 *  own would serve with (shared/page_policy.ts), so beside the sandbox no form submits. */
function framed(doc: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${pagePolicy("'none'", { framed: true })}">`;
  const head = /<head(\s[^>]*)?>/i;
  return head.test(doc) ? doc.replace(head, (tag) => tag + meta) : meta + doc;
}

/** The section's controls, once its markup is in the document. `refresh` re-reads the
 *  page shown, for after a save changes the identity it wears. */
export function mountReaderPages(root: HTMLElement, signal: AbortSignal): { refresh(): void } {
  const journeysEl = $("#rpJourneys", root);
  const statesEl = $("#rpStates", root);
  const widthEl = $("#rpWidth", root);
  const noteEl = $("#rpNote", root);
  const stage = $("#rpStage", root);
  const frame = $<HTMLIFrameElement>("#rpFrame", root);
  const errorEl = $("#rpError", root);

  let journey: ReaderJourneyId = READER_JOURNEYS[0].id;
  // Each journey keeps the state last picked in it, so switching back returns to it.
  const picked = new Map<ReaderJourneyId, string>(
    READER_JOURNEYS.map((j) => [j.id, j.states[0].id]),
  );
  let width: PreviewWidth = "desktop";
  // Only the latest read paints: a slow one answered after a later click is dropped.
  let seq = 0;
  let watch: ResizeObserver | null = null;
  onAbort(signal, () => watch?.disconnect());

  const press = (group: HTMLElement, attr: string, value: string) => {
    for (const b of $$<HTMLButtonElement>("button", group)) {
      b.setAttribute("aria-pressed", String(b.dataset[attr] === value));
    }
  };

  const paintStates = () => {
    const j = READER_JOURNEYS.find((x) => x.id === journey) ?? READER_JOURNEYS[0];
    const current = picked.get(j.id);
    setHtml(
      statesEl,
      html`${j.states.map(
        (s) =>
          html`<button type="button" class="wtog-btn" data-state="${s.id}" aria-pressed="${s.id === current ? "true" : "false"}">${s.label}</button>`,
      )}`,
    );
    setHtml(noteEl, JOURNEY_NOTES[j.id]);
  };

  const fitHeight = () => {
    const h = frame.contentDocument?.body?.scrollHeight;
    if (h) {
      frame.style.height = `${h}px`;
    }
  };

  const load = async () => {
    const mine = ++seq;
    const state = picked.get(journey) ?? "";
    try {
      const doc = await apiText(readerPagePath(journey, state), { signal });
      if (mine !== seq || signal.aborted) {
        return;
      }
      errorEl.hidden = true;
      frame.srcdoc = framed(doc);
    } catch (e) {
      if (mine !== seq || signal.aborted) {
        return;
      }
      errorEl.textContent = `Couldn’t load this page: ${e instanceof Error ? e.message : String(e)}`;
      errorEl.hidden = false;
    }
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

  journeysEl.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-journey]");
    const id = READER_JOURNEYS.find((j) => j.id === b?.dataset.journey)?.id;
    if (!id || id === journey) {
      return;
    }
    journey = id;
    press(journeysEl, "journey", id);
    paintStates();
    void load();
  });
  statesEl.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-state]");
    const id = b?.dataset.state;
    if (!id || id === picked.get(journey)) {
      return;
    }
    picked.set(journey, id);
    press(statesEl, "state", id);
    void load();
  });
  widthEl.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("button[data-width]");
    const w = b?.dataset.width;
    if ((w !== "desktop" && w !== "phone") || w === width) {
      return;
    }
    width = w;
    press(widthEl, "width", w);
    stage.classList.toggle("phone", w === "phone");
  });

  paintStates();
  void load();
  return { refresh: () => void load() };
}
