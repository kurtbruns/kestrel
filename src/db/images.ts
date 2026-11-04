/** Image metadata queries. The bytes live in R2; this is the index over them. */
import { newId } from "../lib/ids";
import { unwrap } from "../lib/unwrap";

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

/**
 * Insert an image under its name, or answer null when this post already has that name. The
 * table's uniqueness decides, so of two uploads at once only one can take a name.
 */
export async function insertImageIfNameFree(
  db: D1Database,
  input: ImageInput,
): Promise<ImageRow | null> {
  const { meta } = await db
    .prepare(
      "INSERT INTO images (id, post_id, filename, storage_key, content_type, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (post_id, filename) DO NOTHING",
    )
    .bind(
      newId(),
      input.postId,
      input.filename,
      input.storageKey,
      input.contentType,
      input.width,
      input.height,
      Date.now(),
    )
    .run();
  if (meta.changes === 0) {
    return null;
  }
  return unwrap(await getImage(db, input.postId, input.filename), "image");
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
