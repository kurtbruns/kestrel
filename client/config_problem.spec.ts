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
import { renderDrafts } from "./posts/drafts";
import { sendServer } from "./test/send_server";
import {
  $,
  $$,
  type FakeApi,
  fakeApi,
  jsonResponse,
  mount,
  resetShell,
  settle,
} from "./test/support";

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

  it("takes over the editor on any call the configuration refuses, saying what's wrong and linking to the fix", async () => {
    fake = fakeApi([{ path: "/api/posts", reply: () => jsonResponse(REFUSED, 500) }]);
    const err = await api("/api/posts").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, code: "invalid_config", message: REFUSED.message });
    expect(document.body.classList.contains("signed-out")).toBe(true);
    const wall = $("#app .config-wall");
    expect($("h2", wall).textContent).toBe("A setting needs fixing");
    // The server's words name the variable, so the wall shows them as they are.
    expect($(".config-wall-problem", wall).textContent).toBe(REFUSED.message);
    // Where to fix it is the reference's job, for a deployment and local development alike.
    expect($("a", wall).getAttribute("href")).toBe(`${CONFIGURATION_REFERENCE}#secrets`);
    expect(wall.textContent).not.toContain("secret put");
    expect(wall.textContent).not.toContain(".dev.vars");
    // Focus lands on the wall, so a screen reader starts there.
    expect(document.activeElement).toBe($("h2", wall));
    expect(fake.unhandled).toEqual([]);
  });

  it("links a var to its own heading in the reference", () => {
    showConfigProblem({ variable: "APP_ORIGIN", message: "APP_ORIGIN is not set" });
    const wall = $("#app .config-wall");
    expect($(".config-wall-problem", wall).textContent).toBe("APP_ORIGIN is not set");
    expect($("a", wall).getAttribute("href")).toBe(`${CONFIGURATION_REFERENCE}#vars`);
  });

  it("draws the wall once, however many calls in flight it fails", async () => {
    fake = fakeApi([{ path: "/api/posts", reply: () => jsonResponse(REFUSED, 500) }]);
    const first = api("/api/posts").catch(() => undefined);
    await first;
    const wall = $("#app .config-wall");
    await Promise.all([1, 2, 3, 4].map(() => api("/api/posts").catch(() => undefined)));
    expect($$("#app .config-wall")).toHaveLength(1);
    // The same element: the later failures left it alone rather than drawing it again.
    expect($("#app .config-wall")).toBe(wall);
  });

  it("tears down a mounted view when one of its later calls finds the configuration refused", async () => {
    fake = fakeApi([
      ...sendServer().routes,
      {
        path: "/api/posts",
        reply: () => ({
          posts: [],
          page: { total: 0, limit: 50, offset: 0, sort: "", dir: "desc" },
          cursor: "0.0",
        }),
      },
      { method: "POST", path: "/api/posts", reply: () => jsonResponse(REFUSED, 500) },
    ]);
    location.hash = "#/drafts";
    await mount(renderDrafts);
    await settle();
    expect($("h1").textContent).toBe("Drafts");
    const view = $("h1").closest("#app > *");
    expect(view?.isConnected).toBe(true);
    $("#newPost").click();
    await settle();
    // Unmounted: the view's root is gone from the page and nothing of it is left.
    expect(view?.isConnected).toBe(false);
    expect(document.querySelector("#app h1")).toBeNull();
    expect($$("#app .config-wall")).toHaveLength(1);
    expect(fake.unhandled).toEqual([]);
  });

  it("marks the reference link as opening a new tab for a screen reader, not with the arrow", () => {
    showConfigProblem({ variable: "APP_ORIGIN", message: "APP_ORIGIN is not set" });
    const link = $("#app .config-wall a");
    expect(link.getAttribute("target")).toBe("_blank");
    expect($("[aria-hidden='true']", link).textContent).toBe("↗");
    expect($(".visually-hidden", link).textContent).toBe(" (opens in a new tab)");
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

  it("links each variable to a part of the Configuration reference that covers it", () => {
    for (const [variable, anchor] of Object.entries(REFERENCE_ANCHORS)) {
      expect(HEADINGS.has(anchor), `${variable} → #${anchor}`).toBe(true);
    }
    // A setting with no heading of its own is named in the list of what the app refuses.
    const refusals = reference.slice(reference.indexOf("## What the app refuses"));
    expect(refusals).toContain("`SIMULATE_SENDS`");
    expect(referenceUrl("SIMULATE_SENDS")).toBe(`${CONFIGURATION_REFERENCE}#what-the-app-refuses`);
    // One the editor doesn't know yet lands on that list too.
    expect(referenceUrl("SOME_NEW_SETTING")).toBe(
      `${CONFIGURATION_REFERENCE}#what-the-app-refuses`,
    );
  });
});
