/**
 * The email template's history (SPEC §9): the one writer of the current template.
 *
 * The template is one layout with a history: every save writes a `template_revisions`
 * row, the current template is the latest, and a send pins the revision it was made
 * with. Two stores describe "current" — the revision row and the settings blob, whose
 * `emailTemplate` mirrors the row's html for the render path and whose
 * `emailTemplateRevision` points at it — and this module is the only thing that
 * writes them, always in one batch, so they cannot drift. History is never rewritten:
 * a restore writes a NEW revision equal to the old one.
 */

import {
  MAX_TEMPLATE,
  persistSettingsStmt,
  readSettings,
  SettingsContention,
  type SettingsSnapshot,
  updateSettingsWith,
  WRITE_RETRIES,
} from "../db/settings";
import {
  getTemplateRevision,
  insertTemplateRevisionStmt,
  revisionsWithHtml,
  type TemplateRevisionRow,
} from "../db/template_revisions";
import { newId } from "../lib/ids";
import { unwrap } from "../lib/unwrap";
import { DEFAULT_EMAIL_TEMPLATE } from "../render/template_engine";

/** The id of the first-use record. Fixed, not random, so two isolates recording it
 *  at once collide on the primary key instead of writing two "revision ones": the
 *  loser's batch fails whole (the row and the pointer land together or not at all)
 *  and it settles on whatever is current by then. */
export const INITIAL_TEMPLATE_REVISION_ID = "initial";

/**
 * The current template revision, recording it first if the history is empty. A fresh
 * install has a template (the built-in default) with no revision behind it; the first
 * call writes that template, as it stands, as revision one and points settings at it,
 * so every send pins a revision that exists. Idempotent: every later call is two reads,
 * and two first calls at once still record one row.
 *
 * The first-use record never overrides a pointer someone else set: its only intent is
 * "some revision is current". So on a lost race (the row already there, or the settings
 * CAS missed) it re-reads and takes whatever the pointer names, and points at `initial`
 * only when nothing valid is pointed at. A save's intent is different (see
 * `writeRevision`): a save does re-point after a lost CAS.
 */
export async function currentTemplateRevision(db: D1Database): Promise<TemplateRevisionRow> {
  const snapshot = await readSettings(db);
  const pointed = await pointedRevision(db, snapshot.settings);
  if (pointed) {
    return pointed;
  }
  // "" means the built-in default; record its bytes, since a revision is a concrete
  // template and a later change to the built-in must not silently move this one.
  // (Settings keeps mirroring the html from here on, so "" never recurs.)
  const { settings } = snapshot;
  const html = settings.emailTemplate.trim() ? settings.emailTemplate : DEFAULT_EMAIL_TEMPLATE;
  const row: TemplateRevisionRow = {
    id: INITIAL_TEMPLATE_REVISION_ID,
    html,
    saved_at: Date.now(),
    author: null,
  };
  try {
    const [, persisted] = await db.batch([
      insertTemplateRevisionStmt(db, row),
      persistSettingsStmt(db, pointAt(settings, row), snapshot.version),
    ]);
    if ((persisted?.meta.changes ?? 0) > 0) {
      return row;
    }
  } catch (err) {
    if (!isDuplicateRevision(err)) {
      throw err;
    }
  }
  return settleInitial(db);
}

/** The row the settings pointer names, or null when it is unset or names no row. */
async function pointedRevision(
  db: D1Database,
  settings: SettingsSnapshot["settings"],
): Promise<TemplateRevisionRow | null> {
  return settings.emailTemplateRevision
    ? getTemplateRevision(db, settings.emailTemplateRevision)
    : null;
}

/** After a lost first-use race: whatever is current now wins (the other isolate's
 *  `initial`, or a save that landed since); only an unset or dangling pointer is
 *  pointed at `initial`, under the CAS, so a concurrent save is never undone.
 *  Exported for the test that pins that guarantee; not part of the module's API. */
export async function settleInitial(db: D1Database): Promise<TemplateRevisionRow> {
  for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
    const snapshot = await readSettings(db);
    const pointed = await pointedRevision(db, snapshot.settings);
    if (pointed) {
      return pointed;
    }
    const initial = unwrap(
      await getTemplateRevision(db, INITIAL_TEMPLATE_REVISION_ID),
      "template revision",
    );
    const res = await persistSettingsStmt(
      db,
      pointAt(snapshot.settings, initial),
      snapshot.version,
    ).run();
    if ((res.meta.changes ?? 0) > 0) {
      return initial;
    }
  }
  throw new SettingsContention();
}

/** The settings blob pointing at `row`, its html mirrored. */
function pointAt(
  settings: SettingsSnapshot["settings"],
  row: TemplateRevisionRow,
): SettingsSnapshot["settings"] {
  return { ...settings, emailTemplate: row.html, emailTemplateRevision: row.id };
}

/** True for the SQLite primary-key violation on `template_revisions`. */
function isDuplicateRevision(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed:\s*template_revisions\.id/i.test(message);
}

/**
 * Which of `revisionIds` are older templates than the current one, by CONTENT: a
 * revision whose html equals the current revision's is not outdated even if its id
 * differs, so a restore (a new revision with old bytes) never flags the sends made
 * with those bytes, and a "changed since" is a change a reader could see (SPEC §6, §9).
 * A revision id with no row counts as outdated. One query for all the ids, since the
 * lists that call this are polled.
 */
export async function outdatedTemplateRevisions(
  db: D1Database,
  revisionIds: Iterable<string>,
): Promise<{ current: TemplateRevisionRow; outdated: Set<string> }> {
  const current = await currentTemplateRevision(db);
  const others = [...new Set(revisionIds)].filter((id) => id !== current.id);
  const same = others.length ? await revisionsWithHtml(db, others, current.html) : new Set();
  return { current, outdated: new Set(others.filter((id) => !same.has(id))) };
}

/** The outcome of a template save: the revision now current, and whether this save
 *  wrote it (a save whose html equals the current revision's records nothing). */
export interface TemplateSave {
  revision: TemplateRevisionRow;
  changed: boolean;
}

/**
 * Save the template: write it as a new revision and make it current. Structural
 * validation (the required variables) is the route's job; this enforces only the
 * storage cap. A save identical to the current revision is a no-op, so a client that
 * PUTs the template it just read does not mark every scheduled send as outdated.
 */
export async function saveTemplate(
  db: D1Database,
  html: string,
  author: string | null,
): Promise<TemplateSave> {
  if (html.length > MAX_TEMPLATE) {
    throw new Error(`emailTemplate must be ${MAX_TEMPLATE} characters or fewer`);
  }
  const current = await currentTemplateRevision(db);
  if (current.html === html) {
    return { revision: current, changed: false };
  }
  const revision = await writeRevision(db, await readSettings(db), html, author);
  return { revision, changed: true };
}

/**
 * Restore a past revision: a new revision equal to it becomes current, and the
 * history keeps both, so a template edit is undone the way a post edit is (SPEC §9).
 * Restoring the revision that is already current changes nothing.
 */
export async function restoreTemplateRevision(
  db: D1Database,
  id: string,
  author: string | null,
): Promise<TemplateSave | null> {
  const old = await getTemplateRevision(db, id);
  if (!old) {
    return null;
  }
  return saveTemplate(db, old.html, author);
}

/**
 * A save: insert the revision and point settings at it (mirroring the html) in one
 * batch, under the settings CAS. If another writer moved the blob between the read and
 * the batch, the batch still commits the row (it is append-only history either way)
 * but leaves the pointer untouched; the pointer is then re-applied on a fresh read, so
 * a concurrent preference save can never un-point a revision that was just written.
 * Two saves at once both keep their rows and the later re-point wins, as two saves in
 * sequence would.
 */
async function writeRevision(
  db: D1Database,
  snapshot: SettingsSnapshot,
  html: string,
  author: string | null,
): Promise<TemplateRevisionRow> {
  const row: TemplateRevisionRow = { id: newId(), html, saved_at: Date.now(), author };
  const [, pointed] = await db.batch([
    insertTemplateRevisionStmt(db, row),
    persistSettingsStmt(db, pointAt(snapshot.settings, row), snapshot.version),
  ]);
  if ((pointed?.meta.changes ?? 0) === 0) {
    await updateSettingsWith(db, (s) => pointAt(s, row));
  }
  return row;
}
