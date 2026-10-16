/**
 * A post's settings as a request carries them (SPEC §4, §5): its listing (`email_only`) and its
 * archive address (`slug`, `slug_auto`). The settings route, Schedule, and Send now
 * all read them here and resolve them through the same rules, so a slug is refused the same way
 * wherever it is set, before anything is written.
 */

import type { PostRow, PublishingInput } from "../db/posts";
import { isSlugCollision, resolveSlug, setPublishing } from "../db/posts";
import { getActiveSendForPost, publishedSendForPost } from "../db/sends";
import { fieldError, type JsonObject, optBoolean, optString } from "../lib/body";
import { notFound } from "../lib/errors";
import { slugPermanent, slugRefusal } from "../lib/slug_refusals";

/** How many times a settings write whose slug the server chose runs before a collision is
 *  refused. */
const SLUG_ATTEMPTS = 3;

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

/**
 * Resolve a settings change against the post and every other post, or refuse it. The address is
 * fixed once the post's send starts, and while its scheduled send's email (frozen before unlisted
 * links) carries it (SPEC §4): naming the slug it has is fine, and any other change to it is a
 * 409 `slug_permanent`. A malformed slug is a 400 `slug_invalid`, and one another post holds a
 * 409 `slug_taken`; both name `slug`, and nothing is written.
 */
export async function resolveSettings(
  db: D1Database,
  post: PostRow,
  body: SettingsBody,
): Promise<PublishingInput> {
  const input: PublishingInput = { emailOnly: body.emailOnly };
  if (body.slug === undefined && body.slugAuto === undefined) {
    return input;
  }
  const fixed = await addressFixed(db, post);
  if (fixed) {
    const moves = (body.slug !== undefined && body.slug !== post.slug) || body.slugAuto === true;
    if (moves) {
      throw slugPermanent(body.slug !== undefined ? "slug" : "slug_auto", fixed);
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

/**
 * Write a resolved settings change, answering whether anything changed. The checks in
 * `resolveSettings` ran before the write, so the write holds two of them itself. A slug another
 * post took in between is a 409 `slug_taken` when the request set it by hand; one that follows
 * the subject is resolved again, since the request never named it. A send that started in
 * between is a 409 `slug_permanent`. Either way nothing is written, the listing included.
 */
export async function applySettings(
  db: D1Database,
  post: PostRow,
  body: SettingsBody,
  resolved: PublishingInput,
): Promise<boolean> {
  let input = resolved;
  let outcome: Awaited<ReturnType<typeof setPublishing>>;
  for (let attempt = 1; ; attempt++) {
    try {
      outcome = await setPublishing(db, post, input);
      break;
    } catch (err) {
      if (!isSlugCollision(err)) {
        throw err;
      }
      if (body.slug !== undefined || attempt >= SLUG_ATTEMPTS) {
        throw slugRefusal("slug_taken");
      }
      input = await resolveSettings(db, post, body);
    }
  }
  if (outcome === "missing") {
    throw notFound("post");
  }
  if (outcome === "address_fixed") {
    throw slugPermanent(body.slug !== undefined ? "slug" : "slug_auto", "sent");
  }
  return outcome === "changed";
}

/** Why a post's address can no longer move, or null while it can: its send has started, or its
 *  scheduled email, frozen before unlisted links, already links to it. */
async function addressFixed(db: D1Database, post: PostRow): Promise<"sent" | "linked" | null> {
  if (await publishedSendForPost(db, post.id)) {
    return "sent";
  }
  const active = await getActiveSendForPost(db, post.id);
  return active?.web_link === "archive" ? "linked" : null;
}
