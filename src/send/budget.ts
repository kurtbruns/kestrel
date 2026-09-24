/**
 * The per-invocation subrequest budget for the send path (SPEC §6).
 *
 * Cloudflare caps one Worker invocation twice over: every D1 statement and every outbound
 * `fetch` is a subrequest (50 on Workers Free; 10,000 by default on Workers Paid, more if
 * configured), and D1 statements have their own cap besides (1,000 on any plan, each
 * statement of a batch counted). A run that hits either cap throws partway through,
 * usually while recording what the provider just accepted, so the send loop spends
 * against both meters here instead and stops starting new batches while it can still
 * close cleanly. `metered` counts the D1 side for real; the loop charges each provider
 * request itself with `request`.
 */

/** Cloudflare's cap on D1 statements in one invocation, on every plan. */
export const D1_QUERY_LIMIT = 1000;

export class Budget {
  private queries = 0;
  private requests = 0;

  /** `limit` caps D1 statements and requests together; `queryLimit` caps D1 statements
   *  alone, and is never above `limit` or Cloudflare's D1 cap. */
  constructor(
    readonly limit: number,
    readonly queryLimit: number = Math.min(limit, D1_QUERY_LIMIT),
  ) {}

  /** Record `n` D1 statements run (or about to be). */
  query(n = 1): void {
    this.queries += n;
  }

  /** Record `n` outbound requests made (or about to be). */
  request(n = 1): void {
    this.requests += n;
  }

  /** Subrequests of any kind still allowed. */
  get left(): number {
    return this.limit - this.queries - this.requests;
  }

  /** D1 statements still allowed, which is never more than `left`. */
  get queriesLeft(): number {
    return Math.min(this.queryLimit - this.queries, this.left);
  }

  /** Whether `queries` more D1 statements and `requests` more outbound requests fit. */
  affords(queries: number, requests = 0): boolean {
    return this.queriesLeft >= queries && this.left >= queries + requests;
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
        budget.query();
        return column === undefined ? stmt.first() : stmt.first(column);
      },
      run: () => {
        budget.query();
        return stmt.run();
      },
      all: () => {
        budget.query();
        return stmt.all();
      },
      raw: (options?: { columnNames?: false }) => {
        budget.query();
        return stmt.raw(options);
      },
    };
    inner.set(charged, stmt);
    return charged as unknown as D1PreparedStatement;
  };
  const handle = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (statements: D1PreparedStatement[]) => {
      budget.query(statements.length);
      return db.batch(statements.map((s) => inner.get(s) ?? s));
    },
    exec: (sql: string) => {
      budget.query();
      return db.exec(sql);
    },
  };
  return handle as unknown as D1Database;
}
