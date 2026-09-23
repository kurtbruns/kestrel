/**
 * The per-invocation subrequest budget for the send path (SPEC §6).
 *
 * A Worker invocation may make only so many subrequests, and on Cloudflare every D1
 * statement and every outbound `fetch` counts: 50 on the Workers Free plan, 1,000 D1
 * queries on Workers Paid. A run that hits the cap throws partway through, usually while
 * recording what the provider just accepted, so the send loop spends against this budget
 * instead and stops starting new batches while it can still close cleanly. `metered`
 * counts the D1 side for real; the loop charges each provider request itself.
 */

export class Budget {
  private used = 0;

  constructor(readonly limit: number) {}

  /** Record `n` subrequests made (or about to be). */
  spend(n = 1): void {
    this.used += n;
  }

  get left(): number {
    return this.limit - this.used;
  }

  affords(n: number): boolean {
    return this.left >= n;
  }
}

/**
 * A D1 handle that charges every statement it runs to `budget`. A batch charges one per
 * statement: D1 applies its per-invocation query limit statement by statement, so
 * counting a batch as one call could overrun it. Statements prepared here are unwrapped
 * again before they reach the real `batch`.
 */
export function metered(db: D1Database, budget: Budget): D1Database {
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const charged = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
      first: (column?: string) => {
        budget.spend();
        return column === undefined ? stmt.first() : stmt.first(column);
      },
      run: () => {
        budget.spend();
        return stmt.run();
      },
      all: () => {
        budget.spend();
        return stmt.all();
      },
      raw: (options?: { columnNames?: false }) => {
        budget.spend();
        return stmt.raw(options);
      },
    };
    inner.set(charged, stmt);
    return charged as unknown as D1PreparedStatement;
  };
  const handle = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => {
      budget.spend(statements.length);
      return db.batch(statements.map((s) => inner.get(s) ?? s));
    },
    exec: (sql: string) => {
      budget.spend();
      return db.exec(sql);
    },
  };
  return handle as unknown as D1Database;
}
