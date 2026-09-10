/**
 * App-level runtime settings: a singleton row holding a JSON blob (SPEC §8).
 *
 * This is the ONLY mutable, in-app configuration. It holds runtime preferences
 * the operator sets from the editor — never secrets or deploy-time infrastructure
 * (the provider, credentials, Access, origins), which live in env/secrets and are
 * documented in docs/setup/. Keeping that line bright is a safety property: a
 * compromised admin session can read/write settings but can never reach a secret.
 *
 * The typed shape lives here (not in the schema) so adding a preference is a code
 * change, not a migration. Reads always merge the stored blob onto DEFAULTS, so a
 * field added here is safely absent-then-defaulted on existing rows.
 */
import { isValidEmail, normalizeEmail } from "./subscribers";

/** Editable, non-secret preferences. Extend here (not the schema) to add one. */
export interface AppSettings {
  /** Default recipients pre-filled into the Send-test flow (issue #26). */
  testRecipients: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  testRecipients: [],
};

/** Cap the stored list so a mistake can't grow it unboundedly. */
const MAX_TEST_RECIPIENTS = 20;

/** Merge a stored (possibly partial / legacy) blob onto the defaults. */
function coerce(raw: unknown): AppSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.testRecipients) ? o.testRecipients : [];
  return {
    testRecipients: list.filter((e): e is string => typeof e === "string"),
  };
}

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const row = await db.prepare("SELECT data FROM settings WHERE id = 1").first<{ data: string }>();
  if (!row) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    return coerce(JSON.parse(row.data));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Validate + normalize a patch, merge it onto current settings, and persist.
 * Returns the resulting settings. Throws `Error` with a human message on invalid
 * input, which the route maps to a 400.
 */
export async function updateSettings(
  db: D1Database,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const current = await getSettings(db);
  const next: AppSettings = { ...current };

  if (patch.testRecipients !== undefined) {
    next.testRecipients = normalizeRecipients(patch.testRecipients);
  }

  await db
    .prepare(
      `INSERT INTO settings (id, data, updated_at) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET data = ?1, updated_at = ?2`,
    )
    .bind(JSON.stringify(next), Date.now())
    .run();
  return next;
}

/** Trim, lowercase, validate, dedupe (order-preserving), and cap the list. */
function normalizeRecipients(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new Error("testRecipients must be a list of email addresses");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") {
      throw new Error("each test recipient must be a string");
    }
    const email = normalizeEmail(raw);
    if (!email) {
      continue;
    }
    if (!isValidEmail(email)) {
      throw new Error(`not a valid email address: ${raw}`);
    }
    if (seen.has(email)) {
      continue;
    }
    seen.add(email);
    out.push(email);
  }
  if (out.length > MAX_TEST_RECIPIENTS) {
    throw new Error(`at most ${MAX_TEST_RECIPIENTS} test recipients`);
  }
  return out;
}
