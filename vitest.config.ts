import { defineConfig, configDefaults } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

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
            // Deterministic bearer token for auth tests (overrides .dev.vars).
            BEARER_TOKEN: "test-bearer-token",
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
