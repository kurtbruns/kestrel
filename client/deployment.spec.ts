// The deployment reflection's markup helpers (client/deployment.ts).

import { afterEach, describe, expect, it } from "vitest";
import {
  buildDateText,
  buildRefParts,
  CONNECT_PROVIDER_HREF,
  connectProviderLink,
} from "./deployment";
import { appState } from "./state";
import { settingsResponse } from "./test/support";

const SOURCE = "https://github.com/x/kestrel";

/** The reflection with this build stamp, as boot leaves it in app state. */
function running(build: { version: string; sha: string; tag: string; commit_time: string }): void {
  appState.appConfig = settingsResponse({
    deployment: { build: { ...build, source_url: SOURCE } },
  });
}

afterEach(() => {
  appState.appConfig = null;
});

describe("the build stamp (SPEC §9)", () => {
  it("links a release build's version to its release and its sha to its commit", () => {
    running({ version: "1.2.0", sha: "abc1234", tag: "v1.2.0", commit_time: "" });
    const parts = buildRefParts();
    expect(parts?.version.markup).toBe(
      `<a class="build-link" href="${SOURCE}/releases/tag/v1.2.0" target="_blank" rel="noopener">v1.2.0</a>`,
    );
    expect(parts?.sha.markup).toBe(
      `<a class="build-link" href="${SOURCE}/commit/abc1234" target="_blank" rel="noopener">abc1234</a>`,
    );
  });

  it("leaves the version plain between releases and the sha plain on a dev build", () => {
    running({ version: "1.2.0", sha: "dev", tag: "", commit_time: "" });
    const parts = buildRefParts();
    expect(parts?.version.markup).toBe("v1.2.0");
    expect(parts?.sha.markup).toBe("dev");
  });

  it("dates a release build by its release and any other by its commit", () => {
    const at = "2026-09-21T10:00:00-07:00";
    const when = new Date(at).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    running({ version: "1.2.0", sha: "abc1234", tag: "v1.2.0", commit_time: at });
    expect(buildDateText()).toBe(`Released ${when}`);
    running({ version: "1.2.0", sha: "abc1234", tag: "", commit_time: at });
    expect(buildDateText()).toBe(`Committed ${when}`);
  });

  it("gives no date for a build made without git", () => {
    running({ version: "1.2.0", sha: "dev", tag: "", commit_time: "" });
    expect(buildDateText()).toBeNull();
  });
});

describe("connectProviderLink", () => {
  it("carries no class attribute when given no class", () => {
    expect(connectProviderLink().markup).toBe(
      `<a href="${CONNECT_PROVIDER_HREF}">Connect Amazon SES</a>`,
    );
  });

  it("carries the class it is given", () => {
    expect(connectProviderLink("set-link").markup).toBe(
      `<a class="set-link" href="${CONNECT_PROVIDER_HREF}">Connect Amazon SES</a>`,
    );
  });
});
