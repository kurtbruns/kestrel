import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// Two test projects, one per runtime:
//
//   worker — the Worker's suite (test/**), run inside the Workers runtime (workerd) via
//            Miniflare with the real D1/R2 bindings from wrangler.jsonc. Migrations are
//            read here (Node side) and injected as `TEST_MIGRATIONS`, then applied per
//            test file by the setup file.
//            https://developers.cloudflare.com/workers/testing/vitest-integration/
//   client — the admin SPA's suite (client/**), run under happy-dom: pure client logic
//            against a DOM, with no Worker, no bindings, and nothing of the pool above.
//   shared — the suite for code both of them import (shared/**), run in plain Node: no
//            DOM and no Worker, which is the contract that code must keep.
//
// The split is what lets client/ be tested at all — the workerd pool can't load browser
// code — while keeping that pool exactly as it was for the Worker.
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  // Deterministic dev-token signing secret for auth tests. The env is
                  // dev-shaped (fake transport, no Access), so getConfig honors it.
                  DEV_AUTH_SECRET: "test-dev-secret",
                  // Force the dev send simulation OFF for the suite regardless of a local
                  // `.dev.vars` (miniflare bindings win over it). The simulation's paced
                  // sleeps + injected edge states would make the deterministic tests slow and
                  // flaky; it's a demo-only tool, exercised directly in send_simulation.spec.
                  SIMULATE_SENDS: "",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/**/*.spec.ts"],
            setupFiles: ["./test/apply-migrations.ts"],
            // Don't discover specs inside git worktrees under .claude/ (task copies).
            exclude: [...configDefaults.exclude, "**/.claude/**"],
          },
        },
        {
          // The build inlines client/ui/icons/*.svg as text (esbuild's text loader); Vite would
          // hand a spec a URL for the same import, so this hands it the text too.
          plugins: [
            {
              name: "svg-as-text",
              enforce: "pre" as const,
              async load(id: string) {
                if (!id.split("?")[0]?.endsWith(".svg")) {
                  return null;
                }
                const { readFile } = await import("node:fs/promises");
                return `export default ${JSON.stringify(await readFile(id.split("?")[0] ?? id, "utf8"))};`;
              },
            },
          ],
          test: {
            name: "client",
            environment: "happy-dom",
            // Every client spec starts with the real admin shell in the document (the
            // shell module reads its roots at import time) and a scripted fetch at hand.
            setupFiles: ["./client/test/setup.ts"],
            // happy-dom loads an inserted <link rel=stylesheet> / <script src> for real by
            // default, so a swap test would do DNS + TCP; these are DOM tests, not fetch tests.
            environmentOptions: {
              happyDOM: {
                settings: {
                  disableCSSFileLoading: true,
                  disableJavaScriptFileLoading: true,
                  // ...and a disabled load is a silent `load`, not a logged `error`.
                  handleDisabledFileLoadingAsSuccess: true,
                },
              },
            },
            include: ["client/**/*.spec.ts"],
            exclude: [...configDefaults.exclude, "**/.claude/**"],
          },
        },
        {
          test: {
            name: "shared",
            environment: "node",
            include: ["shared/**/*.spec.ts"],
            exclude: [...configDefaults.exclude, "**/.claude/**"],
          },
        },
      ],
    },
  };
});
