import { afterEach, describe, expect, it } from "vitest";
import reference from "../docs/reference/01-configuration.md?raw";
import { api } from "./api";
import {
  CONFIGURATION_REFERENCE,
  configRefusal,
  REFERENCE_ANCHORS,
  referenceUrl,
  showConfigProblem,
} from "./config_problem";
import { $, type FakeApi, fakeApi, jsonResponse, resetShell } from "./test/support";

/** GitHub's heading id, which the Docs tab and the project's site use too. */
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
}

const HEADINGS = new Set(
  reference
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => githubSlug(line.replace(/^#+ /, ""))),
);

const REFUSED = {
  error: "invalid_config",
  message:
    "ACCESS_AUD is not set, but ACCESS_TEAM_DOMAIN is; Access needs both to verify a sign-in",
  variable: "ACCESS_AUD",
};

describe("the refused-configuration wall (SPEC §9)", () => {
  let fake: FakeApi | undefined;
  afterEach(() => {
    fake?.restore();
    fake = undefined;
    resetShell();
    document.body.classList.remove("signed-out");
  });

  it("takes over the editor on any call the configuration refuses, naming the variable and the fix", async () => {
    fake = fakeApi([{ path: "/api/posts", reply: () => jsonResponse(REFUSED, 500) }]);
    const err = await api("/api/posts").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, code: "invalid_config", message: REFUSED.message });
    expect(document.body.classList.contains("signed-out")).toBe(true);
    const wall = $("#app .config-wall");
    expect($(".config-wall-problem", wall).textContent).toBe(`ACCESS_AUD: ${REFUSED.message}`);
    // A secret is fixed by storing it, not by a deploy.
    expect(wall.textContent).toContain("npx wrangler secret put ACCESS_AUD --env production");
    expect($("a", wall).getAttribute("href")).toBe(`${CONFIGURATION_REFERENCE}#secrets`);
    expect(fake.unhandled).toEqual([]);
  });

  it("tells a var's fix from a secret's", () => {
    showConfigProblem({ variable: "APP_ORIGIN", message: "APP_ORIGIN is not set" });
    const wall = $("#app .config-wall");
    expect(wall.textContent).toContain("wrangler.jsonc");
    expect(wall.textContent).not.toContain("secret put");
    expect($("a", wall).getAttribute("href")).toBe(`${CONFIGURATION_REFERENCE}#vars`);
  });

  it("leaves any other failure to the view that made the call", async () => {
    fake = fakeApi([
      { path: "/api/posts", reply: () => jsonResponse({ error: "internal_error" }, 500) },
    ]);
    await api("/api/posts").catch(() => undefined);
    expect(document.querySelector("#app .config-wall")).toBeNull();
    expect(document.body.classList.contains("signed-out")).toBe(false);
  });

  it("reads only an invalid_config body that names its variable", () => {
    expect(configRefusal(REFUSED)).toEqual({ variable: "ACCESS_AUD", message: REFUSED.message });
    expect(configRefusal({ error: "invalid_config" })).toBeNull();
    expect(configRefusal({ error: "conflict", variable: "X" })).toBeNull();
    expect(configRefusal(null)).toBeNull();
  });

  it("links each variable to a heading the Configuration reference has", () => {
    for (const [variable, anchor] of Object.entries(REFERENCE_ANCHORS)) {
      expect(HEADINGS.has(anchor), `${variable} → #${anchor}`).toBe(true);
    }
    // One with no heading of its own lands on the list of everything the app refuses.
    expect(referenceUrl("SIMULATE_SENDS")).toBe(`${CONFIGURATION_REFERENCE}#what-the-app-refuses`);
    expect(HEADINGS.has("what-the-app-refuses")).toBe(true);
  });
});
