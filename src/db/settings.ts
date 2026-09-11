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

/**
 * The publication's web-reader + dashboard identity. It themes the reader surface
 * and the admin — never the email (whose identity is the `From:` header) and never
 * a frozen record (I3). The logo *bytes* live in R2 under `BRANDING_LOGO_KEY`,
 * served by the public media route; here we keep only its version (a cache-buster,
 * a timestamp bumped on each upload) and content type. A blank `name` falls back to
 * the `From:` display name at render time.
 */
export interface PublicationLogo {
  version: number;
  contentType: string;
}
export interface PublicationSettings {
  name: string;
  tagline: string;
  /** "" = use the theme accent; otherwise a validated `#rrggbb`. */
  brandColor: string;
  logo: PublicationLogo | null;
}

/** Editable, non-secret preferences. Extend here (not the schema) to add one. */
export interface AppSettings {
  /** Default recipients pre-filled into the Send-test flow. */
  testRecipients: string[];
  /** Publication identity for the reader surface + admin. */
  publication: PublicationSettings;
}

/** The reserved R2 key the publication logo is stored under (served by /media). */
export const BRANDING_LOGO_KEY = "branding/logo";

export const DEFAULT_SETTINGS: AppSettings = {
  testRecipients: [],
  publication: { name: "", tagline: "", brandColor: "", logo: null },
};

/** Caps so a mistake (or a compromised session) can't grow a field unboundedly. */
const MAX_TEST_RECIPIENTS = 20;
const MAX_NAME = 120;
const MAX_TAGLINE = 200;

/** A patch the API accepts. Logo is set through the dedicated upload route, not here. */
export interface SettingsPatch {
  testRecipients?: string[];
  publication?: Partial<Pick<PublicationSettings, "name" | "tagline" | "brandColor">>;
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
    brandColor: str(o.brandColor),
    logo,
  };
}

/** Merge a stored (possibly partial / legacy) blob onto the defaults. */
function coerce(raw: unknown): AppSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.testRecipients) ? o.testRecipients : [];
  return {
    testRecipients: list.filter((e): e is string => typeof e === "string"),
    publication: coercePublication(o.publication),
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

async function persist(db: D1Database, next: AppSettings): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (id, data, updated_at) VALUES (1, ?1, ?2)
       ON CONFLICT (id) DO UPDATE SET data = ?1, updated_at = ?2`,
    )
    .bind(JSON.stringify(next), Date.now())
    .run();
}

/**
 * Validate + normalize a patch, merge it onto current settings, and persist.
 * Returns the resulting settings. Throws `Error` with a human message on invalid
 * input, which the route maps to a 400.
 */
export async function updateSettings(db: D1Database, patch: SettingsPatch): Promise<AppSettings> {
  const current = await getSettings(db);
  const next: AppSettings = { ...current, publication: { ...current.publication } };

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
    if (p.brandColor !== undefined) {
      next.publication.brandColor = normalizeBrandColor(p.brandColor);
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

/** Normalize a brand color to lowercase `#rrggbb`; "" clears it. Throws on invalid. */
export function normalizeBrandColor(v: unknown): string {
  if (typeof v !== "string") {
    throw new Error("brandColor must be a string");
  }
  const s = v.trim();
  if (s === "") {
    return "";
  }
  const m = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(s);
  if (!m) {
    throw new Error("brandColor must be a hex color like #2563eb");
  }
  const [, group = ""] = m;
  const h = group.toLowerCase();
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  return `#${full}`;
}

/** A readable text color (#111 / #fff) for text on a filled `brandColor` swatch. */
export function readableTextColor(hex: string): string {
  const h = hex.replace(/^#/, "");
  if (h.length !== 6) {
    return "#111111";
  }
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111111" : "#ffffff";
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
