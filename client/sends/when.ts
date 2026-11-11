// The Send at picker both scheduling dialogs share (DESIGN §4): a time typed on the publication's
// clock, sent to the server as that local time, with the zone named and a second clock under it
// when the browser keeps another, and the server's own reading of it asked for as it changes, so
// a time a clock change skips is refused under the picker, and a browser whose zone rules differ
// from the server's says so, before anything is scheduled (SPEC §6).

import type { TimeResponse } from "../../shared/sends";
import { formatClockTime, parseLocalTime, readLocalTime } from "../../shared/time_zone";
import { ApiError, api, describeError } from "../api";
import { earliestFireAt } from "../deployment";
import { $ } from "../ui/dom";
import { type Clocks, fmtAt, secondClock, toLocalInput } from "../ui/format";
import { type Html, html } from "../ui/html";

/** How long the picker waits after the last change before asking the server. */
const ASK_AFTER_MS = 250;

/** The picker's markup: its label, the field, the zone beside it when the clocks differ, and the
 *  lines under it, which `mountWhen` fills. `value` is a moment, shown on the publication's clock. */
export function whenHtml(id: string, value: number, c: Clocks): Html {
  const min = toLocalInput(earliestFireAt().getTime(), c.home);
  return html`<label for="${id}">Send at</label><div class="when-field"><input type="datetime-local" id="${id}" min="${min}" value="${toLocalInput(value, c.home)}">${c.away ? html`<span class="when-zone">${c.label}</span>` : null}</div><p class="when-line" id="${id}Line" hidden></p><p class="when-warn" id="${id}Warn" hidden></p>`;
}

/** A mounted picker: the local time picked, and the moment it names as best known. */
export interface WhenPicker {
  /** The local time picked, as the server takes it (`2026-11-13T09:00`), or "" for none. */
  value(): string;
  /**
   * The moment the picked time names: the server's reading once it has answered for this value,
   * this browser's until then, null when it names none here (a clock change skips or repeats it,
   * which the server's refusal then says) or nothing is picked.
   */
  moment(): number | null;
}

/** Wire the picker `whenHtml` drew inside `box`, for the life of `signal`. */
export function mountWhen(
  box: HTMLElement,
  id: string,
  c: Clocks,
  signal: AbortSignal,
): WhenPicker {
  const input = $<HTMLInputElement>(`#${id}`, box);
  const line = $<HTMLElement>(`#${id}Line`, box);
  const warn = $<HTMLElement>(`#${id}Warn`, box);
  // The server's answer for one value, kept so `moment()` reads it once it has come.
  let answered: { value: string; at: number | null } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asking: AbortController | null = null;

  const browserMoment = (value: string): number | null => {
    const wall = parseLocalTime(value);
    if (wall === null) {
      return null;
    }
    const reading = readLocalTime(wall, c.home);
    return reading.kind === "exact" ? reading.at : null;
  };

  const say = (el: HTMLElement, text: string | null, refused = false) => {
    el.textContent = text ?? "";
    el.hidden = text === null;
    el.classList.toggle("when-refused", refused);
  };

  const paintSecond = (at: number | null) => say(line, at === null ? null : secondClock(at, c));

  async function ask(value: string) {
    asking?.abort();
    const ctl = new AbortController();
    asking = ctl;
    try {
      const r = await api<TimeResponse>(`/api/time?fire_at=${encodeURIComponent(value)}`, {
        signal: ctl.signal,
      });
      if (input.value !== value) {
        return;
      }
      answered = { value, at: r.fire_at };
      const mine = browserMoment(value);
      if (r.fire_at !== null) {
        paintSecond(r.fire_at);
        say(warn, mine === r.fire_at ? null : disagreement(r.fire_at, c));
      }
    } catch (e) {
      if (ctl.signal.aborted || input.value !== value) {
        return;
      }
      // A time the server can't read here, such as one a clock change skips: its words, under
      // the picker. Anything else (the network, a session lapse) the act itself will say.
      if (e instanceof ApiError && e.field === "fire_at") {
        answered = { value, at: null };
        say(warn, null);
        say(line, describeError(e), true);
      }
    }
  }

  const changed = () => {
    const value = input.value;
    answered = null;
    say(warn, null);
    paintSecond(browserMoment(value));
    clearTimeout(timer);
    if (value) {
      timer = setTimeout(() => void ask(value), ASK_AFTER_MS);
    }
  };
  input.addEventListener("input", changed, { signal });
  input.addEventListener("change", changed, { signal });
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      asking?.abort();
    },
    { once: true },
  );
  changed();

  return {
    value: () => input.value,
    moment: () =>
      answered !== null && answered.value === input.value
        ? answered.at
        : browserMoment(input.value),
  };
}

/**
 * The warning when this browser's zone rules and the server's read the picked time as different
 * moments (SPEC §6): said beside the reading, never blocking, naming which clock the send keeps.
 * It usually means the zone's rules changed recently and one of the two hasn't caught up.
 */
function disagreement(serverAt: number, c: Clocks): string {
  return `This browser and the server disagree about ${c.label || "this zone"}’s clock on that date, which usually means its rules changed recently. The send goes out by the server’s clock, at the moment this browser reads as ${formatClockTime(serverAt, c.home)}.`;
}

/**
 * A scheduled time as the toast after an act says it: on the publication's clock, with the zone
 * and the browser's own clock when the two differ, "Fri Nov 13, 9:00 AM Eastern Time (Fri 11:00
 * PM your time · Japan Standard Time)", and "Fri Nov 13, 9:00 AM" at home.
 */
export function scheduledText(at: number, c: Clocks): string {
  const second = secondClock(at, c);
  return second ? `${fmtAt(at, c, true)} (${second})` : fmtAt(at, c, true);
}

/** A time that can still be acted on, on the browser's clock, as the line under it, or nothing
 *  at home (DESIGN §10). */
export function secondClockHtml(at: number, c: Clocks): Html | null {
  const second = secondClock(at, c);
  return second ? html`<div class="second-clock">${second}</div>` : null;
}
