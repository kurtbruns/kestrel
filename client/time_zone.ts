// Whether the publication has its time zone (SPEC §9), read from the settings fetched at boot,
// and the standing lines the dashboard and the send dialogs carry while it hasn't: nothing can
// be scheduled or sent until it is set, and the fix is always in Settings.

import { settingsRoute } from "../shared/settings";
import { providerNotConnected } from "./deployment";
import { appState } from "./state";
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
 * The standing line the Schedule and Edit schedule dialogs carry while no time zone is set
 * (DESIGN §4), in the not-connected line's place and style. No email provider connected is
 * the first thing to fix, so while that line shows this one doesn't.
 */
export function noTimeZoneLine(): Html | null {
  return timeZoneUnset() && !providerNotConnected()
    ? html`<p class="hint not-connected no-time-zone">${setItHtml()}</p>`
    : null;
}

/** The dashboard health block's line while no time zone is set, once setup's own step no
 *  longer says it (DESIGN §3): everything but scheduling and sending still works. */
export function noTimeZoneHealthHtml(): Html {
  return html`<span class="dash-no-time-zone">No time zone set, so nothing can be scheduled or sent until it is. Set it in <a href="${TIME_ZONE_HREF}">Settings</a>.</span>`;
}
