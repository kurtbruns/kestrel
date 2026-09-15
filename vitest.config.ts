import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// Tests run inside the Workers runtime (workerd) via Miniflare, with the real
// D1/R2 bindings from wrangler.jsonc. Migrations are read here (Node side) and
// injected as `TEST_MIGRATIONS`, then applied per test file by the setup file.
// https://developers.cloudflare.com/workers/testing/vitest-integration/
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
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
      setupFiles: ["./test/apply-migrations.ts"],
      // Don't discover specs inside git worktrees under .claude/ (task copies).
      exclude: [...configDefaults.exclude, "**/.claude/**"],
    },
  };
});
