/** A post's two addresses (SPEC §4, §5): what they are, as the API reports them on a post, and
 *  when a published post's archive address answers, one rule for the archive page and every
 *  link the API reports to it, so the two cannot disagree. */

import { archivePostUrl, unlistedPostUrl } from "../../shared/archive_url";
import type { Post } from "../../shared/posts";
import type { Publication } from "../db/sends";
import type { Config } from "../env";

/**
 * A stored post as the API answers it: with its archive address and unlisted link, absolute, so
 * a client reads where the post goes rather than building it, and where it stands for readers
 * (SPEC §5). `publication` is its published send, or null while unpublished: `published_at` is
 * when that send started, and `archive_live` whether the archive address shows the post now.
 */
export function withAddresses<T extends Pick<Post, "slug" | "unlisted_token" | "email_only">>(
  config: Pick<Config, "appOrigin" | "archiveOrigin" | "archiveBasePath">,
  post: T,
  publication: Publication | null,
): T & Pick<Post, "archive_url" | "unlisted_url" | "published_at" | "archive_live"> {
  return {
    ...post,
    archive_url: archivePostUrl(config.archiveOrigin, config.archiveBasePath, post.slug),
    unlisted_url: unlistedPostUrl(config.appOrigin, post.unlisted_token),
    published_at: publication?.published_at ?? null,
    archive_live:
      publication !== null &&
      archiveAnswers({ emailOnly: post.email_only, webLink: publication.web_link }),
  };
}

/**
 * Whether a published post's archive address shows its page: only while the post is listed,
 * so making a post email only takes the address down, while the address stays the post's
 * (SPEC §4). The exception is a post whose published send carries that address as its "view
 * in browser" link (a send frozen before unlisted links, `webLink: "archive"`): every copy of
 * that email links there, so it answers whatever the listing.
 */
export function archiveAnswers(post: {
  emailOnly: boolean;
  webLink: "unlisted" | "archive";
}): boolean {
  return !post.emailOnly || post.webLink === "archive";
}
