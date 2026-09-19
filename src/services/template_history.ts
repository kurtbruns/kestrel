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

import { type AppSettings, getSettings, MAX_TEMPLATE, persistSettingsStmt } from "../db/settings";
import {
  getTemplateRevision,
  insertTemplateRevisionStmt,
  type TemplateRevisionRow,
} from "../db/template_revisions";
import { newId } from "../lib/ids";
import { unwrap } from "../lib/unwrap";
import { DEFAULT_EMAIL_TEMPLATE } from "../render/template_engine";

/** The id of the first-use record. Fixed, not random, so two isolates recording it
 *  at once collide on the primary key instead of writing two "revision ones": the
 *  loser's batch fails whole (the row and the pointer land together or not at all)
 *  and it reads the winner's row back. */
export const INITIAL_TEMPLATE_REVISION_ID = "initial";

/**
 * The current template revision, recording it first if the history is empty. A fresh
 * install has a template (the built-in default) with no revision behind it; the first
 * call writes that template, as it stands, as revision one and points settings at it,
 * so every send pins a revision that exists. Idempotent: every later call is two reads,
 * and two first calls at once still record one row.
 */
export async function currentTemplateRevision(db: D1Database): Promise<TemplateRevisionRow> {
  const settings = await getSettings(db);
  if (settings.emailTemplateRevision) {
    const row = await getTemplateRevision(db, settings.emailTemplateRevision);
    if (row) {
      return row;
    }
  }
  // "" means the built-in default; record its bytes, since a revision is a concrete
  // template and a later change to the built-in must not silently move this one.
  // (Settings keeps mirroring the html from here on, so "" never recurs.)
  const html = settings.emailTemplate.trim() ? settings.emailTemplate : DEFAULT_EMAIL_TEMPLATE;
  try {
    return await writeRevision(db, settings, html, null, INITIAL_TEMPLATE_REVISION_ID);
  } catch (err) {
    if (!isDuplicateRevision(err)) {
      throw err;
    }
    // Lost the race: the other isolate's batch committed the row and the pointer.
    return unwrap(await getTemplateRevision(db, INITIAL_TEMPLATE_REVISION_ID), "template revision");
  }
}

/** True for the SQLite primary-key violation on `template_revisions`. */
function isDuplicateRevision(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed:\s*template_revisions\.id/i.test(message);
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
  const revision = await writeRevision(db, await getSettings(db), html, author);
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

/** Insert the revision and point settings at it (mirroring the html) in one batch. */
async function writeRevision(
  db: D1Database,
  settings: AppSettings,
  html: string,
  author: string | null,
  id = newId(),
): Promise<TemplateRevisionRow> {
  const row: TemplateRevisionRow = { id, html, saved_at: Date.now(), author };
  const next = { ...settings, emailTemplate: html, emailTemplateRevision: row.id };
  await db.batch([insertTemplateRevisionStmt(db, row), persistSettingsStmt(db, next)]);
  return row;
}
