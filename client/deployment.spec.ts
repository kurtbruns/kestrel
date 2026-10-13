// The deployment reflection's markup helpers (client/deployment.ts).

import { describe, expect, it } from "vitest";
import { CONNECT_PROVIDER_HREF, connectProviderLink } from "./deployment";

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
