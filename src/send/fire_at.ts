/**
 * Reading a requested fire time (SPEC §6): the three forms `fire_at` takes, and the moment each
 * names. A local time with no offset is the publication's clock, a local time with `time_zone`
 * is that place's, and a time ending in `Z` or epoch milliseconds is an exact moment. A numeric
 * offset is refused, since it is the form copied from the wrong clock, and wrong across a clock
 * change even when copied from the right one. Read in two steps: the shape first, before the
 * resource is found, and the moment once the publication's zone is known, so a refusal about the
 * send or the zone comes in its usual order.
 */

import {
  formatLocalTime,
  localTimeRefusal,
  parseLocalTime,
  readLocalTime,
  resolveTimeZone,
  timeZoneNameRefusal,
  type Wall,
  wallAt,
} from "../../shared/time_zone";
import { fieldError } from "../lib/body";

/** A fire time as asked, its shape checked: an exact moment, or a wall clock reading and the
 *  zone it names, if any (none means the publication's). */
export type FireAtRequest =
  | { kind: "exact"; at: number }
  | { kind: "local"; wall: Wall; zone: string | null };

/** The moment a fire time names, and the local time and zone it was asked in, if it was. */
export interface RequestedFireAt {
  at: number;
  local: { time: string; zone: string } | null;
}

/** A fire time is stored on the minute (SPEC §6). */
const MINUTE_MS = 60 * 1000;

/** An exact moment: an ISO-8601 time ending in `Z`. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/i;

/** A time carrying a numeric offset, `…T09:00-08:00` or `…+0900`. */
const WITH_OFFSET = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?[+-]\d{2}:?\d{2}$/;

const FORMS =
  "Send a local time such as 2026-11-13T09:00, which is the publication’s time, with time_zone if it’s another place’s time; or an exact moment ending in Z, or epoch milliseconds.";

/** Check a fire time's shape and its `time_zone`, or throw a 400 naming the field. */
export function parseFireAtRequest(input: unknown, timeZone: unknown): FireAtRequest {
  const request = shapeOf(input);
  if (timeZone === undefined) {
    return request;
  }
  if (request.kind === "exact") {
    throw fieldError(
      "time_zone",
      "time_zone goes only with a local time: an exact moment (ending in Z, or epoch milliseconds) already names its instant.",
    );
  }
  const zone = typeof timeZone === "string" ? resolveTimeZone(timeZone) : null;
  if (zone === null) {
    throw fieldError("time_zone", timeZoneNameRefusal(timeZone));
  }
  return { ...request, zone };
}

function shapeOf(input: unknown): FireAtRequest {
  if (input === undefined) {
    throw fieldError("fire_at", `fire_at is required. ${FORMS}`);
  }
  if (typeof input === "number" && Number.isFinite(input)) {
    return { kind: "exact", at: input };
  }
  if (typeof input === "string") {
    const text = input.trim();
    const n = Number(text);
    if (text !== "" && Number.isFinite(n)) {
      return { kind: "exact", at: n };
    }
    if (ISO_UTC.test(text)) {
      const at = Date.parse(text);
      if (!Number.isNaN(at)) {
        return { kind: "exact", at };
      }
    }
    if (WITH_OFFSET.test(text)) {
      throw fieldError(
        "fire_at",
        "fire_at can’t carry an offset: one copied from today’s clock is wrong across a clock change. Send the local time with no offset, which is the publication’s time, with time_zone if it’s another place’s time.",
      );
    }
    const wall = parseLocalTime(text);
    if (wall !== null) {
      return { kind: "local", wall, zone: null };
    }
  }
  throw fieldError("fire_at", `fire_at isn’t a time Kestrel reads. ${FORMS}`);
}

/**
 * The moment a fire time names: an exact moment as it is, and a local time read on its zone's
 * clock, the publication's unless it named another. A local time a clock change skips or repeats
 * there is refused with the change itself.
 */
export function resolveFireAt(
  request: FireAtRequest,
  publicationZone: string,
  now = Date.now(),
): RequestedFireAt {
  if (request.kind === "exact") {
    return { at: request.at, local: null };
  }
  const zone = request.zone ?? publicationZone;
  const reading = readLocalTime(request.wall, zone);
  if (reading.kind !== "exact") {
    throw fieldError("fire_at", localTimeRefusal(request.wall, zone, now) ?? FORMS);
  }
  // Kept as the send will have it: on the minute, as every fire time is stored, so a time asked
  // with seconds (09:00:30) keeps the minute it fires at (09:01) on the same clock.
  const minute = Math.ceil(reading.at / MINUTE_MS) * MINUTE_MS;
  return { at: reading.at, local: { time: formatLocalTime(wallAt(minute, zone)), zone } };
}
