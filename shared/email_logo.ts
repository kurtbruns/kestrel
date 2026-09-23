// The email's logo image, spelled once for the render path and the Template page's
// sample preview, so the preview shows exactly the sign-off the email will carry.

const escapeAttr = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * What `{{ publication.logo }}` fills: the logo as an `<img>`, or nothing at all when no
 * logo is set. An `<img src="">` is a broken image in every mail client, and a sent
 * email is frozen into the permanent archive, so a missing logo renders no element
 * rather than an empty one. `alt` is the publication name.
 */
export function emailLogoHtml(logoUrl: string, name: string): string {
  if (!logoUrl) {
    return "";
  }
  return `<img class="logo" src="${escapeAttr(logoUrl)}" alt="${escapeAttr(name)}" width="44" height="44" />`;
}
