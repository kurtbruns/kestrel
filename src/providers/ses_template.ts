/**
 * The frozen email as an SES inline template, the content SendBulkEmail sends (SPEC §10, I5).
 *
 * SES fills an inline template's `{{tag}}` from each entry's data by simple substitution, so
 * one request carries the email once and each recipient's values beside it. The render stays
 * the one path: each delivery sentinel the frozen render holds becomes a tag, and that tag's
 * value is what the render's own delivery pass (`fillDeliveryTokens`) would put there for
 * that recipient and surface. What SES produces is then byte for byte what
 * `substituteRecipient` produces for the fake.
 *
 * Escaping: every literal `{`, `}`, and `\` in the subject and both parts becomes a tag too,
 * filled with the character itself. The template SES reads then holds no brace or backslash
 * but its own `{{tag}}`s, so a `{{` a post or template carries, a backslash before a tag, or
 * a stray `}}` means nothing to SES, whatever its engine makes of such text. Every entry's
 * data carries every tag, since SES drops a message whose template names a tag its data
 * lacks (a rendering failure, reported only later).
 */
import {
  type DeliveryContext,
  deliverySentinels,
  fillDeliveryTokens,
} from "../render/template_engine";
import type { RenderedEmail } from "./types";

type Surface = "html" | "text";

/** A character SES's template can't carry as itself, and the tag that stands for it. */
const LITERAL_TAGS: Record<string, string> = { "{": "lb", "}": "rb", "\\": "bs" };
const LITERAL = /[{}\\]/g;

/** The tag a delivery token takes on one surface: `.Email.SentTo` on html is
 *  `email_sentto_html`. The surface suffix keeps it apart from the literal tags. */
function deliveryTag(key: string, surface: Surface): string {
  return `${key.replace(/^\./, "").replace(/\./g, "_").toLowerCase()}_${surface}`;
}

/** One surface of the frozen render as template text. The subject has no delivery pass
 *  (`substituteRecipient` leaves it as frozen), so it gets the literal tags only. */
function encode(frozen: string, surface: Surface | null): string {
  let out = frozen.replace(LITERAL, (c) => `{{${LITERAL_TAGS[c]}}}`);
  if (surface) {
    for (const t of deliverySentinels()) {
      out = out.split(t.sentinel).join(`{{${deliveryTag(t.key, surface)}}}`);
    }
  }
  return out;
}

/** SESv2 `EmailTemplateContent`. */
export interface SesTemplateContent {
  Subject: string;
  Html: string;
  Text: string;
}

/** The frozen render as one inline template every entry of a request shares. */
export function sesTemplateContent(frozen: RenderedEmail): SesTemplateContent {
  return {
    Subject: encode(frozen.subject, null),
    Html: encode(frozen.html, "html"),
    Text: encode(frozen.text, "text"),
  };
}

/** One recipient's template data: every tag `sesTemplateContent` can emit, the delivery
 *  tokens filled by the render's own delivery pass. */
export function sesTemplateData(ctx: DeliveryContext): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [char, tag] of Object.entries(LITERAL_TAGS)) {
    data[tag] = char;
  }
  for (const t of deliverySentinels()) {
    for (const surface of ["html", "text"] as const) {
      data[deliveryTag(t.key, surface)] = fillDeliveryTokens(t.sentinel, ctx, surface);
    }
  }
  return data;
}

const ASCII_ONLY = /^[\x20-\x7e]*$/;

/** Standard base64 of a UTF-8 string. */
function base64Utf8(s: string): string {
  let bin = "";
  for (const byte of new TextEncoder().encode(s)) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin);
}

/**
 * The from-line as SES's `FromEmailAddress` takes it: a display name with non-ASCII in it
 * goes as an RFC 2047 encoded-word, which SES requires; anything else as written.
 */
export function sesFromAddress(from: string): string {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!m || ASCII_ONLY.test(from)) {
    return from;
  }
  const name = (m[1] ?? "").replace(/^"(.*)"$/, "$1");
  return `=?utf-8?B?${base64Utf8(name)}?= <${m[2]}>`;
}

/** Whether SES can take the address as a destination: it has no SMTPUTF8, so the local
 *  part must be ASCII, and a domain must already be in its ASCII (Punycode) form. */
export function sesCanAddress(email: string): boolean {
  return ASCII_ONLY.test(email);
}

/** A dot-atom local part (RFC 5322): atoms of the characters an unquoted local part takes,
 *  joined by single dots. */
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;
/** A host name: dotted labels of letters, digits, and inner hyphens, at least two of them. */
const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

/**
 * Why SES would refuse an address as a destination, or null when it wouldn't: one outside
 * ASCII, or one that isn't a plain `local@domain` (whitespace, a doubled or stray dot, a
 * character a host name can't hold). The list's own check is deliberately loose (SPEC §7),
 * and SES refuses a malformed address for its whole request, so the adapter keeps such an
 * address out of the request and fails it alone, rather than let it take a batch with it.
 * A quoted local part is refused too: SES's support for one is not documented, and no
 * signup form produces one.
 */
export function sesAddressProblem(email: string): string | null {
  if (!sesCanAddress(email)) {
    return "ses can't send to an address with characters outside ASCII";
  }
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (at <= 0 || !LOCAL_PART.test(local) || !DOMAIN.test(domain)) {
    return "ses can't send to this address: it isn't a well-formed address";
  }
  return null;
}
