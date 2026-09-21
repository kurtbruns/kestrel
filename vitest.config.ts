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
          test: {
            name: "client",
            environment: "happy-dom",
            include: ["client/**/*.spec.ts"],
            exclude: [...configDefaults.exclude, "**/.claude/**"],
          },
        },
      ],
    },
  };
});
