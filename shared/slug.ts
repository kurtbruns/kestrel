/** Derive a URL-safe slug from arbitrary text. Returns "" when nothing usable remains. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritical marks
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

/**
 * The slug a post gets when its subject slugifies to nothing (a new post, whose subject
 * starts empty): the server numbers it `post`, `post-2`, …, and the editor reads that
 * as still tracking the subject, so typing the first subject replaces it.
 */
export const EMPTY_SUBJECT_SLUG = "post";
