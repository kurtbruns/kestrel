// What a maintainer's reset clears and keeps, what it reads first, and how it judges what it
// read: the refusals, and what the maintainer has to be shown and say yes to. Pure, with no
// wrangler and no file access, so the spec (test/cli/reset_instance.spec.mjs) can run every
// query here against a database built from migrations/.

/** The tables a reset empties, in the order the foreign keys require (children first). */
export const CLEARED = [
  "held_receipts",

  "deliveries",
  "send_acts",
  "notifications",
  "send_tombstones",
  "sends",
  "images",
  "post_revisions",
  "posts",
  "suppressions",
  "subscribers",
  "imports",
];

/** The tables a reset leaves as they are: the publication's settings (name, template, time
 *  zone, notification addresses, test recipients), the proof that email works with when the
 *  provider last reported back, and what the provider last said about the account. */
export const KEPT = ["provider_account", "sending", "settings"];

/** SES took an email this recently: a bounce or complaint about it may still arrive, and
 *  would write a row after the clear. */
export const RECENT_MS = 10 * 60 * 1000;

/** More addresses than a person can say are theirs one by one. */
export const MOST_TO_NAME = 50;

/** The clear, as one file's worth of SQL. Running it twice is harmless. */
export function clearSql() {
  return `${CLEARED.map((t) => `DELETE FROM ${t};`).join("\n")}\n`;
}

// An address the maintainer never has to name: an erasure's placeholder, which is no
// address, and SES's simulator, which mails no one.
const NAMEABLE = (email) =>
  `${email} NOT LIKE 'erased:%' AND ${email} NOT LIKE '%@simulator.amazonses.com'`;

const TEST_RECIPIENTS =
  "SELECT lower(value) FROM settings, json_each(json_extract(settings.data, '$.testRecipients'))";

/** Every read a reset makes before it clears anything, each a single SELECT. */
export const QUERIES = {
  tables:
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
  publication:
    "SELECT json_extract(data, '$.publication.name') AS name, json_extract(data, '$.timeZone') AS time_zone, json_array_length(json_extract(data, '$.testRecipients')) AS test_recipients FROM settings",
  counts: `SELECT ${[...CLEARED, ...KEPT].map((t) => `(SELECT count(*) FROM ${t}) AS ${t}`).join(", ")}`,
  active: "SELECT count(*) AS n FROM sends WHERE status IN ('scheduled', 'sending')",
  sending: "SELECT state, last_accepted_at FROM sending",
  // Everyone who saved a revision, acted on a send, or ran an import: a person's address, or
  // `service` for a service token.
  actors: `SELECT DISTINCT who FROM (
      SELECT author AS who FROM post_revisions WHERE author IS NOT NULL
      UNION SELECT COALESCE(json_extract(actor, '$.email'), 'service') FROM send_acts
      UNION SELECT COALESCE(principal_email, 'service') FROM imports
    ) ORDER BY who`,
  // Every address that isn't a test recipient, with what the instance holds about it. A
  // pending signup is left out: the form is public before any hand-off.
  addresses: `SELECT email, group_concat(what, '; ') AS what FROM (
      SELECT email,
             CASE status WHEN 'confirmed' THEN 'confirmed subscriber' ELSE 'unsubscribed (' || unsubscribe_cause || ')' END
               || CASE WHEN import_id IS NOT NULL THEN ', imported' ELSE '' END AS what
        FROM subscribers WHERE status IN ('confirmed', 'unsubscribed')
      UNION ALL
      SELECT email, 'in the delivery record of ' || count(*) || ' send(s)' FROM deliveries GROUP BY email
      UNION ALL
      SELECT email, 'suppressed (' || reason || ')' FROM suppressions
    )
    WHERE email NOT IN (${TEST_RECIPIENTS}) AND ${NAMEABLE("email")}
    GROUP BY email ORDER BY email`,
  pending: "SELECT count(*) AS n FROM subscribers WHERE status = 'pending'",
  erased:
    "SELECT count(*) AS n FROM subscribers WHERE status = 'unsubscribed' AND unsubscribe_cause = 'erased'",
  sent: `SELECT s.subject, s.fire_at, p.email_only,
             (SELECT count(*) FROM deliveries d WHERE d.send_id = s.id) AS recipients
        FROM sends s JOIN posts p ON p.id = s.post_id
       WHERE s.status = 'sent' ORDER BY s.fire_at`,
  // Addresses the provider's own suppression list may still hold, which a reset leaves alone.
  refusedByProvider: `SELECT DISTINCT email FROM (
      SELECT email FROM deliveries WHERE event = 'complained' OR (event = 'bounced' AND bounce_kind = 'hard')
      UNION SELECT email FROM suppressions WHERE reason = 'bounce'
      UNION SELECT email FROM subscribers WHERE unsubscribe_cause = 'complaint'
    ) WHERE ${NAMEABLE("email")} ORDER BY email`,
  images: "SELECT storage_key FROM images ORDER BY storage_key",
};

/**
 * What a read of the instance means. `read` holds each query's rows under its name, and `now`
 * is the time in epoch milliseconds. `refusals` are reasons a reset must not run, each a
 * sentence; with any, nothing else matters. `toName` is what the maintainer is shown and says
 * yes to. `fingerprint` is everything the yes covers, so a clear can tell that the instance
 * changed after it was shown.
 */
export function judge(read, now) {
  const refusals = [];

  const tables = read.tables.map((r) => r.name);
  const known = [...CLEARED, ...KEPT].sort();
  if (tables.length !== known.length || tables.some((t, i) => t !== known[i])) {
    const extra = tables.filter((t) => !known.includes(t));
    const missing = known.filter((t) => !tables.includes(t));
    refusals.push(
      `Its tables aren't the ${known.length} this skill knows (${[
        extra.length ? `not known: ${extra.join(", ")}` : "",
        missing.length ? `missing: ${missing.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ")}). The instance runs a release this skill wasn't written for.`,
    );
    // Nothing else can be read safely from a schema it doesn't know.
    return { refusals, toName: null, fingerprint: null };
  }

  const active = read.active[0]?.n ?? 0;
  if (active > 0) {
    refusals.push(
      `${active} send(s) are scheduled or sending. Cancel them or let them finish first.`,
    );
  }

  const lastAccepted = read.sending[0]?.last_accepted_at ?? null;
  if (lastAccepted !== null && now - lastAccepted < RECENT_MS) {
    const wait = Math.ceil((RECENT_MS - (now - lastAccepted)) / 60000);
    refusals.push(
      `The provider took an email less than ${RECENT_MS / 60000} minutes ago, and a bounce or complaint about it could still arrive. Try again in ${wait} minute(s).`,
    );
  }

  const actors = read.actors.map((r) => r.who);
  const people = actors.filter((who) => who !== "service");
  if (people.length > 1) {
    refusals.push(
      `${people.length} people have written or acted here (${people.join(", ")}). An instance someone else has used is not reset.`,
    );
  }

  const addresses = read.addresses.map((r) => ({ email: r.email, what: r.what }));
  if (addresses.length > MOST_TO_NAME) {
    refusals.push(
      `${addresses.length} addresses here aren't test recipients, more than a person can say are theirs one by one. That is a list, not a test.`,
    );
  }

  const counts = read.counts[0] ?? {};
  const sent = read.sent.map((r) => ({
    subject: r.subject,
    fireAt: r.fire_at,
    listed: r.email_only === 0,
    recipients: r.recipients,
  }));
  const toName = {
    publication: read.publication[0] ?? null,
    author: people[0] ?? null,
    serviceActed: actors.includes("service"),
    addresses,
    erased: read.erased[0]?.n ?? 0,
    pending: read.pending[0]?.n ?? 0,
    sent,
    counts,
    images: read.images.map((r) => r.storage_key),
    refusedByProvider: read.refusedByProvider.map((r) => r.email),
  };
  const fingerprint = {
    cleared: CLEARED.map((t) => counts[t] ?? 0),
    actors,
    addresses,
    sent,
    images: toName.images,
  };
  return { refusals, toName, fingerprint };
}
