/**
 * The re-make (SPEC §6, §9): a template or identity change re-makes every scheduled
 * send at once, after the publisher confirms it, so no scheduled send is ever on an
 * older look than the one in use. A re-make is a freeze: each scheduled send is
 * rendered again from its locked content with the branding as saved, at the same
 * fire time, and its rendered columns are rewritten in place. It is refused while any
 * scheduled send is inside the minimum lead (a freeze there would leave less than the
 * minimum window to review what it produced, I6), it never touches a send that is
 * sending or sent, and a save that leaves the email's inputs unchanged re-makes
 * nothing and asks nothing.
 *
 * One function does the whole save: it decides whether the change reaches the email
 * (`brandingDiffers`), refuses until the client has acknowledged the sends by id, then
 * writes the settings row and every re-freeze in one batch whose statements all carry
 * the same guard (`remakeGuard`), so a settings writer, a send crossing into the lead,
 * or a send scheduled in the gap makes the whole batch land as nothing rather than
 * half. The settings routes are its only caller.
 */

import type { RemakeRequiredError } from "../../shared/settings";
import { getPost } from "../db/posts";
import {
  listScheduledSends,
  remakeGuard,
  remakeSendStmt,
  type ScheduledSendRef,
} from "../db/sends";
import {
  type AppSettings,
  ensureSettingsRow,
  persistSettingsStmt,
  readSettings,
  SettingsContention,
  WRITE_RETRIES,
} from "../db/settings";
import type { AppEnv, Config } from "../env";
import { HttpError } from "../lib/errors";
import { SEND_NOW_BUFFER_MS } from "../lib/time";
import { unwrap } from "../lib/unwrap";
import { brandingDiffers, resolveBranding } from "../render/template_engine";
import { renderPost } from "./schedule";

/** What a settings save reports: the settings as saved, and the sends it re-made
 *  (empty when the change reached no email, or nothing was scheduled). */
export interface SaveOutcome {
  settings: AppSettings;
  remade: ScheduledSendRef[];
}

/** The scheduled sends inside the minimum lead as of `now`: the ones that block a
 *  re-make, and the moment after which it is no longer blocked. */
export function insideLead(
  scheduled: ScheduledSendRef[],
  now: number,
): { sends: ScheduledSendRef[]; retryAfter: number | null } {
  const sends = scheduled.filter((s) => s.fire_at < now + SEND_NOW_BUFFER_MS);
  const retryAfter = sends.length ? Math.max(...sends.map((s) => s.fire_at)) : null;
  return { sends, retryAfter };
}

function remakeRequired(sends: ScheduledSendRef[]): HttpError {
  const n = sends.length;
  // The body the editor reads (shared/settings.ts); the error and message fields are HttpError's.
  const details: Omit<RemakeRequiredError, "error" | "message"> = { sends };
  return new HttpError(
    409,
    "remake_required",
    `saving this change re-makes ${n} scheduled email${n === 1 ? "" : "s"}; pass their ids in \`remake\` to confirm`,
    details,
  );
}

function remakeTooClose(sends: ScheduledSendRef[], retryAfter: number, now: number): HttpError {
  const first = unwrap(sends[0], "send inside the lead");
  const minutes = Math.max(1, Math.ceil((first.fire_at - now) / 60_000));
  return new HttpError(
    409,
    "remake_too_close",
    `"${first.subject}" sends in ${minutes} minute${minutes === 1 ? "" : "s"}; try again once it has sent`,
    { retry_after: retryAfter, sends },
  );
}

/**
 * The read-only half of the guard, for a caller that must know before an irreversible
 * side effect (the logo's object write) whether the save would be refused: throws the
 * same refusals the write would, against the scheduled sends as of now.
 */
export async function checkRemake(
  db: D1Database,
  ack: string[] | null,
  now = Date.now(),
): Promise<ScheduledSendRef[]> {
  const scheduled = await listScheduledSends(db);
  const lead = insideLead(scheduled, now);
  if (lead.retryAfter !== null) {
    throw remakeTooClose(lead.sends, lead.retryAfter, now);
  }
  if (scheduled.some((s) => ack === null || !ack.includes(s.id))) {
    throw remakeRequired(scheduled);
  }
  return scheduled;
}

/**
 * Save the settings `derive` produces from the current ones, re-making every scheduled
 * send when the change reaches the email. `ack` is the list of send ids the client has
 * acknowledged (null for none); `beforeWrite` runs once, after the refusals have been
 * ruled out and before anything is written, for a side effect that must not happen on
 * a refusal (the logo bytes). Under the settings row's compare-and-swap: a lost race
 * re-reads, re-derives, and tries again, as every settings write does.
 */
export async function saveSettingsRemaking(
  env: AppEnv,
  config: Config,
  derive: (current: AppSettings) => AppSettings,
  ack: string[] | null,
  beforeWrite?: () => Promise<void>,
): Promise<SaveOutcome> {
  await ensureSettingsRow(env.DB);
  let sideEffectDone = false;
  const runBeforeWrite = async () => {
    if (!sideEffectDone && beforeWrite) {
      sideEffectDone = true;
      await beforeWrite();
    }
  };

  for (let attempt = 0; attempt < WRITE_RETRIES; attempt++) {
    const { settings: current, version: read } = await readSettings(env.DB);
    const version = read ?? 0;
    const next = derive(current);

    if (!brandingDiffers(resolveBranding(current, config), resolveBranding(next, config))) {
      // Not an email input: an ordinary preference save. Nothing scheduled is touched.
      await runBeforeWrite();
      const res = await persistSettingsStmt(env.DB, next, version).run();
      if ((res.meta.changes ?? 0) > 0) {
        return { settings: next, remade: [] };
      }
      continue;
    }

    const now = Date.now();
    const scheduled = await checkRemake(env.DB, ack, now);
    await runBeforeWrite();

    // Render every scheduled send in memory first, from its locked content (the
    // soft-lock is what guarantees the current revision is the one frozen at
    // schedule) with the branding as it will be saved; then one batch.
    const branding = resolveBranding(next, config);
    const renders = await Promise.all(
      scheduled.map(async (s) => {
        const post = unwrap(await getPost(env.DB, s.post_id), "post of a scheduled send");
        return renderPost(env, config, post, branding);
      }),
    );
    const guard = remakeGuard(
      version,
      now + SEND_NOW_BUFFER_MS,
      scheduled.map((s) => s.id),
    );
    // The settings write goes LAST: it bumps the row's version, and every statement
    // before it checks that version, so in the other order the re-freezes would find
    // the row already moved and land nothing.
    const results = await env.DB.batch([
      ...scheduled.map((s, i) =>
        remakeSendStmt(env.DB, s.id, unwrap(renders[i], "render"), now, guard),
      ),
      persistSettingsStmt(env.DB, next, version, guard),
    ]);
    const settingsResult = results[scheduled.length];
    if ((settingsResult?.meta.changes ?? 0) === 0) {
      // A predicate failed and nothing was written. A moved version is another
      // settings writer: try again. Otherwise a send crossed into the lead or was
      // scheduled in the gap: refuse with the list as it stands now.
      const { version: nowVersion } = await readSettings(env.DB);
      if ((nowVersion ?? 0) !== version) {
        continue;
      }
      await checkRemake(env.DB, ack);
      continue;
    }
    const remade: ScheduledSendRef[] = [];
    scheduled.forEach((s, i) => {
      if ((results[i]?.meta.changes ?? 0) > 0) {
        remade.push({ ...s, remade_at: now });
      }
    });
    return { settings: next, remade };
  }
  throw new SettingsContention();
}
