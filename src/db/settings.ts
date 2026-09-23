/**
 * App-level runtime settings: a singleton row holding a JSON blob (SPEC §9).
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
import type {
  ConfirmationEmailCopy,
  NotificationPrefs,
  SettingsPatchBody,
} from "../../shared/settings";
import { HttpError } from "../lib/errors";
import { isValidEmail, normalizeEmail } from "./subscribers";

/**
 * The publication's identity. It themes the reader surface and the admin, and rides
 * *inside* the email as its masthead/branding (the post template and the confirmation
 * email) — but it is never the email's authenticated *sender* (that is the `From:`
 * header, deploy-time), and never a frozen record (I3). The logo *bytes* live in R2
 * under `BRANDING_LOGO_KEY`, served by the public media route; here we keep only its
 * version (a cache-buster, a timestamp bumped on each upload) and content type. A blank
 * `name` falls back to the `From:` display name at render time.
 */
export interface PublicationLogo {
  version: number;
  contentType: string;
}
export interface PublicationSettings {
  name: string;
  tagline: string;
  /** Physical mailing address for the email compliance footer ("" = unset). */
  address: string;
  logo: PublicationLogo | null;
}

/**
 * The confirmation email's copy: the shape lives in shared/ (the settings surface reflects
 * it), the rules here. Kestrel owns the layout, inserts the confirm link, and derives BOTH
 * the HTML and plain-text bodies from these words, so editing copy can never remove the
 * link that records consent (I1). A blank required field resolves to the built-in default
 * at send time (see `resolveConfirmationEmail`), so the email is never wordless; the
 * reassurance line may be blank, which simply drops it. Transactional, so it does not use
 * the post `emailTemplate` and carries no unsubscribe link. There is no layout choice: the
 * email always leads with the publication masthead, which degrades to nothing when no
 * identity is set.
 */
export type { ConfirmationEmailCopy };

/** Editable, non-secret preferences. Extend here (not the schema) to add one. */
export interface AppSettings {
  /** Default recipients pre-filled into the Send-test flow. */
  testRecipients: string[];
  /** Publication identity for the reader surface + admin. */
  publication: PublicationSettings;
  /**
   * The email layout each post is sent inside — HTML with a `<style>` block and
   * `{{ variables }}` the render path fills (SPEC §9). "" means "use the built-in
   * default"; the API reflects the resolved template so a client always sees one.
   * Stored as text (no schema), validated for the required variables by the route.
   */
  emailTemplate: string;
  /** Editable wording of the double opt-in confirmation email (SPEC §7). */
  confirmationEmail: ConfirmationEmailCopy;
  /**
   * Where notifications about the publisher's sends go (SPEC §8): an address, which is a
   * preference because it holds no secret. The channel that carries them, and its
   * sender, are deploy config (SPEC §9).
   */
  notifications: NotificationPrefs;
}

/** The reserved R2 key the publication logo is stored under (served by /media). */
export const BRANDING_LOGO_KEY = "branding/logo";

/** The built-in confirmation copy — what ships until the operator edits it, and the
 *  fallback each required field resolves to when left blank (`resolveConfirmationEmail`).
 *  Kept as the single source of truth: the settings API reflects it so no client
 *  hardcodes it. */
export const DEFAULT_CONFIRMATION_EMAIL: ConfirmationEmailCopy = {
  subject: "Confirm your subscription",
  body: "Thanks for subscribing. Please confirm your email address to start receiving the newsletter.",
  buttonLabel: "Confirm subscription",
  reassurance: "If you didn't request this, you can safely ignore this email.",
};

export const DEFAULT_SETTINGS: AppSettings = {
  testRecipients: [],
  publication: { name: "", tagline: "", address: "", logo: null },
  emailTemplate: "",
  confirmationEmail: DEFAULT_CONFIRMATION_EMAIL,
  notifications: { to: "" },
};

/** Caps so a mistake (or a compromised session) can't grow a field unboundedly. */
const MAX_TEST_RECIPIENTS = 20;
const MAX_NAME = 120;
const MAX_TAGLINE = 200;
const MAX_ADDRESS = 300;
const MAX_TEMPLATE = 40_000;
const MAX_CE_SUBJECT = 200;
const MAX_CE_BODY = 1000;
const MAX_CE_BUTTON = 80;
const MAX_CE_REASSURANCE = 400;

/**
 * A patch the API accepts: the editable fields of a save, as the wire body carries them
 * (shared/settings.ts) minus the acknowledgement, which the route consumes before the
 * patch reaches the store. The logo is set through the dedicated upload route, not here.
 */
export type SettingsPatch = Omit<SettingsPatchBody, "remake">;

function coercePublication(raw: unknown): PublicationSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const lr = o.logo as Record<string, unknown> | null | undefined;
  const logo =
    lr && typeof lr === "object" && typeof lr.version === "number"
      ? { version: lr.version, contentType: str(lr.contentType) || "image/png" }
      : null;
  return {
    name: str(o.name).slice(0, MAX_NAME),
    tagline: str(o.tagline).slice(0, MAX_TAGLINE),
    address: str(o.address).slice(0, MAX_ADDRESS),
    logo,
  };
}

/** Coerce a stored (possibly partial / legacy) confirmation blob. Stores the raw
 *  strings, blanks and all; `resolveConfirmationEmail` fills blanks at send time. */
function coerceConfirmation(raw: unknown): ConfirmationEmailCopy {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    subject: str(o.subject).slice(0, MAX_CE_SUBJECT),
    body: str(o.body).slice(0, MAX_CE_BODY),
    buttonLabel: str(o.buttonLabel).slice(0, MAX_CE_BUTTON),
    reassurance: str(o.reassurance).slice(0, MAX_CE_REASSURANCE),
  };
}

/** Merge a stored (possibly partial / legacy) blob onto the defaults. */
function coerce(raw: unknown): AppSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.testRecipients) ? o.testRecipients : [];
  return {
    testRecipients: list.filter((e): e is string => typeof e === "string"),
    publication: coercePublication(o.publication),
    emailTemplate:
      typeof o.emailTemplate === "string" ? o.emailTemplate.slice(0, MAX_TEMPLATE) : "",
    // A row that predates this feature has no `confirmationEmail` key at all — that's
    // "never configured", so it gets the full built-in copy (reassurance included), NOT
    // a blank-reassurance row. Only once the key exists (the operator saved copy) does a
    // blank reassurance mean "deliberately omit the footer".
    confirmationEmail:
      "confirmationEmail" in o
        ? coerceConfirmation(o.confirmationEmail)
        : { ...DEFAULT_CONFIRMATION_EMAIL },
    notifications: coerceNotifications(o.notifications),
  };
}

/** Coerce a stored notifications blob; anything but a string address reads as none. */
function coerceNotifications(raw: unknown): NotificationPrefs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { to: typeof o.to === "string" ? o.to : "" };
}

/**
 * Resolve stored confirmation copy to what the email actually uses: a blank required
 * field (subject, body, button) falls back to the built-in default so the message is
 * never wordless; the reassurance line is used as stored (blank drops it). This is the
 * confirmation analogue of a blank `emailTemplate` resolving to the built-in default.
 */
export function resolveConfirmationEmail(settings: AppSettings): ConfirmationEmailCopy {
  const c = settings.confirmationEmail;
  const d = DEFAULT_CONFIRMATION_EMAIL;
  return {
    subject: c.subject.trim() || d.subject,
    body: c.body.trim() || d.body,
    buttonLabel: c.buttonLabel.trim() || d.buttonLabel,
    reassurance: c.reassurance,
  };
}

/**
 * The blob plus its version: the row's `updated_at`, or null when no row exists yet.
 * Every write is a read-merge-write of the whole blob, and two writers can overlap
 * (the dashboard's identity save and its logo upload; the editor and Claude), so a
 * writer hands the version it read back to `persistSettingsStmt`, which writes only
 * while the row is still at that version. A lost update becomes a retry instead of a
 * silently dropped field.
 */
export interface SettingsSnapshot {
  settings: AppSettings;
  version: number | null;
}

export async function readSettings(db: D1Database): Promise<SettingsSnapshot> {
  const row = await db
    .prepare("SELECT data, updated_at FROM settings WHERE id = 1")
    .first<{ data: string; updated_at: number }>();
  if (!row) {
    return { settings: structuredClone(DEFAULT_SETTINGS), version: null };
  }
  try {
    return { settings: coerce(JSON.parse(row.data)), version: row.updated_at };
  } catch {
    return { settings: structuredClone(DEFAULT_SETTINGS), version: row.updated_at };
  }
}

export async function getSettings(db: D1Database): Promise<AppSettings> {
  return (await readSettings(db)).settings;
}

/**
 * Make sure the singleton row exists, so every write is an UPDATE with one shape
 * (a compare-and-swap on `updated_at`, plus any guard the caller adds). A fresh
 * install has no row; a blank blob at version 0 reads exactly as no row does.
 */
export async function ensureSettingsRow(db: D1Database): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO settings (id, data, updated_at) VALUES (1, '{}', 0)")
    .run();
}

/** An extra WHERE fragment (with its binds) a caller appends to a settings write, so
 *  the write lands only while the fragment holds: the send re-make's guards. */
export interface WriteGuard {
  sql: string;
  binds: unknown[];
}

/**
 * The compare-and-swap write of the whole blob, as a statement so a caller can batch
 * it with writes it must land together with (the re-make pairs it with one re-freeze
 * per scheduled send). `expected` is the version the caller read (`readSettings`,
 * after `ensureSettingsRow`): the update applies only while the row is still at it,
 * so `meta.changes === 0` means another writer got there first, or a `guard` failed.
 * The new version is strictly greater than the old one even within one millisecond,
 * so a version never repeats.
 */
export function persistSettingsStmt(
  db: D1Database,
  next: AppSettings,
  expected: number,
  guard?: WriteGuard,
): D1PreparedStatement {
  const extra = guard ? ` AND ${guard.sql}` : "";
  return db
    .prepare(
      `UPDATE settings SET data = ?, updated_at = MAX(?, updated_at + 1)
        WHERE id = 1 AND updated_at = ?${extra}`,
    )
    .bind(JSON.stringify(next), Date.now(), expected, ...(guard?.binds ?? []));
}

/** How many times a writer re-reads and retries when another writer wins the CAS.
 *  Contention is two clients on one row; a handful of retries settles it. */
export const WRITE_RETRIES = 5;

/** The retries are spent: another writer is hammering the row. A 409, so the client
 *  retries the write rather than reading it as its own bad input (400) or a server
 *  fault (500). */
export class SettingsContention extends HttpError {
  constructor() {
    super(409, "conflict", "settings changed concurrently; try again");
  }
}

/**
 * Read the blob, derive the next one, and persist it under the CAS; on a lost race,
 * re-read and derive again. `derive` must be pure over its input (it runs once per
 * attempt). Throws after the retries are spent, which in practice means a writer is
 * hammering the row.
 */
export async function updateSettingsWith(
  db: D1Database,
  derive: (current: AppSettings) => AppSettings,
): Promise<AppSettings> {
  await ensureSettingsRow(db);
  for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
    const { settings, version } = await readSettings(db);
    const next = derive(settings);
    const res = await persistSettingsStmt(db, next, version ?? 0).run();
    if ((res.meta.changes ?? 0) > 0) {
      return next;
    }
  }
  throw new SettingsContention();
}

/**
 * Validate + normalize a patch, merge it onto current settings, and persist.
 * Returns the resulting settings. Throws `Error` with a human message on invalid
 * input, which the route maps to a 400.
 */
export async function updateSettings(db: D1Database, patch: SettingsPatch): Promise<AppSettings> {
  return updateSettingsWith(db, (current) => applyPatch(current, patch));
}

/** Merge a validated patch onto the current settings (pure; throws on invalid input). */
export function applyPatch(current: AppSettings, patch: SettingsPatch): AppSettings {
  const next: AppSettings = {
    ...current,
    publication: { ...current.publication },
    confirmationEmail: { ...current.confirmationEmail },
    notifications: { ...current.notifications },
  };

  if (patch.testRecipients !== undefined) {
    next.testRecipients = normalizeRecipients(patch.testRecipients);
  }
  if (patch.publication !== undefined) {
    const p = patch.publication;
    if (p.name !== undefined) {
      next.publication.name = normalizeText(p.name, "name", MAX_NAME);
    }
    if (p.tagline !== undefined) {
      next.publication.tagline = normalizeText(p.tagline, "tagline", MAX_TAGLINE);
    }
    if (p.address !== undefined) {
      next.publication.address = normalizeText(p.address, "address", MAX_ADDRESS);
    }
  }
  if (patch.emailTemplate !== undefined) {
    // Structural validation (required variables, warnings) is the route's job; here
    // we only enforce the type + storage cap. "" resets to the built-in default.
    if (typeof patch.emailTemplate !== "string") {
      throw new Error("emailTemplate must be a string");
    }
    if (patch.emailTemplate.length > MAX_TEMPLATE) {
      throw new Error(`emailTemplate must be ${MAX_TEMPLATE} characters or fewer`);
    }
    next.emailTemplate = patch.emailTemplate;
  }
  if (patch.confirmationEmail !== undefined) {
    // Words only: trim + cap each field. A blank stays blank here and resolves to the
    // built-in default at send time (resolveConfirmationEmail), so there is no invalid
    // value to reject — the confirm link and layout are never the operator's to break.
    const c = patch.confirmationEmail;
    if (c.subject !== undefined) {
      next.confirmationEmail.subject = normalizeText(c.subject, "subject", MAX_CE_SUBJECT);
    }
    if (c.body !== undefined) {
      next.confirmationEmail.body = normalizeText(c.body, "message", MAX_CE_BODY);
    }
    if (c.buttonLabel !== undefined) {
      next.confirmationEmail.buttonLabel = normalizeText(
        c.buttonLabel,
        "button label",
        MAX_CE_BUTTON,
      );
    }
    if (c.reassurance !== undefined) {
      next.confirmationEmail.reassurance = normalizeText(
        c.reassurance,
        "reassurance line",
        MAX_CE_REASSURANCE,
      );
    }
  }
  if (patch.notifications?.to !== undefined) {
    next.notifications.to = normalizeNotifyTo(patch.notifications.to);
  }
  return next;
}

/** One address, trimmed and lowercased, or "" to turn notifications off. */
function normalizeNotifyTo(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("notifications address must be a string");
  }
  const email = normalizeEmail(raw);
  if (email && !isValidEmail(email)) {
    throw new Error(`not a valid email address: ${raw}`);
  }
  return email;
}

/** The settings with the logo metadata set (or cleared, with `null`); pure. */
export function withPublicationLogo(
  current: AppSettings,
  logo: PublicationLogo | null,
): AppSettings {
  return { ...current, publication: { ...current.publication, logo } };
}

/** Set (or clear, with `null`) the publication logo metadata, preserving the rest. */
export async function setPublicationLogo(
  db: D1Database,
  logo: PublicationLogo | null,
): Promise<AppSettings> {
  return updateSettingsWith(db, (current) => withPublicationLogo(current, logo));
}

function normalizeText(v: unknown, what: string, max: number): string {
  if (typeof v !== "string") {
    throw new Error(`${what} must be a string`);
  }
  return v.trim().slice(0, max);
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
