/*
 * The line `kestrel dev` prints for SIMULATE_SENDS (cli/dev.mjs): wrangler shows the variable
 * only as "(hidden)", so the run says itself what stands in for a provider, read from the
 * shell over `.dev.vars` the way the run forwards it.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveSimulateSends, simulationLine } from "../../cli/dev.mjs";
import { SIMULATION_FAULTS, SIMULATION_PROFILES } from "../../shared/settings.ts";

describe("simulationLine", () => {
  it("says a not-connected run refuses what would send, and how to leave it", () => {
    for (const value of ["not-connected", " Not-Connected "]) {
      expect(simulationLine(value)).toBe(
        "[dev] running not connected: sends, tests and signups are refused (unset SIMULATE_SENDS to send)",
      );
    }
  });

  it("names a simulation profile", () => {
    for (const value of ["ses:none", "resend", "1", "generic:realistic"]) {
      expect(simulationLine(value), value).toBe(
        `[dev] simulating a provider for list sends (SIMULATE_SENDS=${value}); nothing is delivered`,
      );
    }
  });

  // cli/ is plain Node and keeps its own copy of what the Worker accepts, so a profile or
  // fault added only to shared/ would print "isn't a value the app accepts" for a run the
  // Worker simulates. Every pairing the Worker reads has to get the simulating line.
  it("names every profile and fault the Worker accepts", () => {
    const values = SIMULATION_PROFILES.flatMap((profile) => [
      profile,
      ...SIMULATION_FAULTS.map((faults) => `${profile}:${faults}`),
    ]);
    for (const value of values) {
      expect(simulationLine(value), value).toBe(
        `[dev] simulating a provider for list sends (SIMULATE_SENDS=${value}); nothing is delivered`,
      );
    }
  });

  it("says a value the app will refuse is not one it accepts, never that it simulates", () => {
    for (const value of ["mailgun", "ses:sometimes", "ses:none:extra"]) {
      const line = simulationLine(value);
      expect(line, value).toContain(`SIMULATE_SENDS=${value} isn't a value the app accepts`);
      expect(line, value).not.toContain("simulating");
    }
  });

  it("says nothing for the plain fake", () => {
    for (const value of [undefined, "", "off", "0", "false", "no"]) {
      expect(simulationLine(value), String(value)).toBeNull();
    }
  });
});

describe("effectiveSimulateSends", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kestrel-dev-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const devVars = (value) => writeFileSync(join(dir, ".dev.vars"), `SIMULATE_SENDS="${value}"\n`);

  it("takes the shell's value over .dev.vars", () => {
    devVars("resend");
    expect(effectiveSimulateSends("not-connected", dir)).toBe("not-connected");
  });

  it("falls through to .dev.vars when the shell's value is empty or unset", () => {
    devVars("resend");
    expect(effectiveSimulateSends("", dir)).toBe("resend");
    expect(effectiveSimulateSends("  ", dir)).toBe("resend");
    expect(effectiveSimulateSends(undefined, dir)).toBe("resend");
  });

  it("lets the shell's off beat .dev.vars", () => {
    devVars("not-connected");
    expect(effectiveSimulateSends("off", dir)).toBe("off");
    expect(simulationLine(effectiveSimulateSends("off", dir))).toBeNull();
  });

  it("reads no value when neither sets one", () => {
    expect(effectiveSimulateSends(undefined, dir)).toBeUndefined();
  });
});
