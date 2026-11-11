// The publication's time zone as the dashboard reads it (SPEC §9), from the settings fetched at
// boot: the clocks a screen shows its times on, and, while no zone is set, the standing lines the
// dashboard and the send dialogs carry, since nothing can be scheduled or sent until it is.

import { settingsRoute } from "../shared/settings";
import { clocksDiffer, resolveTimeZone, timeZoneLabel } from "../shared/time_zone";
import { providerNotConnected } from "./deployment";
import { appState } from "./state";
import { type Clocks, fmtAt } from "./ui/format";
import { type Html, html } from "./ui/html";

/** Settings' Time zone section, where every line about the unset zone points. */
export const TIME_ZONE_HREF = `#${settingsRoute("time-zone")}`;

/** True while the publication has no time zone. False until the settings have loaded, so
 *  nothing is said before the editor knows. */
export function timeZoneUnset(): boolean {
  return appState.appConfig?.settings?.time_zone === null;
}

/** The server's own words for the refusal, with Settings as the link. */
function setItHtml(): Html {
  return html`Set the publication’s time zone before scheduling or sending. It’s in <a href="${TIME_ZONE_HREF}">Settings</a>.`;
}

/**
 * The standing line the Schedule dialog carries when the server would refuse to schedule the
 * post for want of a time zone (DESIGN §4), in the not-connected line's place and style. It
 * reads the post's own `actions`, never the settings read at boot, which may be older than a
 * zone set since through the API or by Claude: while a provider is connected, a draft offered
 * no schedule is one waiting on the time zone. No email provider connected is the first thing
 * to fix, so while that line shows this one doesn't.
 */
export function noTimeZoneLine(canSchedule: boolean): Html | null {
  return !canSchedule && !providerNotConnected()
    ? html`<p class="hint not-connected no-time-zone">${setItHtml()}</p>`
    : null;
}

/** The dashboard health block's line while no time zone is set, once setup's own step no
 *  longer says it (DESIGN §3): everything but scheduling and sending still works. */
export function noTimeZoneHealthHtml(): Html {
  return html`<span class="dash-no-time-zone">No time zone set, so nothing can be scheduled or sent until it is. Set it in <a href="${TIME_ZONE_HREF}">Settings</a>.</span>`;
}

/** The zone this browser is set to, when it is one the server takes by the same rule
 *  (`resolveTimeZone`: a name its `Intl` knows, never a bare offset); null otherwise, so a zone
 *  the save would refuse is never offered or shown. */
export function browserTimeZone(): string | null {
  try {
    return resolveTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

/** The publication's zone, or null while none is set (or the settings haven't loaded). */
export function homeTimeZone(): string | null {
  const zone = appState.appConfig?.settings?.time_zone ?? null;
  return zone === null ? null : resolveTimeZone(zone);
}

/**
 * The clocks for a screen showing `moments` (DESIGN §10): times read on the publication's clock,
 * and the zone named, with upcoming times on a second clock, when the browser's clock reads any
 * of them, or now, differently. Decided by the clocks, never the zones' names, so Detroit on a
 * New York publication is home. With no zone set, the browser's clock, unlabeled, as before.
 */
export function clocksFor(moments: readonly (number | null | undefined)[] = []): Clocks {
  const browser = browserTimeZone() ?? "UTC";
  const home = homeTimeZone();
  if (home === null) {
    return { home: browser, browser, away: false, label: "" };
  }
  const times = [Date.now(), ...moments.filter((m): m is number => typeof m === "number")];
  return {
    home,
    browser,
    away: clocksDiffer(home, browser, times),
    label: appState.appConfig?.settings?.time_zone_label ?? timeZoneLabel(home),
  };
}

/** A past time standing on its own, on the publication's clock, with the zone after it when the
 *  browser's clock differs (DESIGN §10): "edited Nov 11, 1:40 AM Eastern Time". */
export function timeAt(ms: number | null | undefined): string {
  return fmtAt(ms, clocksFor([ms]));
}
