import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHIPPED_MIGRATIONS } from "../src/db/migrations";
import type { AppEnv } from "../src/env";
import worker from "../src/index";
import { guardD1 } from "./support/d1_guard";
import { dueSend, resetDatabase } from "./support/fixtures";
import { AUTH, readJson } from "./support/http";
import { allowErrorLogs, logged } from "./support/log";
import { fetchOn } from "./support/worker_env";

// The schema gate (SPEC §9): a database that hasn't run every migration this release ships
// is refused as a refused configuration is, so `/health` reports it instead of answering ok
// over a schema the app can't run on. The gate remembers a database once it has every
// migration, for the isolate's life, so each test here reaches the Worker through a D1
// handle of its own (`fresh`), which the gate has never seen.

const LATEST = SHIPPED_MIGRATIONS.at(-1) ?? "";

/** The suite's env on a D1 handle the gate hasn't seen, with `vars` over it. */
function fresh(db: D1Database = guardD1(env.DB).db, vars: Record<string, string> = {}): AppEnv {
  return { ...env, ...vars, DB: db } as unknown as AppEnv;
}

/** A D1 wrangler has never migrated: every table is missing, `d1_migrations` included. */
function neverMigrated(): D1Database {
  const fail = (sql: string) => () =>
    Promise.reject(
      new Error(`D1_ERROR: no such table: ${/FROM\s+(\w+)/i.exec(sql)?.[1] ?? "settings"}`),
    );
  const stmt = (sql: string): D1PreparedStatement =>
    ({
      bind: () => stmt(sql),
      all: fail(sql),
      first: fail(sql),
      run: fail(sql),
      raw: fail(sql),
    }) as unknown as D1PreparedStatement;
  return {
    prepare: stmt,
    batch: () => Promise.reject(new Error("D1_ERROR: no such table: settings")),
  } as unknown as D1Database;
}

/** Forget that the database ran `name`, as one deployed before applying it would be. */
async function unapply(name: string): Promise<void> {
  await env.DB.prepare("DELETE FROM d1_migrations WHERE name = ?").bind(name).run();
}

const VARS_DEPLOYED = { DEV_AUTH_SECRET: "" };

describe("the schema gate (SPEC §9)", () => {
  beforeEach(resetDatabase);
  afterEach(async () => {
    vi.restoreAllMocks();
    // Put the record back as the setup file left it.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM d1_migrations WHERE name LIKE 'local_%'"),
      ...SHIPPED_MIGRATIONS.map((name) =>
        env.DB.prepare(
          "INSERT INTO d1_migrations (name) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = ?)",
        ).bind(name, name),
      ),
    ]);
  });

  it("/health answers ok on a database that has run every shipped migration", async () => {
    const res = await fetchOn(fresh(), "/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", service: "kestrel" });
  });

  it("/health names the missing migration and both forms of the command outside local development", async () => {
    allowErrorLogs("schema.behind");
    await unapply(LATEST);
    const res = await fetchOn(fresh(undefined, VARS_DEPLOYED), "/health");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: "schema_behind",
      missing: [LATEST],
      message: `The database is missing a migration this release needs (${LATEST}). Apply it: npx wrangler d1 migrations apply DB --remote --env production for the deployed app, or --local --env production under a local wrangler dev. If it finds nothing to apply in an instance, run npm run sync-migrations first, which copies the release's migrations into migrations/.`,
    });
  });

  it("counts every shipped migration missing on a database wrangler never migrated", async () => {
    allowErrorLogs("schema.behind");
    const res = await fetchOn(fresh(neverMigrated(), VARS_DEPLOYED), "/health");
    expect(res.status).toBe(500);
    const body = await readJson(res);
    expect(body.error).toBe("schema_behind");
    expect(body.missing).toEqual([...SHIPPED_MIGRATIONS]);
  });

  it("ignores an instance's own local_ migrations: they are neither missing nor extra", async () => {
    await env.DB.prepare("INSERT INTO d1_migrations (name) VALUES ('local_0001_mine.sql')").run();
    const res = await fetchOn(fresh(), "/health");
    expect(res.status).toBe(200);
  });

  it("gives local development its --local command alone, and anything else both forms, whatever the request's host", async () => {
    allowErrorLogs("schema.behind");
    await unapply(LATEST);
    for (const url of ["http://localhost:8787/health", "https://newsletter.example.com/health"]) {
      // The suite's env is dev-shaped: local development's own database.
      const dev = (await readJson(await fetchOn(fresh(), url))).message;
      expect(dev, url).toBe(
        `The database is missing a migration this release needs (${LATEST}). Apply it: npx wrangler d1 migrations apply DB --local. If it finds nothing to apply in an instance, run npm run sync-migrations first, which copies the release's migrations into migrations/.`,
      );
      // Any other env can't tell deployed from a local `wrangler dev`, so it names both.
      const other = (await readJson(await fetchOn(fresh(undefined, VARS_DEPLOYED), url))).message;
      expect(other, url).toContain(
        "npx wrangler d1 migrations apply DB --remote --env production for the deployed app",
      );
      expect(other, url).toContain("or --local --env production under a local wrangler dev");
    }
  });

  it("lets the request through, logging once, when the check can't read the database at all", async () => {
    const warn = vi.spyOn(console, "warn");
    const real = env.DB;
    const unreachable = {
      prepare: (sql: string) =>
        sql.includes("d1_migrations")
          ? ({
              all: () => Promise.reject(new Error("D1_ERROR: network connection lost")),
            } as unknown as D1PreparedStatement)
          : real.prepare(sql),
      batch: (s: D1PreparedStatement[]) => real.batch(s),
    } as unknown as D1Database;
    expect((await fetchOn(fresh(unreachable), "/health")).status).toBe(200);
    expect((await fetchOn(fresh(unreachable), "/")).status).toBe(200);
    expect(logged(warn).filter((l) => l.event === "schema.unchecked")).toHaveLength(1);
  });

  it("reads a current database once per isolate, not on every request", async () => {
    const guarded = guardD1(env.DB);
    const e = fresh(guarded.db);
    expect((await fetchOn(e, "/health")).status).toBe(200);
    expect(guarded.statements).toBe(1);
    expect((await fetchOn(e, "/health")).status).toBe(200);
    expect(guarded.statements).toBe(1);
  });

  it("answers the API with the same refusal before authentication, for the editor to show", async () => {
    allowErrorLogs("schema.behind");
    await unapply(LATEST);
    const res = await fetchOn(fresh(), "/api/posts", { headers: AUTH });
    expect(res.status).toBe(500);
    expect((await readJson(res)).error).toBe("schema_behind");
  });

  it("gives a reader the temporarily-unavailable page, never JSON", async () => {
    allowErrorLogs("schema.behind");
    for (const path of ["/", "/subscribe", "/archive", "/archive/some-post"]) {
      const res = await fetchOn(fresh(neverMigrated()), path);
      expect(res.status, path).toBe(503);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      expect(res.headers.get("retry-after"), path).toBe("300");
      const page = await res.text();
      expect(page, path).toContain("This page is temporarily unavailable");
      // Nothing about migrations, which mean nothing to a reader.
      expect(page, path).not.toContain("migration");
    }
  });

  it("answers again as soon as the migration is applied, with no redeploy", async () => {
    allowErrorLogs("schema.behind");
    await unapply(LATEST);
    const e = fresh();
    expect((await fetchOn(e, "/health")).status).toBe(500);
    await env.DB.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(LATEST).run();
    expect((await fetchOn(e, "/health")).status).toBe(200);
  });

  it("skips the sweep while the database is behind, so a due send waits rather than runs", async () => {
    allowErrorLogs("schema.behind");
    const send = await dueSend();
    await unapply(LATEST);
    const ctx = createExecutionContext();
    await worker.scheduled(
      createScheduledController({ cron: "* * * * *", scheduledTime: Date.now() }),
      fresh(),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const row = await env.DB.prepare("SELECT status FROM sends WHERE id = ?")
      .bind(send.id)
      .first<{ status: string }>();
    expect(row?.status).toBe("scheduled");
  });
});

describe("an error nothing handled on a reader route (SPEC §12)", () => {
  /** A D1 that has every migration but fails every other query, as a schema missing a table
   *  the migrations record says it has would. */
  function failingQueries(): D1Database {
    const real = env.DB;
    return {
      prepare: (sql: string) =>
        sql.includes("d1_migrations") ? real.prepare(sql) : neverMigrated().prepare(sql),
      batch: () => Promise.reject(new Error("D1_ERROR: no such table: settings")),
    } as unknown as D1Database;
  }

  it("renders the HTML error page, never the API's JSON body", async () => {
    allowErrorLogs("request.error");
    for (const path of ["/", "/subscribe", "/archive"]) {
      const res = await fetchOn(fresh(failingQueries()), path);
      expect(res.status, path).toBe(500);
      expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(await res.text(), path).toContain("Something went wrong");
    }
  });

  it("keeps the JSON body on the API", async () => {
    allowErrorLogs("request.error");
    const res = await fetchOn(fresh(failingQueries()), "/api/posts", { headers: AUTH });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
});
