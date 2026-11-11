import { describe, expect, it } from "vitest";
import { markedRuns, searchZones, zoneChoices } from "./zone_search";

// SPEC §9, DESIGN §3 (Settings, Time zone): what a publisher types to find their readers'
// clock finds it first. The zones and names are this runtime's `Intl`, so each case names the
// zone or the long name it expects, never a position that depends on the engine's list order.

const all = zoneChoices([null]);
const first = (query: string, near: string | null = "America/Los_Angeles") =>
  searchZones(all, query, { near })[0];

describe("time zone search", () => {
  it("puts the clock a name means first, not the first name that starts the same", () => {
    expect(first("eastern")?.label).toBe("Eastern Time");
    expect(first("central")?.label).toBe("Central Time");
    expect(first("pacific")?.label).toBe("Pacific Time");
    expect(first("eastern time")?.label).toBe("Eastern Time");
  });

  it("finds a zone by today's abbreviation", () => {
    expect(first("est")?.label).toBe("Eastern Time");
    expect(first("cst")?.label).toBe("Central Time");
    expect(first("pst")?.label).toBe("Pacific Time");
  });

  it("prefers a whole word of the name over a city that merely starts the same", () => {
    // "India" is a whole word of India Standard Time, and only the start of Indianapolis.
    expect(first("india")?.label).toBe("India Standard Time");
  });

  it("finds UTC itself, which some engines leave out of their list", () => {
    expect(first("utc")?.zone).toBe("UTC");
  });

  it("finds a city by its name, and by the start of each word", () => {
    expect(first("new york")?.zone).toBe("America/New_York");
    expect(first("chicago")?.zone).toBe("America/Chicago");
    expect(first("los a")?.zone).toBe("America/Los_Angeles");
    expect(first("tokyo")?.zone).toBe("Asia/Tokyo");
  });

  it("lists a name's zones in the browser's part of the world first", () => {
    const zone = first("central european", "Europe/Berlin")?.zone ?? "";
    expect(zone.startsWith("Europe/")).toBe(true);
    expect(first("central european", "Europe/Berlin")?.label).toBe("Central European Time");
  });

  it("marks only where a typed word starts a word", () => {
    expect(markedRuns("Pacific Time", "los a")).toEqual([{ text: "Pacific Time", marked: false }]);
    expect(markedRuns("Los Angeles", "los a")).toEqual([
      { text: "Los", marked: true },
      { text: " ", marked: false },
      { text: "A", marked: true },
      { text: "ngeles", marked: false },
    ]);
  });
});
