import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsSavedResponse, SettingsView } from "../../shared/settings";
import { appState } from "../state";
import {
  $,
  type FakeApi,
  type FakeRoute,
  fakeApi,
  mount,
  resetShell,
  settingsResponse,
  typeInto,
} from "../test/support";
import { renderSettings } from "./settings";
import { browserTimeZone } from "./time_zone";

// SPEC §9, DESIGN §6: the publication's time zone is never set without a deliberate act. While
// none is saved the browser's zone is offered, never filled in; a zone is chosen with Use or
// from the search, and the choice waits for the save bar like a typed edit.

describe("settings' time zone", () => {
  let fake: FakeApi;
  beforeEach(() => {
    resetShell();
    vi.useFakeTimers();
    location.hash = "#/settings";
  });
  afterEach(() => {
    fake?.restore();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /** Set the zone this browser reports, so no case depends on the machine running it: Node
   *  resets its default zone when `TZ` changes. */
  const browserIn = (zone: string) => vi.stubEnv("TZ", zone);

  const answer = (over: Partial<SettingsView>, readings: string[] = []): SettingsSavedResponse => ({
    settings: settingsResponse({ settings: over }).settings,
    warnings: [],
    remade: [],
    time_zone_readings: readings,
  });

  async function open(settings: Partial<SettingsView>, routes: FakeRoute[] = []) {
    // As boot leaves it: the settings every other view reads the zone from.
    appState.appConfig = settingsResponse({ settings });
    fake = fakeApi([
      { path: "/api/settings", reply: () => settingsResponse({ settings }) },
      { path: /^\/api\/reader-pages\//, reply: () => new Response("<html></html>") },
      ...routes,
    ]);
    await mount(renderSettings);
    await vi.advanceTimersByTimeAsync(0);
  }

  const unset = { time_zone: null, time_zone_label: null };
  /** A zone's lines as one string, "Central Time | Chicago · America · …", or the warning. */
  const lines = (el: Element | null) =>
    el?.querySelector(".set-tz-name")
      ? [...el.querySelectorAll(".set-tz-name, .set-tz-place")]
          .map((s) => s.textContent)
          .join(" | ")
      : el?.textContent?.replace(/\s+/g, " ").trim();
  const chosen = () => lines($("#tzChosen"));
  const suggestion = () => document.querySelector("#tzSuggest .set-tz-suggest");
  /** Whether the save bar is up, saying the page has unsaved changes. */
  const barUp = () => $("#savebar").classList.contains("show");
  const puts = () => fake.calls.filter((c) => c.method === "PUT");
  const search = (text: string) => typeInto($<HTMLInputElement>("#tzSearch"), text);
  const rows = () => [...document.querySelectorAll("#tzResults li[data-i]")].map((li) => lines(li));
  const press = (key: string) =>
    $("#tzSearch").dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

  it("offers the browser's zone while none is saved, and chooses nothing until Use", async () => {
    browserIn("America/Chicago");
    expect(browserTimeZone()).toBe("America/Chicago");
    await open(unset);
    expect(chosen()).toBe("No time zone set yet, so nothing can be scheduled or sent.");
    expect(suggestion()?.querySelector(".set-tz-lines span")?.textContent).toBe(
      "This browser is on Central Time",
    );
    expect(suggestion()?.querySelector(".set-tz-place")?.textContent).toMatch(
      /^Chicago · America · \d{1,2}:\d\d [AP]M there now$/,
    );
    expect($("#tzUse").textContent).toBe("Use Central Time");
    // Nothing is chosen, so the page has nothing unsaved and nothing has been sent.
    expect(barUp()).toBe(false);
    expect(appState.appConfig?.settings.time_zone).toBeNull();
    $<HTMLButtonElement>("#tzUse").click();
    expect(chosen()).toMatch(/^Central Time \| Chicago · America · UTC-0[56]:00 · C[SD]T$/);
    expect(suggestion()).toBeNull(); // it is the one chosen now
    expect(barUp()).toBe(true);
    expect(puts()).toEqual([]);
    expect(fake.unhandled).toEqual([]);
  });

  it("saves the chosen zone through the save bar, with the page's other edits, and shows how scheduled posts now read", async () => {
    browserIn("America/Chicago");
    const reading =
      "Your scheduled post stays at the same moment, now Fri Nov 13, 8:00 AM Central Time.";
    await open(unset, [
      {
        method: "PUT",
        path: "/api/settings",
        reply: () =>
          answer({ time_zone: "America/Chicago", time_zone_label: "Central Time" }, [reading]),
      },
    ]);
    $<HTMLButtonElement>("#tzUse").click();
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts().map((c) => (c.json() as { time_zone?: string }).time_zone)).toEqual([
      "America/Chicago",
    ]);
    expect($("#tzReadings").hidden).toBe(false);
    expect($("#tzReadings > span").textContent).toBe(reading);
    expect(appState.appConfig?.settings.time_zone).toBe("America/Chicago");
    // Saved: the browser's zone is never offered again, and nothing is left unsaved.
    expect(suggestion()).toBeNull();
    expect(barUp()).toBe(false);
  });

  it("never sends a zone the publisher didn't choose, with any other save", async () => {
    browserIn("America/Chicago");
    await open(unset, [{ method: "PUT", path: "/api/settings", reply: () => answer(unset) }]);
    typeInto($<HTMLInputElement>("#setName"), "Owls Weekly");
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.json()).not.toHaveProperty("time_zone");
  });

  it("puts the saved zone back on Discard", async () => {
    browserIn("Asia/Tokyo");
    await open({ time_zone: "America/New_York", time_zone_label: "Eastern Time" });
    expect(suggestion()).toBeNull(); // a zone is saved: a traveling browser isn't offered
    search("chicago");
    press("Enter");
    expect(chosen()).toMatch(/^Central Time \|/);
    expect(barUp()).toBe(true);
    $("#savebarDiscard").click();
    expect(chosen()).toMatch(/^Eastern Time \| New York · America/);
    expect(barUp()).toBe(false);
  });

  it("finds zones by the start of each word typed, and marks what matched", async () => {
    browserIn("America/Chicago");
    await open({ time_zone: "America/New_York", time_zone_label: "Eastern Time" });
    search("los a");
    expect(rows()[0]).toMatch(/^Pacific Time \| Los Angeles · America/);
    expect(
      [...document.querySelectorAll("#tzResults li[data-i='0'] mark")].map((m) => m.textContent),
    ).toEqual(["Los", "A", "A"]);
    search("est");
    expect(rows()[0]).toMatch(/· EST$/);
    search("xyzzy");
    expect($("#tzResults").textContent).toBe(
      "No zone matches. Try a nearby city, or the zone’s name.",
    );
  });

  it("offers a browser zone of UTC, which the browser's own list leaves out", async () => {
    browserIn("UTC");
    await open(unset);
    expect(suggestion()).not.toBeNull();
    $<HTMLButtonElement>("#tzUse").click();
    expect(chosen()).toMatch(/^GMT\+00:00 \| UTC · UTC\+00:00 · UTC$/);
    search("utc");
    expect(rows().filter((r) => r?.startsWith("GMT+00:00 | UTC · "))).toHaveLength(1);
  });

  it("finds an alias the list spells differently as the listed zone, once", async () => {
    browserIn("Asia/Kolkata");
    await open(unset);
    search("india");
    expect(rows().filter((r) => /Calcutta|Kolkata/.test(r ?? ""))).toHaveLength(1);
  });

  it("finds a saved zone the browser doesn't list", async () => {
    browserIn("Asia/Tokyo");
    await open({ time_zone: "UTC", time_zone_label: "GMT+00:00" });
    expect(chosen()).toMatch(/^GMT\+00:00 \| UTC · UTC\+00:00 · UTC$/);
    search("utc");
    expect(rows().filter((r) => r?.startsWith("GMT+00:00 | UTC · "))).toHaveLength(1);
  });

  it("offers nothing when the browser's zone isn't one the server would take", async () => {
    browserIn("Etc/Unknown");
    expect(browserTimeZone()).toBeNull();
    await open(unset);
    expect(suggestion()).toBeNull();
    expect(chosen()).toBe("No time zone set yet, so nothing can be scheduled or sent.");
  });

  it("says why a refused zone was refused, under the search", async () => {
    browserIn("America/Chicago");
    await open(unset, [
      {
        method: "PUT",
        path: "/api/settings",
        reply: () =>
          new Response(
            JSON.stringify({
              error: "bad_request",
              field: "time_zone",
              message: "“X” isn’t a time zone this server knows.",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      },
    ]);
    $<HTMLButtonElement>("#tzUse").click();
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    const input = $<HTMLInputElement>("#tzSearch");
    expect(input.classList.contains("is-invalid")).toBe(true);
    const described = input.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toContain(
      "isn’t a time zone this server knows",
    );
    expect(appState.appConfig?.settings.time_zone).toBeNull();
    expect(barUp()).toBe(true);
  });
});
