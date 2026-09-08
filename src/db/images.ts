/** Image metadata queries. The bytes live in R2; this is the index over them. */
import { newId } from "../lib/ids";

export interface ImageRow {
  id: string;
  post_id: string;
  filename: string;
  storage_key: string;
  content_type: string;
  width: number | null;
  height: number | null;
  created_at: number;
}

export interface ImageInput {
  postId: string;
  filename: string;
  storageKey: string;
  contentType: string;
  width: number | null;
  height: number | null;
}

export async function listImages(db: D1Database, postId: string): Promise<ImageRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM images WHERE post_id = ? ORDER BY filename ASC")
    .bind(postId)
    .all<ImageRow>();
  return results;
}

export function getImage(
  db: D1Database,
  postId: string,
  filename: string,
): Promise<ImageRow | null> {
  return db
    .prepare("SELECT * FROM images WHERE post_id = ? AND filename = ?")
    .bind(postId, filename)
    .first<ImageRow>();
}

/** Insert, or update in place when this post already has an image of that name. */
export async function upsertImage(db: D1Database, input: ImageInput): Promise<ImageRow> {
  const existing = await getImage(db, input.postId, input.filename);
  const now = Date.now();
  if (existing) {
    await db
      .prepare(
        "UPDATE images SET storage_key = ?, content_type = ?, width = ?, height = ?, created_at = ? WHERE id = ?",
      )
      .bind(input.storageKey, input.contentType, input.width, input.height, now, existing.id)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO images (id, post_id, filename, storage_key, content_type, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        newId(),
        input.postId,
        input.filename,
        input.storageKey,
        input.contentType,
        input.width,
        input.height,
        now,
      )
      .run();
  }
  return (await getImage(db, input.postId, input.filename))!;
}

export async function deleteImageRow(
  db: D1Database,
  postId: string,
  filename: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM images WHERE post_id = ? AND filename = ?")
    .bind(postId, filename)
    .run();
}
