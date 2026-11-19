/**
 * Delete a send's post's unused images when the send first goes out (SPEC §4, §6). "Unused" is
 * the render's own answer (`imagesUsedBy`) on the post's current revision, which the lock holds
 * to the one the email was frozen from, so an image the email uses is never deleted (I3).
 *
 * The send loop calls this once the send is `sending`, and only while its audience isn't fixed
 * yet, so it never runs at schedule (a cancel would leave a draft missing its images) and never
 * inside the batches. It is safe to run twice: a deleted image is no longer a row. Nothing here
 * can stop the send: a failure is logged and its images stay, the R2 object first, then the row,
 * so a failure never leaves an object no row names.
 */

import * as images from "../db/images";
import { currentMarkdown } from "../db/posts";
import type { SendRow } from "../db/sends";
import type { AppEnv } from "../env";
import { errorFields, log } from "../lib/log";
import { buildImageMap } from "../render/image_urls";
import { imagesUsedBy } from "../render/markdown";
import type { Budget } from "./budget";

/** What the removal can cost: the post's Markdown, its images, and the delete of their rows, in
 *  D1 statements, and one R2 request a chunk of `R2_DELETE_LIMIT` keys. */
export const REMOVE_COST = 3;

/** The most keys one R2 delete takes. */
const R2_DELETE_LIMIT = 1000;

/** Delete the images the post's body doesn't use, charging `budget` for the R2 requests (the
 *  metered `db` charges the statements). Never throws. */
export async function removeUnusedImages(
  env: AppEnv,
  db: D1Database,
  budget: Budget,
  send: Pick<SendRow, "id" | "post_id">,
  mediaBase: string,
): Promise<void> {
  const tags = { sendId: send.id, postId: send.post_id };
  let unused: images.ImageRow[] = [];
  try {
    const rows = await images.listImages(db, send.post_id);
    if (rows.length === 0) {
      return;
    }
    const markdown = await currentMarkdown(db, send.post_id);
    if (markdown === null) {
      return;
    }
    const map = buildImageMap(rows);
    const used = imagesUsedBy(markdown, map, mediaBase);
    unused = rows.filter((row) => !used.has(row));
    if (unused.length === 0) {
      return;
    }
    for (let i = 0; i < unused.length; i += R2_DELETE_LIMIT) {
      budget.request();
      await env.MEDIA.delete(unused.slice(i, i + R2_DELETE_LIMIT).map((row) => row.storage_key));
    }
    await images.deleteImageRows(
      db,
      unused.map((row) => row.id),
    );
    log.info("send.images_removed", { ...tags, count: unused.length });
  } catch (err) {
    log.warn("send.images_unremoved", { ...tags, count: unused.length, ...errorFields(err) });
  }
}
