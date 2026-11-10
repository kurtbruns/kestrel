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

/** Every zone this browser knows, plus the one saved, which may not be among them: one set
 *  through the API (`UTC`, or an alias such as `Asia/Calcutta`). An alias of a listed zone
 *  is that zone, so it never appears twice. */
export function zoneChoices(saved: string | null): string[] {
  const listed =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  if (saved === null || listed.some((z) => sameTimeZone(z, saved))) {
    return listed;
  }
  return [saved, ...listed];
}

/** The listed zone that is the zone given, under whichever name this browser lists it. */
function choiceFor(choices: string[], zone: string | null): string | null {
  return zone === null ? null : (choices.find((z) => sameTimeZone(z, zone)) ?? null);
}

function optionLabel(zone: string): string {
  return `${zone.replace(/_/g, " ")} (${timeZoneLabel(zone)})`;
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

/** What the picker opens on: the saved zone, else the browser's as a suggestion. */
function initialChoice(choices: string[], saved: string | null): string | null {
  return choiceFor(choices, saved) ?? choiceFor(choices, browserTimeZone());
}

export function timeZoneSection(page: SettingsPage): Html {
  const saved = page.data.settings.time_zone;
  const choices = zoneChoices(saved);
  const selected = initialChoice(choices, saved);
  return html`
    <section class="set-sec">
      ${secHead("time-zone", chip("editable", "Editable"))}
      <p class="set-lede">Used for the times you schedule posts at, the dates on your published posts, and the times in your notifications. Needed before your first send. Choose where your readers are, not where you are today.</p>
      <div class="set-card">
        <div class="set-recip">
          <div class="set-field">
            <label for="tzSelect">Publication time zone</label>
            <div class="row set-tz-row"><select id="tzSelect">${choices.map(
              (z) =>
                html`<option value="${z}"${z === selected ? html` selected` : null}>${optionLabel(z)}</option>`,
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
  _signal: AbortSignal,
): SectionHandle {
  let saved = page.data.settings.time_zone;
  const select = $<HTMLSelectElement>("#tzSelect", root);
  const save = $<HTMLButtonElement>("#tzSave", root);
  const status = $("#tzStatus", root);
  const readings = $("#tzReadings", root);
  // Chosen here as well as marked in the markup, so the picker shows it however the
  // document applied the mark.
  select.value = initialChoice(zoneChoices(saved), saved) ?? select.value;
  const paint = () => {
    save.disabled = saved !== null && sameTimeZone(select.value, saved);
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
