import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appState } from "../state";
import { $, type FakeApi, fakeApi, jsonResponse, settingsResponse } from "../test/support";
import { clocksFor } from "../time_zone";
import { setHtml } from "../ui/html";
import { mountWhen, scheduledText, whenHtml } from "./when";

// The Send at picker (SPEC §6, DESIGN §4): a time typed on the publication's clock, the zone
// named and the browser's clock under it when they differ, and the server's own reading asked
// for as it changes.
describe("the Send at picker", () => {
  const YEAR = new Date().getUTCFullYear() + 1;
  // Fri Nov 13 (or whichever weekday it falls on) at 9:00 AM in New York, UTC-5 that day.
  const LOCAL = `${YEAR}-11-13T09:00`;
  const NINE_AM = Date.UTC(YEAR, 10, 13, 14, 0);
  let fake: FakeApi;
  let ctl: AbortController;
  let box: HTMLElement;
  let answer: () => Response | object;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    appState.appConfig = settingsResponse(); // New York, "Eastern Time"
    answer = () => ({ fire_at: NINE_AM });
    fake = fakeApi([{ path: "/api/time", reply: () => answer() }]);
    ctl = new AbortController();
    box = document.createElement("div");
    document.body.append(box);
  });
  afterEach(() => {
    ctl.abort();
    box.remove();
    fake.restore();
    vi.useRealTimers();
  });

  function open() {
    const c = clocksFor([NINE_AM]);
    setHtml(box, whenHtml("w", NINE_AM, c));
    return { c, picker: mountWhen(box, "w", c, ctl.signal) };
  }
  const line = () => $<HTMLElement>("#wLine", box);
  const warn = () => $<HTMLElement>("#wWarn", box);
  const pick = async (value: string) => {
    const input = $<HTMLInputElement>("#w", box);
    input.value = value;
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
  };

  it("at home, shows the publication's time with no zone and no second clock", async () => {
    const { picker } = open();
    expect($<HTMLInputElement>("#w", box).value).toBe(LOCAL);
    expect(box.querySelector(".when-zone")).toBeNull();
    await vi.advanceTimersByTimeAsync(300);
    expect(line().hidden).toBe(true);
    expect(warn().hidden).toBe(true);
    expect(picker.value()).toBe(LOCAL);
    expect(picker.moment()).toBe(NINE_AM);
  });

  it("away, reads the typed time on the publication's clock, names its zone, and shows the browser's clock under it", async () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
    const { picker } = open();
    // The field shows New York's 9:00, not Tokyo's.
    expect($<HTMLInputElement>("#w", box).value).toBe(LOCAL);
    expect($(".when-zone", box).textContent).toBe("Eastern Time");
    expect(line().textContent).toMatch(/^\w{3} 11:00 PM your time · Japan Standard Time$/);
    await vi.advanceTimersByTimeAsync(300);
    const asked = fake.calls.filter((r) => r.url.pathname === "/api/time");
    expect(asked.map((r) => r.url.searchParams.get("fire_at"))).toEqual([LOCAL]);
    expect(warn().hidden).toBe(true);
    expect(picker.moment()).toBe(NINE_AM);
    expect(fake.unhandled).toEqual([]);
  });

  it("warns, without blocking, when the server reads the time as another moment than this browser does", async () => {
    const { picker } = open();
    // The server's zone rules put 9:00 an hour earlier than this browser's do.
    answer = () => ({ fire_at: NINE_AM - 3_600_000 });
    await pick(`${YEAR}-11-13T09:00`);
    expect(warn().hidden).toBe(false);
    expect(warn().textContent).toBe(
      "This browser and the server disagree about Eastern Time’s clock on that date, which usually means its rules changed recently. The send goes out by the server’s clock, at the moment this browser reads as 8:00 AM.",
    );
    // The server's reading is the one the dialog checks the lead against.
    expect(picker.moment()).toBe(NINE_AM - 3_600_000);
  });

  it("shows the server's refusal of a time a clock change skips under the picker, and clears it on the next pick", async () => {
    open();
    const words = `2:30 AM doesn’t happen on Sun Mar 14, ${YEAR} in Eastern Time: clocks jump from 2:00 to 3:00 AM. Pick a time before 2:00 AM or from 3:00 AM.`;
    answer = () => jsonResponse({ error: "bad_request", field: "fire_at", message: words }, 400);
    await pick(`${YEAR}-03-14T02:30`);
    expect(line().textContent).toBe(words);
    expect(line().classList.contains("when-refused")).toBe(true);
    answer = () => ({ fire_at: NINE_AM });
    await pick(LOCAL);
    expect(line().classList.contains("when-refused")).toBe(false);
  });

  it("words a scheduled time for the toast: plain at home, with the zone and the browser's clock away", () => {
    expect(scheduledText(NINE_AM, clocksFor([NINE_AM]))).toMatch(/^\w{3} Nov 13, \d{4}, 9:00 AM$/);
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(scheduledText(NINE_AM, clocksFor([NINE_AM]))).toMatch(
      /^\w{3} Nov 13, \d{4}, 9:00 AM Eastern Time \(\w{3} 11:00 PM your time · Japan Standard Time\)$/,
    );
  });
});
