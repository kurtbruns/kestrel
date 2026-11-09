// The sender every email comes from, as the publication's name and the deploy-time
// `FROM_ADDRESS` give it (SPEC §9). One module for both runtimes, so the `From:` the Worker
// hands a provider and the sender the editor shows are built by the same rule: the address
// is deploy-time, the display name follows the publication name, and a name written into
// `FROM_ADDRESS` overrides it. A notification to the publisher has its own name over the same
// address (`notificationSender`).

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

/** The address alone of a `From:` header, with or without a display name. */
export function fromAddressOnly(fromAddress: string): string {
  const header = fromAddress.trim();
  const m = /<([^>]*)>\s*$/.exec(header);
  return (m?.[1] ?? header).trim();
}

/** The name a `From:` header carries, as a reader sees it (SPEC §9): a name written into
 *  `FROM_ADDRESS` at deploy, else the publication's name, else "", which sends with no
 *  display name rather than one the publisher didn't choose. */
export function senderName(publicationName: string, fromAddress: string): string {
  return fromDisplayName(fromAddress) || publicationName;
}

/** A sender as every email carries it: a display name ("" for none) and the address. */
export interface Sender {
  name: string;
  address: string;
}

/** The sender the rule gives a publication name and the deploy-time `FROM_ADDRESS`. */
export function sender(publicationName: string, fromAddress: string): Sender {
  return {
    name: senderName(publicationName, fromAddress),
    address: fromAddressOnly(fromAddress),
  };
}

/** The name a notification to the publisher goes out as (SPEC §8): `Kestrel` until the
 *  publication has a name, then `<publication name> via Kestrel`. It reads the publication's
 *  name only, never a name written into `FROM_ADDRESS`, which is the reader's sender: a
 *  notification is Kestrel writing to the publisher, not the newsletter writing to a reader. */
export function notificationSenderName(publicationName: string): string {
  const name = publicationName.trim();
  return name ? `${name} via Kestrel` : "Kestrel";
}

/** The sender a notification goes out as: `notificationSenderName` over the address alone of
 *  the deploy-time `FROM_ADDRESS`, the only address the provider will send from. */
export function notificationSender(publicationName: string, fromAddress: string): Sender {
  return {
    name: notificationSenderName(publicationName),
    address: fromAddressOnly(fromAddress),
  };
}

/** Whether a character is a C0 or C1 control character, or DEL: none may be in a header,
 *  and a line break among them would end the header early. */
function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** `s` with every control character dropped. */
function withoutControls(s: string): string {
  return [...s].filter((c) => !isControl(c)).join("");
}

/** A display name a `From:` header can carry as it is (RFC 5322's phrase): atoms of the
 *  characters an unquoted word takes, separated by spaces. Anything else, a comma or a
 *  period among them, has to be quoted, or a receiver reads it as two addresses or
 *  refuses the header (SES does). */
const PLAIN_PHRASE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/;

const ASCII_ONLY = /^[\x20-\x7e]*$/;

/** The most bytes one RFC 2047 encoded-word carries: the word may be 75 characters at most,
 *  `=?utf-8?B?` and `?=` take 12 of them, and 45 bytes is the largest multiple of three
 *  (base64's unit) whose encoding fits the 63 that remain. */
const ENCODED_WORD_BYTES = 45;

/** Standard base64 of UTF-8 bytes. */
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin);
}

/**
 * A name with characters outside ASCII as RFC 2047 encoded-words, which a header has to
 * carry it as and SES requires: `=?utf-8?B?…?=`, each at most 75 characters, so a long
 * name is several words in a row, split only between characters so no character's bytes
 * are cut in two. Adjacent encoded-words read as one text.
 */
function encodedWords(name: string): string {
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const char of name) {
    const size = encoder.encode(char).length;
    if (chunkBytes + size > ENCODED_WORD_BYTES && chunk) {
      words.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += size;
  }
  if (chunk) {
    words.push(chunk);
  }
  return words.map((w) => `=?utf-8?B?${base64(encoder.encode(w))}?=`).join(" ");
}

/**
 * The `From:` header a sender goes out as, as a transport takes it: the address alone
 * when the name is empty; a plain name as it is; a name a comma, a quote, or any other
 * special would break as a quoted string, its quotes and backslashes escaped; and a name
 * with characters outside ASCII as RFC 2047 encoded-words, never quoted, since a quoted
 * string isn't decoded. Control characters are dropped and whitespace runs collapsed
 * first, so no name can end the header early or carry a second one.
 */
export function fromHeader(s: Sender): string {
  const name = withoutControls(s.name).replace(/\s+/g, " ").trim();
  const address = withoutControls(s.address).trim();
  if (!name) {
    return address;
  }
  if (!ASCII_ONLY.test(name)) {
    return `${encodedWords(name)} <${address}>`;
  }
  if (PLAIN_PHRASE.test(name)) {
    return `${name} <${address}>`;
  }
  return `"${name.replace(/["\\]/g, "\\$&")}" <${address}>`;
}
