/** When a published post's archive address answers (SPEC §5): one rule for the archive page
 *  and every link the API reports to it, so the two cannot disagree. */

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
