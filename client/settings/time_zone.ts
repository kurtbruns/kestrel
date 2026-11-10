// Settings' Time zone section (SPEC §9): the clock the publication's readers keep, which it
// can't schedule or send without. A zone is chosen, from the browser's own (offered while none
// is saved or chosen) or by searching, and the choice waits for the save bar like a typed edit. Nothing
// is chosen until the publisher picks: the browser's zone is offered, never filled in, so no
// save carries a zone nobody chose.

import type { SendView } from "../../shared/sends";
import {
  formatClockTime,
  formatDayInTimeZone,
  formatInTimeZone,
  resolveTimeZone,
  sameTimeZone,
  timeZoneLabel,
} from "../../shared/time_zone";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { chip, type SectionHandle, type SettingsPage, secHead } from "./page";
import { markedRuns, searchZones, type ZoneChoice, zoneChoice, zoneChoices } from "./zone_search";

/** The zone this browser is set to, when it is one the server takes by the same rule
 *  (`resolveTimeZone`: a name its `Intl` knows, never a bare offset); null otherwise, so a zone
 *  the save would refuse is never offered. */
export function browserTimeZone(): string | null {
  try {
    return resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/** Whether `chosen` is a change from `saved`: a zone, and not the saved zone under any name. */
export function timeZoneChanged(chosen: string | null, saved: string | null): boolean {
  return chosen !== null && !sameTimeZone(chosen, saved);
}

/** One scheduled post in the preview: its subject, and how its fire time reads. */
export interface PreviewLine {
  subject: string;
  /** On the saved zone's clock, "Thu Nov 12, 9:18 AM Pacific Time"; null when none is saved. */
  from: string | null;
  /** On the chosen zone's clock: the day only when it differs from `from`'s. */
  to: string;
}

/**
 * How saving `to` in place of `from` will show each scheduled post that hasn't gone out yet
 * (SPEC §9): every one when no zone is saved, else only those whose time reads differently.
 * The editor's own arithmetic from the sends Settings already reads, so it needs no request.
 */
export function zoneChangePreview(
  sends: Pick<SendView, "subject" | "fire_at" | "status">[],
  from: string | null,
  to: string,
  now = Date.now(),
): PreviewLine[] {
  const lines: PreviewLine[] = [];
  for (const s of sends) {
    if (s.status !== "scheduled" || s.fire_at <= now) {
      continue;
    }
    if (from === null) {
      lines.push({ subject: s.subject, from: null, to: formatInTimeZone(s.fire_at, to, now) });
      continue;
    }
    const sameDay =
      formatDayInTimeZone(s.fire_at, to, now) === formatDayInTimeZone(s.fire_at, from, now);
    if (sameDay && formatClockTime(s.fire_at, from) === formatClockTime(s.fire_at, to)) {
      continue; // reads the same on both clocks
    }
    const clock = `${formatClockTime(s.fire_at, to)} ${timeZoneLabel(to)}`;
    lines.push({
      subject: s.subject,
      from: formatInTimeZone(s.fire_at, from, now),
      to: sameDay ? clock : `${formatDayInTimeZone(s.fire_at, to, now)}, ${clock}`,
    });
  }
  return lines;
}

/** The preview's markup, or nothing when no scheduled post reads differently. */
function previewHtml(lines: PreviewLine[]): Html | null {
  if (lines.length === 0) {
    return null;
  }
  const one = lines.length === 1;
  const changing = lines[0]?.from !== null;
  return html`<div class="set-tz-preview" role="status">${
    changing
      ? html`<p class="set-tz-preview-head">Your scheduled ${one ? "post still goes" : "posts still go"} out at the same moment. The time displayed will change:</p>`
      : null
  }<ul>${lines.map(
    (l) =>
      html`<li><strong>“${l.subject}”</strong>: ${l.from === null ? html`goes out ${l.to}` : html`${l.from} → ${l.to}`}</li>`,
  )}</ul></div>`;
}

/** The time on a zone's clock now, "8:50 AM": the quickest check that it's the right clock. */
const nowIn = (zone: string) => formatClockTime(Date.now(), zone);

/** Text with what the query matched marked. */
function marked(text: string, query: string): Html[] {
  return markedRuns(text, query).map((r) =>
    r.marked ? html`<mark>${r.text}</mark>` : html`${r.text}`,
  );
}

/** A zone's two lines, as a result row and the chosen zone show it. */
function zoneLines(c: ZoneChoice, query = ""): Html {
  return html`<span class="set-tz-name">${marked(c.label, query)}</span><span class="set-tz-place">${marked(c.place, query)} · ${marked(c.offset, query)}${
    c.abbreviation ? html` · ${marked(c.abbreviation, query)}` : null
  }</span>`;
}

export function timeZoneSection(_page: SettingsPage): Html {
  return html`
    <section class="set-sec">
      ${secHead("time-zone", chip("editable", "Editable"))}
      <p class="set-lede">Used for the times you schedule posts at, the dates on your published posts, and the times in your notifications. Needed before your first send. Choose where your readers are, not where you are today.</p>
      <div class="set-card">
        <div class="set-recip">
          <div class="set-field set-tz">
            <label for="tzSearch">Publication time zone</label>
            <div id="tzChosen" role="status" aria-live="polite"></div>
            <div id="tzPreview"></div>
            <div id="tzSuggest"></div>
            <div class="set-tz-combo">
              <input type="search" id="tzSearch" placeholder="Search a city or zone name" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" aria-controls="tzResults" aria-autocomplete="list">
              <ul class="set-tz-results" id="tzResults" role="listbox" aria-label="Matching time zones" hidden></ul>
              <p class="set-tz-none" id="tzNone" role="status" hidden>No zone matches. Try a nearby city, or the zone’s name.</p>
            </div>
          </div>
        </div>
        <div class="set-note">${icon("info")}<span>Changing it never moves a scheduled post, only how its time is displayed.</span></div>
      </div>
    </section>`;
}

/**
 * Wire the section. The choice is `page.state.timeZone`, against the saved one in
 * `page.saved()`; the save bar commits it with the page's other edits, and Discard puts it back.
 * While nothing is saved or chosen, the browser's zone is offered between the warning and the
 * search. A choice, from Use or the search, is the act the offer asks for, so the offer goes
 * with it, and Discard brings it back. Once a zone is saved it is never offered: a browser on
 * another clock is most often a publisher traveling.
 */
export function mountTimeZone(
  root: HTMLElement,
  page: SettingsPage,
  signal: AbortSignal,
): SectionHandle {
  const browser = browserTimeZone();
  const chosenEl = $("#tzChosen", root);
  const suggestEl = $("#tzSuggest", root);
  const input = $<HTMLInputElement>("#tzSearch", root);
  const list = $<HTMLUListElement>("#tzResults", root);
  const previewEl = $("#tzPreview", root);

  // Every zone, built once, in the browser's first idle moment or when the search is first
  // used: hundreds of zones, each named by formatters of its own. The saved zone and the
  // browser's are listed even when the browser's own list leaves them out.
  let choices: ZoneChoice[] | null = null;
  const allChoices = () => {
    choices ??= zoneChoices([page.saved().timeZone, browser]);
    return choices;
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(
      () => {
        if (!signal.aborted) {
          allChoices();
        }
      },
      { timeout: 2000 },
    );
  }

  const choose = (zone: string) => {
    page.state.timeZone = zone;
    page.changed(); // repaints this section through its handle, and raises the bar
  };

  const paint = () => {
    const shown = page.state.timeZone;
    const saved = page.saved().timeZone;
    setHtml(
      chosenEl,
      shown === null
        ? html`<p class="set-tz-unset">No time zone set yet, so nothing can be scheduled or sent.</p>`
        : html`<div class="set-tz-chosen"><div class="set-tz-lines">${zoneLines(zoneChoice(shown))}</div><span class="set-tz-now">${nowIn(shown)} there</span></div>`,
    );
    // What saving the choice will show for each scheduled post, while it is unsaved.
    setHtml(
      previewEl,
      html`${
        shown !== null && timeZoneChanged(shown, saved)
          ? previewHtml(zoneChangePreview(page.data.in_use.sends, saved, shown))
          : null
      }`,
    );
    if (saved === null && shown === null && browser !== null) {
      const b = zoneChoice(browser);
      setHtml(
        suggestEl,
        html`<div class="set-tz-suggest"><div class="set-tz-lines"><span>This browser is on <strong>${b.label}</strong></span><span class="set-tz-place">${b.place} · ${nowIn(browser)} there now</span></div><button type="button" id="tzUse">Use ${b.label}</button></div>`,
      );
      $<HTMLButtonElement>("#tzUse", suggestEl).onclick = () => {
        choose(browser);
        // The button goes with the repaint, so focus goes on to the search rather than
        // falling back to the top of the page.
        input.focus();
      };
    } else {
      setHtml(suggestEl, html``);
    }
  };

  // The search: a combobox over the zones, its active row moved by the arrow keys.
  let results: ZoneChoice[] = [];
  let active = -1;
  const none = $("#tzNone", root);
  const close = () => {
    list.hidden = true;
    none.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  };
  const renderResults = () => {
    const query = input.value;
    if (!query.trim()) {
      results = [];
      close();
      return;
    }
    results = searchZones(allChoices(), query, { near: browser ?? page.saved().timeZone });
    active = results.length ? Math.max(0, Math.min(active, results.length - 1)) : -1;
    // No match is said as a status beside the list, never as a row that can't be chosen.
    none.hidden = results.length > 0;
    if (results.length === 0) {
      setHtml(list, html``);
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      return;
    }
    setHtml(
      list,
      html`${results.map(
        (c, i) =>
          html`<li role="option" id="tzOpt${String(i)}" data-i="${String(i)}" aria-selected="${i === active ? "true" : "false"}"><span class="set-tz-lines">${zoneLines(c, query)}</span><span class="set-tz-now">${nowIn(c.zone)}</span></li>`,
      )}`,
    );
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", `tzOpt${active}`);
    // The arrow keys move past the list's fold: keep the active row in sight.
    list.querySelector(`#tzOpt${active}`)?.scrollIntoView({ block: "nearest" });
  };
  const take = (i: number) => {
    const c = results[i];
    if (!c) {
      return;
    }
    input.value = "";
    close();
    choose(c.zone);
  };
  input.addEventListener(
    "input",
    () => {
      active = 0;
      renderResults();
    },
    { signal },
  );
  input.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        const step = ev.key === "ArrowDown" ? 1 : -1;
        active = Math.max(0, Math.min(results.length - 1, active + step));
        renderResults();
        ev.preventDefault();
      } else if (ev.key === "Enter") {
        take(active);
        ev.preventDefault();
      } else if (ev.key === "Escape" && !list.hidden) {
        input.value = "";
        close();
        ev.preventDefault();
      }
    },
    { signal },
  );
  input.addEventListener("blur", close, { signal });
  // Taken on mousedown, before the field's blur closes the list under the pointer.
  list.addEventListener(
    "mousedown",
    (ev) => {
      const row =
        ev.target instanceof Element ? ev.target.closest<HTMLElement>("li[data-i]") : null;
      if (row) {
        ev.preventDefault();
        take(Number(row.dataset.i));
      }
    },
    { signal },
  );

  paint();
  return {
    repaint: paint,
    reset() {
      // After a save, the saved zone joins the search if the browser doesn't list it.
      choices = null;
      paint();
    },
  };
}
