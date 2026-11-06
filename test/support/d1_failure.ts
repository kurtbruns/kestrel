/**
 * A D1 handle on which the statements matching a pattern fail with a message of the spec's
 * choosing, and every other statement runs. The error is raised at the statement, as the real
 * binding's is, so its stack passes through the `db/` function that ran it, which is what a
 * spec about naming the failed statement has to see.
 */

/** A handle over `db` whose statements matching `sql` reject with `message`, by themselves or
 *  in a batch. */
export function failingD1(db: D1Database, sql: RegExp, message: string): D1Database {
  const inner = new WeakMap<object, { stmt: D1PreparedStatement; fails: boolean }>();
  const wrap = (stmt: D1PreparedStatement, fails: boolean): D1PreparedStatement => {
    const run = <T>(go: () => Promise<T>) => (fails ? Promise.reject(new Error(message)) : go());
    const wrapped = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), fails),
      first: (column?: string) =>
        run(() => (column === undefined ? stmt.first() : stmt.first(column))),
      run: () => run(() => stmt.run()),
      all: () => run(() => stmt.all()),
      raw: () => run(() => stmt.raw()),
    };
    inner.set(wrapped, { stmt, fails });
    return wrapped as unknown as D1PreparedStatement;
  };
  return {
    prepare: (text: string) => wrap(db.prepare(text), sql.test(text)),
    batch: (statements: D1PreparedStatement[]) => {
      const held = statements.map((s) => inner.get(s));
      return held.some((h) => h?.fails)
        ? Promise.reject(new Error(message))
        : db.batch(statements.map((s, i) => held[i]?.stmt ?? s));
    },
    exec: (text: string) => db.exec(text),
  } as unknown as D1Database;
}
