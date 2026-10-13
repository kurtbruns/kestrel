/**
 * A D1 handle that holds the test pool to what production D1 enforces and local SQLite
 * does not: at most 100 bound parameters per statement, and no bound string or blob over
 * D1's 2,000,000-byte limit on one value. It also counts the statements it
 * runs (a batch counts each of its statements), so a spec can check a tick stays inside
 * the per-invocation budget independently of the send loop's own meter.
 *
 * `meterD1` sums the rows D1 reports each statement read and wrote, from the result's
 * metadata, so a spec can hold a flow to what it costs against D1's daily allowances.
 */

/** D1's cap on bound parameters in one statement. */
export const D1_MAX_BOUND_PARAMETERS = 100;

/** D1's cap on one string or blob, in bytes. */
export const D1_MAX_VALUE_BYTES = 2_000_000;

function byteSize(value: unknown): number {
  if (typeof value === "string") {
    return new TextEncoder().encode(value).length;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  return 0;
}

export interface GuardedD1 {
  db: D1Database;
  /** Statements run through `db` so far. */
  statements: number;
}

export function guardD1(db: D1Database): GuardedD1 {
  const guard: GuardedD1 = { db: undefined as unknown as D1Database, statements: 0 };
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const counted = {
      bind: (...values: unknown[]) => {
        if (values.length > D1_MAX_BOUND_PARAMETERS) {
          throw new Error(
            `D1 rejects more than ${D1_MAX_BOUND_PARAMETERS} bound parameters; this statement binds ${values.length}: ${sql.slice(0, 120)}`,
          );
        }
        const largest = Math.max(0, ...values.map(byteSize));
        if (largest > D1_MAX_VALUE_BYTES) {
          throw new Error(
            `D1 rejects a value over ${D1_MAX_VALUE_BYTES} bytes; this statement binds one of ${largest}: ${sql.slice(0, 120)}`,
          );
        }
        return wrap(stmt.bind(...values), sql);
      },
      first: (column?: string) => {
        guard.statements += 1;
        return column === undefined ? stmt.first() : stmt.first(column);
      },
      run: () => {
        guard.statements += 1;
        return stmt.run();
      },
      all: () => {
        guard.statements += 1;
        return stmt.all();
      },
      raw: () => {
        guard.statements += 1;
        return stmt.raw();
      },
    };
    inner.set(counted, stmt);
    return counted as unknown as D1PreparedStatement;
  };
  guard.db = {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: (statements: D1PreparedStatement[]) => {
      guard.statements += statements.length;
      return db.batch(statements.map((s) => inner.get(s) ?? s));
    },
    exec: (sql: string) => {
      guard.statements += 1;
      return db.exec(sql);
    },
  } as unknown as D1Database;
  return guard;
}

/** Rows read and written through a metered handle, as D1 reports them. */
export interface MeteredD1 {
  db: D1Database;
  rowsRead: number;
  rowsWritten: number;
}

/**
 * A D1 handle that sums `rows_read` and `rows_written` from every statement's result
 * metadata. `first` runs as `all`, so its rows count too; `raw` and `exec` report none and
 * are refused, so nothing a flow does goes uncounted.
 */
export function meterD1(db: D1Database): MeteredD1 {
  const meter: MeteredD1 = { db: undefined as unknown as D1Database, rowsRead: 0, rowsWritten: 0 };
  const count = (meta: { rows_read?: number; rows_written?: number }) => {
    meter.rowsRead += meta.rows_read ?? 0;
    meter.rowsWritten += meta.rows_written ?? 0;
  };
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const metered = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      first: async (column?: string) => {
        const result = await stmt.all<Record<string, unknown>>();
        count(result.meta);
        const row = result.results[0] ?? null;
        return column === undefined || row === null ? row : (row[column] ?? null);
      },
      run: async () => {
        const result = await stmt.run();
        count(result.meta);
        return result;
      },
      all: async () => {
        const result = await stmt.all();
        count(result.meta);
        return result;
      },
      raw: () => {
        throw new Error("meterD1: raw() reports no rows read or written");
      },
    };
    inner.set(metered, stmt);
    return metered as unknown as D1PreparedStatement;
  };
  meter.db = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await db.batch(statements.map((s) => inner.get(s) ?? s));
      for (const result of results) {
        count(result.meta);
      }
      return results;
    },
    exec: () => {
      throw new Error("meterD1: exec() reports no rows read or written");
    },
  } as unknown as D1Database;
  return meter;
}
