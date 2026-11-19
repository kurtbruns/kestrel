import { describe, expect, it } from "vitest";
import { followSettings, type Publishing, settingsChange, settingsDiffer } from "./publishing";

const stored = (over: Partial<Publishing> = {}): Publishing => ({
  emailOnly: false,
  slug: "owls",
  slugAuto: true,
  subject: "Owls",
  slugTaken: null,
  fixed: false,
  ...over,
});

describe("settingsDiffer (SPEC §4)", () => {
  it("sees Include in archive and an address set by hand, not a following address moving with the subject", () => {
    expect(settingsDiffer(stored(), stored({ emailOnly: true }))).toBe(true);
    expect(settingsDiffer(stored(), stored({ slugAuto: false }))).toBe(true);
    expect(
      settingsDiffer(stored({ slugAuto: false }), stored({ slugAuto: false, slug: "x" })),
    ).toBe(true);
    expect(settingsDiffer(stored(), stored({ slug: "owls-at-dusk" }))).toBe(false);
  });
});

describe("followSettings (SPEC §4)", () => {
  it("takes a change made elsewhere into a setting the publisher left alone", () => {
    const opened = stored();
    const working = { ...opened };
    const fresh = stored({ emailOnly: true });
    followSettings(opened, working, fresh);
    expect(working.emailOnly).toBe(true);
    expect(settingsChange(fresh, working)).toBeNull();
  });

  it("keeps a setting the publisher changed, and sends only that", () => {
    const opened = stored();
    const working = { ...opened, slug: "dusk", slugAuto: false };
    const fresh = stored({ emailOnly: true });
    followSettings(opened, working, fresh);
    // Include in archive was untouched here, so it follows; the address was theirs, so it stays.
    expect(working.emailOnly).toBe(true);
    expect(working.slug).toBe("dusk");
    expect(settingsChange(fresh, { ...working, emailOnly: false })).toEqual({
      email_only: false,
      slug: "dusk",
    });
    expect(settingsChange(fresh, working)).toBeNull(); // email only: there's no address to send
  });

  it("keeps the publisher's Include in archive over a change elsewhere, and follows an address set there", () => {
    const opened = stored();
    const working = { ...opened, emailOnly: true };
    const fresh = stored({ slug: "night-owls", slugAuto: false });
    followSettings(opened, working, fresh);
    expect(working).toMatchObject({ emailOnly: true, slug: "night-owls", slugAuto: false });
    expect(settingsChange(fresh, working)).toEqual({ email_only: true });
  });
});
