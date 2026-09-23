/**
 * A D1 handle that holds the test pool to what production D1 enforces and local SQLite
 * does not: at most 100 bound parameters per statement. It also counts the statements it
 * runs (a batch counts each of its statements), so a spec can check a tick stays inside
 * the per-invocation budget independently of the send loop's own meter.
 */

/** D1's cap on bound parameters in one statement. */
export const D1_MAX_BOUND_PARAMETERS = 100;

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
