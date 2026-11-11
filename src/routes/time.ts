/**
 * The publication's time now (SPEC §6), and how a fire time would read, for a client working out
 * "Friday" or "tomorrow" on the publication's clock rather than its own, and for the editor's
 * picker to check a chosen time against the server's zone rules before anything is scheduled.
 * Authed. A read: it writes nothing and acts on nothing.
 */

import type { TimeResponse } from "../../shared/sends";
import { formatInTimeZone, readBack, timeZoneLabel } from "../../shared/time_zone";
import { readTimeZone } from "../db/settings";
import { json, refusal } from "../lib/errors";
import type { RequestContext } from "../router";
import { parseFireAtRequest, resolveFireAt } from "../send/fire_at";
import { TIME_ZONE_NOT_SET } from "../send/schedule";

export async function get(c: RequestContext): Promise<Response> {
  const now = Date.now();
  const zone = await readTimeZone(c.env.DB);
  const asked = c.url.searchParams.get("fire_at");
  const timeZone = c.url.searchParams.get("time_zone");
  let fireAt: number | null = null;
  if (asked !== null || timeZone !== null) {
    const request = parseFireAtRequest(asked ?? undefined, timeZone ?? undefined);
    // A local time on the publication's clock can't be read until it has one; a time that names
    // its own zone, or an exact moment, can.
    const clock = request.kind === "local" ? (request.zone ?? zone) : "UTC";
    if (clock === null) {
      throw refusal("time_zone_not_set", TIME_ZONE_NOT_SET);
    }
    fireAt = resolveFireAt(request, clock, now).at;
  }
  const body: TimeResponse = {
    now,
    time_zone: zone,
    time_zone_label: zone === null ? null : timeZoneLabel(zone, now),
    now_local: formatInTimeZone(now, zone ?? "UTC", now),
    fire_at: fireAt,
    read_back: fireAt === null ? null : readBack(fireAt, zone, now),
  };
  return json(body);
}
