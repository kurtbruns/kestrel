// The publication's display name, as every surface shows it: the email, the reader pages,
// the confirmation email, and the editor's previews of them (SPEC §9). One function, so
// no two surfaces can name the same publication differently.

/** The display name of a `From:` header: `Birds Weekly <hello@birds.example>` and
 *  `"Birds Weekly" <hello@birds.example>` give `Birds Weekly`; a bare address, or an
 *  address in angle brackets alone, gives "". A quoted name's escapes are undone. */
export function fromDisplayName(fromAddress: string): string {
  const header = fromAddress.trim();
  const lt = header.lastIndexOf("<");
  if (lt < 0 || !header.endsWith(">")) {
    return "";
  }
  const display = header.slice(0, lt).trim();
  if (display.length >= 2 && display.startsWith('"') && display.endsWith('"')) {
    return display.slice(1, -1).replace(/\\(.)/g, "$1").trim();
  }
  return display;
}

/** The name a publication goes by: the one the publisher set, else the sender's display
 *  name, else "" (never a made-up name, so a surface with none words itself without one). */
export function publicationName(name: string, fromAddress: string): string {
  return name || fromDisplayName(fromAddress);
}
