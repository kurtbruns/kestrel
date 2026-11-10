// Settings' Time zone section (SPEC §9): the clock the publication's readers keep, which it
// can't schedule or send without. It saves with its own button, never through the save bar,
// so the browser's zone it suggests is saved only by a click on that button, and no other
// save carries it along.

import type { SettingsSavedResponse } from "../../shared/settings";
import { resolveTimeZone, sameTimeZone, timeZoneLabel } from "../../shared/time_zone";
import { api } from "../api";
import { $ } from "../ui/dom";
import { type Html, html, setHtml } from "../ui/html";
import { icon } from "../ui/icons";
import { busy, fieldError, toast } from "../ui/widgets";
import { chip, message, type SectionHandle, type SettingsPage, secHead } from "./page";

/** The zone this browser is set to, as its runtime names it: a suggestion, never a value. */
export function browserTimeZone(): string | null {
  try {
    return resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/**
 * Every zone this browser knows, plus each zone the picker may show that isn't among them: the
 * one saved, which may have been set through the API, and the browser's own, which a browser
 * set to `UTC` reports though it isn't listed. A zone is matched by what it resolves to, never
 * its spelling, so an alias of a listed zone (`Asia/Calcutta` against `Asia/Kolkata`) is that
 * zone and never appears twice. The list holds each zone under the name this engine resolves
 * it to, so a shown zone is looked up by its resolved name rather than by resolving all of them.
 */
export function zoneChoices(shown: (string | null)[]): string[] {
  const listed =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const extra: string[] = [];
  for (const zone of shown) {
    if (zone !== null && choiceFor([...extra, ...listed], zone) === null) {
      extra.push(zone);
    }
  }
  return [...extra, ...listed];
}

/** The listed zone that is the zone given, under whichever name this browser lists it. */
function choiceFor(choices: string[], zone: string | null): string | null {
  if (zone === null) {
    return null;
  }
  const resolved = resolveTimeZone(zone);
  return choices.find((z) => z === zone || z === resolved) ?? null;
}

/** An option's words: the zone's place, and once `long`, its long name ("Eastern Time"). */
function optionLabel(zone: string, long: boolean): string {
  const place = zone.replace(/_/g, " ");
  return long ? `${place} (${timeZoneLabel(zone)})` : place;
}

/** The line under the picker: what is saved, or, while nothing is, that the picker holds
 *  only a suggestion and that sending waits for a save. */
function statusHtml(savedLabel: string | null, suggested: string | null): Html {
  if (savedLabel !== null) {
    // The server's label, so the editor and Claude name the zone alike.
    return html`Set to ${savedLabel}.`;
  }
  return html`<strong>No time zone set yet</strong>, so nothing can be scheduled or sent.${
    suggested
      ? html` ${timeZoneLabel(suggested)} is this browser’s; nothing is saved until you click Save time zone.`
      : null
  }`;
}

/**
 * What the picker lists and opens on: the saved zone, else the browser's as a suggestion, else
 * nothing chosen. The browser's zone is offered only when it is one the server takes by the
 * same rule (`resolveTimeZone`: a name its `Intl` knows, never a bare offset), so a zone the
 * save would refuse is never put forward.
 */
function picker(saved: string | null): { choices: string[]; selected: string | null } {
  const suggested = saved === null ? browserTimeZone() : null;
  const choices = zoneChoices([saved, suggested]);
  return { choices, selected: choiceFor(choices, saved) ?? choiceFor(choices, suggested) };
}

export function timeZoneSection(page: SettingsPage): Html {
  const saved = page.data.settings.time_zone;
  const { choices, selected } = picker(saved);
  return html`
    <section class="set-sec">
      ${secHead("time-zone", chip("editable", "Editable"))}
      <p class="set-lede">Used for the times you schedule posts at, the dates on your published posts, and the times in your notifications. Needed before your first send. Choose where your readers are, not where you are today.</p>
      <div class="set-card">
        <div class="set-recip">
          <div class="set-field">
            <label for="tzSelect">Publication time zone</label>
            <div class="row set-tz-row"><select id="tzSelect">${
              selected === null
                ? html`<option value="" selected disabled>Choose a time zone</option>`
                : null
            }${choices.map(
              // Only the chosen option is named in full up front: building every zone's long
              // name costs a formatter each, hundreds of them, so the rest are named once the
              // picker is first reached for (mountTimeZone).
              (z) =>
                html`<option value="${z}"${z === selected ? html` selected` : null}>${optionLabel(z, z === selected)}</option>`,
            )}</select><button type="button" id="tzSave">Save time zone</button></div>
            <p class="field-hint set-tz-status" id="tzStatus">${statusHtml(page.data.settings.time_zone_label, saved === null ? selected : null)}</p>
          </div>
        </div>
        <div class="set-note" id="tzReadings" hidden></div>
        <div class="set-note">${icon("info")}<span>Changing it never moves a scheduled post: each keeps its moment, and you’re told how it now reads. Dates on published posts follow the new zone, so a post sent near midnight may show a different date. A zone’s rules come from the server, which can trail a recent government change by months.</span></div>
      </div>
    </section>`;
}

/** Wire the picker and its button. The button saves exactly what the picker shows, and only
 *  when that differs from what is saved, by zone rather than by name. */
export function mountTimeZone(
  root: HTMLElement,
  page: SettingsPage,
  signal: AbortSignal,
): SectionHandle {
  let saved = page.data.settings.time_zone;
  const select = $<HTMLSelectElement>("#tzSelect", root);
  const save = $<HTMLButtonElement>("#tzSave", root);
  const status = $("#tzStatus", root);
  const readings = $("#tzReadings", root);
  // Chosen here as well as marked in the markup, so the picker shows it however the
  // document applied the mark.
  select.value = picker(saved).selected ?? "";
  // Nothing to save until a zone is chosen, or while the one chosen is the one saved.
  // Every option's long name, once: in the browser's first idle moment after the page paints,
  // or the first time the picker is reached for, by pointer or keyboard, if that comes sooner.
  let named = false;
  const nameAll = () => {
    if (named || signal.aborted) {
      return;
    }
    named = true;
    for (const option of select.options) {
      if (option.value) {
        option.textContent = optionLabel(option.value, true);
      }
    }
  };
  for (const type of ["pointerdown", "focus"]) {
    select.addEventListener(type, nameAll, { once: true, signal });
  }
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(nameAll, { timeout: 2000 });
  }
  const paint = () => {
    save.disabled = select.value === "" || (saved !== null && sameTimeZone(select.value, saved));
  };
  select.onchange = () => {
    readings.hidden = true;
    paint();
  };
  save.onclick = async () => {
    await busy(save, "Saving…", async () => {
      try {
        // A write never takes the view's signal: a save the publisher started lands.
        const r = await api<SettingsSavedResponse>("/api/settings", {
          method: "PUT",
          json: { time_zone: select.value },
        });
        saved = r.settings.time_zone;
        page.applySaved(r.settings);
        setHtml(status, statusHtml(r.settings.time_zone_label, null));
        if (r.time_zone_readings.length) {
          setHtml(
            readings,
            html`${icon("info")}<span>${r.time_zone_readings.map((line, i) => html`${i ? " " : null}${line}`)}</span>`,
          );
          readings.hidden = false;
        } else {
          readings.hidden = true;
        }
        toast(`Time zone saved: ${r.settings.time_zone_label ?? select.value}.`);
      } catch (e) {
        // A refused zone says why under the row, and goes when another is picked.
        fieldError(select, message(e), { after: select.parentElement ?? select });
      }
    });
    // After busy, which re-enables the button on its way out: disabled again when the picker
    // now shows what is saved.
    paint();
  };
  paint();
  return {};
}
