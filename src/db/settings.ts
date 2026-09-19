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
 * The double opt-in confirmation email's editable copy (SPEC §7). Kestrel owns the
 * layout, inserts the confirm link, and derives BOTH the HTML and plain-text bodies
 * from these words — so editing copy can never remove the link that records consent
 * (I1). A blank required field resolves to the built-in default at send time (see
 * `resolveConfirmationEmail`), so the email is never wordless; the reassurance line
 * may be blank, which simply drops it. Transactional, so it does not use the post
 * `emailTemplate` and carries no unsubscribe link.
 *
 * There is no layout choice: the email always leads with the publication masthead
 * (logo + name + tagline) — a transactional first-touch opens with who it is before
 * the ask — and that masthead degrades to nothing when no identity is set, so one
 * built-in layout serves a branded and an unbranded publication alike.
 */
export interface ConfirmationEmailCopy {
  /** The email subject. */
  subject: string;
  /** The message shown above the confirm button. */
  body: string;
  /** The confirm button's label (the link itself is app-generated, never authored). */
  buttonLabel: string;
  /** A quiet footer for anyone who didn't sign up; "" omits the line. */
  reassurance: string;
}

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
   *
   * This is a mirror of the CURRENT template revision's html: the template has a
   * history (`template_revisions`, SPEC §9), and the one writer that changes this
   * field (services/template_history.ts) writes the revision row and this blob in
   * the same batch, so the render path can keep reading the html from here while a
   * send pins the revision by id. Not writable through `updateSettings`.
   */
  emailTemplate: string;
  /**
   * The id of the current template revision (`template_revisions.id`), the one
   * `emailTemplate` mirrors. Null on a fresh install until the first template save, or
   * the first use that records the initial template (services/template_history.ts).
   */
  emailTemplateRevision: string | null;
  /** Editable wording of the double opt-in confirmation email (SPEC §7). */
  confirmationEmail: ConfirmationEmailCopy;
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
  emailTemplateRevision: null,
  confirmationEmail: DEFAULT_CONFIRMATION_EMAIL,
};

/** Caps so a mistake (or a compromised session) can't grow a field unboundedly. */
const MAX_TEST_RECIPIENTS = 20;
const MAX_NAME = 120;
const MAX_TAGLINE = 200;
const MAX_ADDRESS = 300;
/** The template's storage cap; enforced by the template save (services/template_history.ts). */
export const MAX_TEMPLATE = 40_000;
const MAX_CE_SUBJECT = 200;
const MAX_CE_BODY = 1000;
const MAX_CE_BUTTON = 80;
const MAX_CE_REASSURANCE = 400;

/** A patch the API accepts. The logo is set through the dedicated upload route and
 *  the email template through its history (services/template_history.ts), not here. */
export interface SettingsPatch {
  testRecipients?: string[];
  publication?: Partial<Pick<PublicationSettings, "name" | "tagline" | "address">>;
  confirmationEmail?: Partial<ConfirmationEmailCopy>;
}

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
    emailTemplateRevision:
      typeof o.emailTemplateRevision === "string" && o.emailTemplateRevision
        ? o.emailTemplateRevision
        : null,
    // A row that predates this feature has no `confirmationEmail` key at all — that's
    // "never configured", so it gets the full built-in copy (reassurance included), NOT
    // a blank-reassurance row. Only once the key exists (the operator saved copy) does a
    // blank reassurance mean "deliberately omit the footer".
    confirmationEmail:
      "confirmationEmail" in o
        ? coerceConfirmation(o.confirmationEmail)
        : { ...DEFAULT_CONFIRMATION_EMAIL },
  };
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

export async function getSettings(db: D1Database): Promise<AppSettings> {
  const row = await db.prepare("SELECT data FROM settings WHERE id = 1").first<{ data: string }>();
  if (!row) {
    return structuredClone(DEFAULT_SETTINGS);
  }
  try {
    return coerce(JSON.parse(row.data));
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/** The upsert of the whole blob, as a statement so a caller can batch it with a write
 *  it must land together with (the template save pairs it with its revision row). */
export function persistSettingsStmt(db: D1Database, next: AppSettings): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (id, data, updated_at) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET data = ?1, updated_at = ?2`,
    )
    .bind(JSON.stringify(next), Date.now());
}

async function persist(db: D1Database, next: AppSettings): Promise<void> {
  await persistSettingsStmt(db, next).run();
}

/**
 * Validate + normalize a patch, merge it onto current settings, and persist.
 * Returns the resulting settings. Throws `Error` with a human message on invalid
 * input, which the route maps to a 400.
 */
export async function updateSettings(db: D1Database, patch: SettingsPatch): Promise<AppSettings> {
  const current = await getSettings(db);
  const next: AppSettings = {
    ...current,
    publication: { ...current.publication },
    confirmationEmail: { ...current.confirmationEmail },
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

  await persist(db, next);
  return next;
}

/** Set (or clear, with `null`) the publication logo metadata, preserving the rest. */
export async function setPublicationLogo(
  db: D1Database,
  logo: PublicationLogo | null,
): Promise<AppSettings> {
  const current = await getSettings(db);
  const next: AppSettings = { ...current, publication: { ...current.publication, logo } };
  await persist(db, next);
  return next;
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
