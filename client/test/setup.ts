// Runs before each client spec file. The document gets the real admin shell, the body of
// public/dashboard/index.html, because the shell module reads its roots (#app, #identity,
// #toasts, the nav) at import time and the app is only ever mounted into that page. The
// inline scripts are dropped: they set a sidebar mode before first paint, nothing a spec
// asserts on.

import { afterEach, beforeEach, vi } from "vitest";
import page from "../../public/dashboard/index.html?raw";

// The browser keeps the publication's clock unless a spec moves it: `settingsResponse` gives the
// publication New York's zone, so the dashboard shows its times unlabeled, as it does at home,
// whatever zone the machine running the suite is in. A spec of a browser elsewhere stubs `TZ`
// itself (SPEC §6, DESIGN §10).
beforeEach(() => {
  vi.stubEnv("TZ", "America/New_York");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const open = /<body([^>]*)>/.exec(page);
if (!open) {
  throw new Error("public/dashboard/index.html has no <body>");
}
const body = page.slice(open.index + open[0].length, page.lastIndexOf("</body>"));
document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
// The body's own class too: it starts signed out, the chrome hidden until boot finds a session.
document.body.className = /class="([^"]*)"/.exec(open[1] ?? "")?.[1] ?? "";
