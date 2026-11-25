/*
 * The settings `kestrel dev` forwards from the shell to the Worker (cli/dev.mjs). Wrangler
 * hands the Worker nothing from the shell on its own, so a setting missing from the list is
 * ignored without a word: the run keeps `.dev.vars`'s value, or the app's default.
 */
import { describe, expect, it } from "vitest";
import { localVars, settingsFromShell } from "../../cli/dev.mjs";

/** The `--var` values a run with this shell hands wrangler, as `NAME:value`. */
function varsFor(env) {
  const args = localVars({ port: "8787", runId: "run", fromShell: settingsFromShell(env), env });
  return args.filter((arg) => arg !== "--var");
}

describe("the per-run settings kestrel dev forwards", () => {
  it("forwards each setting the shell sets, over .dev.vars", () => {
    const env = {
      SIMULATE_SENDS: "ses:bad_request",
      SIMULATE_ACCOUNT: "sandbox",
      MIN_LEAD_SECONDS: "60",
      SUBREQUEST_BUDGET: "10000",
      SES_MAX_SEND_RATE: "1",
    };
    const vars = varsFor(env);
    for (const [name, value] of Object.entries(env)) {
      expect(vars, name).toContain(`${name}:${value}`);
    }
  });

  // The pace of a simulated SES send: one reader a request takes the rate from the shell.
  it("forwards SES_MAX_SEND_RATE set alone", () => {
    expect(settingsFromShell({ SES_MAX_SEND_RATE: "1" })).toEqual(["SES_MAX_SEND_RATE"]);
    expect(varsFor({ SES_MAX_SEND_RATE: "1" })).toContain("SES_MAX_SEND_RATE:1");
  });

  it("forwards a value as the shell gives it, for the app to accept or refuse", () => {
    expect(varsFor({ SES_MAX_SEND_RATE: "fast" })).toContain("SES_MAX_SEND_RATE:fast");
  });

  it("leaves out a setting the shell has empty or unset, so .dev.vars's value stands", () => {
    expect(settingsFromShell({ SES_MAX_SEND_RATE: "", MIN_LEAD_SECONDS: "  " })).toEqual([]);
    expect(settingsFromShell({})).toEqual([]);
  });

  it("forwards nothing else from the shell", () => {
    const env = { SES_MAX_SEND_RATE: "1", AWS_SECRET_ACCESS_KEY: "secret", PROVIDER: "ses" };
    expect(settingsFromShell(env)).toEqual(["SES_MAX_SEND_RATE"]);
    expect(varsFor(env).join(" ")).not.toMatch(/AWS_SECRET_ACCESS_KEY|PROVIDER/);
  });
});
