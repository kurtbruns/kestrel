/**
 * The refusals for a slug that can't be set (SPEC §4), in the words a client shows under the
 * address field. Here rather than in a route so the freeze (send/) and the routes share them.
 */

import { refusal } from "./errors";

/** A slug refused for itself: malformed, or another post's. */
export function slugRefusal(code: "slug_invalid" | "slug_taken") {
  return code === "slug_invalid"
    ? refusal(
        "slug_invalid",
        "Use lowercase letters and numbers, with single hyphens between words, up to 80 characters.",
        { field: "slug" },
      )
    : refusal("slug_taken", "Another post already has this address. Choose another.", {
        field: "slug",
      });
}

/** A change to an address that can no longer move: the post was sent, or its scheduled email,
 *  frozen before unlisted links, already links to that address. */
export function slugPermanent(field: "slug" | "slug_auto", why: "sent" | "linked") {
  return refusal(
    "slug_permanent",
    why === "sent"
      ? "This post’s archive address is fixed once it’s sent, since people may have its link."
      : "This post’s archive address is fixed: its scheduled email already links to it.",
    { field },
  );
}
