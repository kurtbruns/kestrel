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
} from "../test/support";
import { renderSettings } from "./settings";
import { browserTimeZone, zoneChoices } from "./time_zone";

// SPEC §9, DESIGN §5: the publication's time zone is never set without a deliberate act. The
// picker suggests the browser's zone while none is saved, and only its own button saves it.

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
  const optionValues = () => [...select().options].map((o) => o.value);

  const saved = (over: Partial<SettingsView>, readings: string[] = []): SettingsSavedResponse => ({
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

  const select = () => $<HTMLSelectElement>("#tzSelect");
  const saveButton = () => $<HTMLButtonElement>("#tzSave");
  const puts = () => fake.calls.filter((c) => c.method === "PUT");

  it("suggests the browser's zone while none is saved, and saves nothing until its button is clicked", async () => {
    browserIn("America/Chicago");
    const browser = "America/Chicago";
    expect(browserTimeZone()).toBe(browser);
    await open({ time_zone: null, time_zone_label: null }, [
      {
        method: "PUT",
        path: "/api/settings",
        reply: (c) =>
          saved({
            time_zone: (c.json() as { time_zone: string }).time_zone,
            time_zone_label: "Your Time",
          }),
      },
    ]);
    expect(select().value).toBe(browser);
    expect($("#tzStatus").textContent).toMatch(
      /^No time zone set yet, so nothing can be scheduled or sent\./,
    );
    expect(saveButton().disabled).toBe(false);
    // Opening the page, and saving the rest of it, never carries the suggestion along.
    expect(puts()).toEqual([]);
    expect($("#savebar").hidden).toBe(true);
    expect(appState.appConfig?.settings.time_zone).toBeNull();
    saveButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts().map((c) => c.json())).toEqual([{ time_zone: browser }]);
    expect(appState.appConfig?.settings.time_zone).toBe(browser);
    expect($("#tzStatus").textContent).toBe("Set to Your Time.");
    expect(saveButton().disabled).toBe(true);
    expect(fake.unhandled).toEqual([]);
  });

  it("names the chosen zone in full at once, and the rest once the picker is reached for", async () => {
    browserIn("America/Chicago");
    await open({ time_zone: "America/New_York", time_zone_label: "Eastern Time" });
    const text = (zone: string) => [...select().options].find((o) => o.value === zone)?.textContent;
    expect(text("America/New_York")).toBe("America/New York (Eastern Time)");
    expect(text("Asia/Tokyo")).toBe("Asia/Tokyo");
    select().dispatchEvent(new Event("focus"));
    expect(text("Asia/Tokyo")).toBe("Asia/Tokyo (Japan Standard Time)");
    expect(text("America/North_Dakota/New_Salem")).toBe(
      "America/North Dakota/New Salem (Central Time)",
    );
  });

  it("leaves the save bar's save without the zone", async () => {
    browserIn("America/Chicago");
    await open({ time_zone: null, time_zone_label: null }, [
      { method: "PUT", path: "/api/settings", reply: () => saved({ time_zone: null }) },
    ]);
    const name = $<HTMLInputElement>("#setName");
    name.value = "Owls Weekly";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    $("#savebarSave").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.json()).not.toHaveProperty("time_zone");
  });

  it("shows the saved zone, offers Save only once another is picked, and shows how scheduled posts now read", async () => {
    browserIn("Asia/Tokyo"); // never the suggestion once a zone is saved
    const reading =
      "Your scheduled post stays at the same moment, now Fri Nov 13, 8:00 AM Central Time. Move it if you meant 9:00 AM.";
    await open({ time_zone: "America/New_York", time_zone_label: "Eastern Time" }, [
      {
        method: "PUT",
        path: "/api/settings",
        reply: () =>
          saved({ time_zone: "America/Chicago", time_zone_label: "Central Time" }, [reading]),
      },
    ]);
    expect(select().value).toBe("America/New_York");
    expect($("#tzStatus").textContent).toBe("Set to Eastern Time.");
    expect(saveButton().disabled).toBe(true);
    select().value = "America/Chicago";
    select().dispatchEvent(new Event("change"));
    expect(saveButton().disabled).toBe(false);
    saveButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(puts().map((c) => c.json())).toEqual([{ time_zone: "America/Chicago" }]);
    expect($("#tzReadings").hidden).toBe(false);
    expect($("#tzReadings > span").textContent).toBe(reading);
  });

  it("lists and suggests a browser zone of UTC, which the browser's own list leaves out", async () => {
    browserIn("UTC");
    expect(zoneChoices([null])).not.toContain("UTC");
    await open({ time_zone: null, time_zone_label: null });
    expect(select().value).toBe("UTC");
    expect(optionValues().filter((z) => z === "UTC")).toHaveLength(1);
    expect(saveButton().disabled).toBe(false);
  });

  it("suggests an alias the list spells differently as the listed zone, once", async () => {
    // Whichever of the pair this engine lists, the other names the same zone.
    const listed = zoneChoices([null]);
    const india = listed.find((z) => z === "Asia/Calcutta" || z === "Asia/Kolkata") ?? "";
    const alias = india === "Asia/Calcutta" ? "Asia/Kolkata" : "Asia/Calcutta";
    expect(zoneChoices([alias])).toEqual(listed);
    browserIn(alias);
    await open({ time_zone: null, time_zone_label: null });
    expect(select().value).toBe(india);
    expect(optionValues().filter((z) => z === "Asia/Kolkata" || z === "Asia/Calcutta")).toEqual([
      india,
    ]);
  });

  it("lists a saved zone the browser doesn't, and opens on it", async () => {
    browserIn("Asia/Tokyo");
    await open({ time_zone: "UTC", time_zone_label: "GMT+00:00" });
    expect(optionValues()[0]).toBe("UTC");
    expect(select().value).toBe("UTC");
    expect(saveButton().disabled).toBe(true);
  });

  it("offers no suggestion when the browser's zone isn't one the server would take", async () => {
    browserIn("Etc/Unknown");
    expect(browserTimeZone()).toBeNull();
    await open({ time_zone: null, time_zone_label: null });
    expect(select().value).toBe("");
    expect(select().selectedOptions[0]?.textContent).toBe("Choose a time zone");
    expect(saveButton().disabled).toBe(true);
    expect($("#tzStatus").textContent).toBe(
      "No time zone set yet, so nothing can be scheduled or sent.",
    );
    select().value = "Europe/Paris";
    select().dispatchEvent(new Event("change"));
    expect(saveButton().disabled).toBe(false);
  });

  it("says why a refused zone was refused, under the picker", async () => {
    browserIn("America/Chicago");
    await open({ time_zone: null, time_zone_label: null }, [
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
    saveButton().click();
    await vi.advanceTimersByTimeAsync(0);
    expect(select().classList.contains("is-invalid")).toBe(true);
    const described = select().getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toContain(
      "isn’t a time zone this server knows",
    );
    expect(appState.appConfig?.settings.time_zone).toBeNull();
  });
});
