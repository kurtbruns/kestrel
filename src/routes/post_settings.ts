/**
 * A post's settings as a request carries them (SPEC §4, §5): its listing (`email_only`) and its
 * archive address (`slug`, `slug_auto`). The listing route, Schedule, Send now, and a reschedule
 * all read them here and resolve them through the same rules, so a slug is refused the same way
 * wherever it is set, before anything is written.
 */

import type { PostRow, PublishingInput, SlugRefusal } from "../db/posts";
import { resolveSlug } from "../db/posts";
import { fieldError, type JsonObject, optBoolean, optString } from "../lib/body";
import { refusal } from "../lib/errors";

/** The settings fields of a request body, each absent when the request leaves it as it is. */
export interface SettingsBody {
  emailOnly?: boolean;
  slug?: string;
  slugAuto?: boolean;
}

/** Read the settings fields: a wrong type is a 400 naming the field, and a slug can't be set by
 *  hand while asking it to follow the subject. */
export function readSettingsBody(body: JsonObject): SettingsBody {
  const emailOnly = optBoolean(body, "email_only");
  const slug = optString(body, "slug");
  const slugAuto = optBoolean(body, "slug_auto");
  if (slug !== undefined && slugAuto === true) {
    throw fieldError("slug", "slug cannot be set while slug_auto is true");
  }
  return { emailOnly, slug, slugAuto };
}

/** The refusal for a slug that can't be set, in the words a client shows under the field. */
export function slugRefusal(code: SlugRefusal) {
  return code === "slug_invalid"
    ? refusal(
        400,
        "slug_invalid",
        "Use lowercase letters and numbers, with single hyphens between words, up to 80 characters.",
        { field: "slug" },
      )
    : refusal(409, "slug_taken", "Another post already has this address. Choose another.", {
        field: "slug",
      });
}

/**
 * Resolve a settings change against the post and every other post, or refuse it. A published
 * post's address is fixed (SPEC §4): naming the slug it has is fine, and any other change to it
 * is a 409 `slug_permanent`. A malformed slug is a 400 `slug_invalid`, and one another post
 * holds a 409 `slug_taken`; both name `slug`, and nothing is written.
 */
export async function resolveSettings(
  db: D1Database,
  post: PostRow,
  body: SettingsBody,
  published: boolean,
): Promise<PublishingInput> {
  const input: PublishingInput = { emailOnly: body.emailOnly };
  if (body.slug === undefined && body.slugAuto === undefined) {
    return input;
  }
  if (published) {
    const moves = (body.slug !== undefined && body.slug !== post.slug) || body.slugAuto === true;
    if (moves) {
      throw refusal(
        409,
        "slug_permanent",
        "This post’s archive address is fixed once it’s sent, since people may have its link.",
        { field: body.slug !== undefined ? "slug" : "slug_auto" },
      );
    }
    return input;
  }
  const resolved = await resolveSlug(
    db,
    { postId: post.id, slug: post.slug, slugAuto: post.slug_auto, subject: post.subject },
    { slug: body.slug, slugAuto: body.slugAuto },
  );
  if ("refused" in resolved) {
    throw slugRefusal(resolved.refused);
  }
  input.slug = resolved;
  return input;
}
