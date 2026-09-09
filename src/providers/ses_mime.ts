/**
 * Raw MIME builder for the SES adapter.
 *
 * SES v1 of this adapter sends one message per recipient (Content.Raw), because
 * each recipient carries a DISTINCT unsubscribe URL and a per-recipient RFC 8058
 * one-click header pair. We therefore build the MIME ourselves rather than let
 * SES template it: a `multipart/alternative` with a text and an html part (both
 * base64, which is safe for arbitrary UTF-8), a `List-Unsubscribe` /
 * `List-Unsubscribe-Post` pair, and CRLF line endings per RFC 5322.
 *
 * The sentinel is already substituted by the caller, so the bytes here are
 * exactly what the recipient receives.
 */

const CRLF = "\r\n";

function toBinary(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return bin;
}

/** Standard base64 of a UTF-8 string. */
export function base64Utf8(s: string): string {
  return btoa(toBinary(new TextEncoder().encode(s)));
}

/** Standard base64 of raw bytes. */
export function base64Bytes(bytes: Uint8Array): string {
  return btoa(toBinary(bytes));
}

/** Wrap a base64 blob into 76-char lines (RFC 2045). */
function wrap76(s: string): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 76) lines.push(s.slice(i, i + 76));
  return lines.join(CRLF);
}

const ASCII_ONLY = /^[\x20-\x7e]*$/;

/** RFC 2047 encoded-word for a header value that contains non-ASCII (e.g. a subject). */
function encodeHeaderValue(value: string): string {
  if (ASCII_ONLY.test(value)) return value;
  return `=?utf-8?B?${base64Utf8(value)}?=`;
}

export interface RawMessageInput {
  /** `From:` header value (may include a display name). */
  from: string;
  /** Single recipient address. */
  to: string;
  subject: string;
  html: string;
  text: string;
  /** This recipient's unsubscribe URL — goes in the one-click header. */
  unsubscribeUrl: string;
}

/**
 * Build the raw MIME message for one recipient. The caller base64-encodes the
 * returned string into SES's `Content.Raw.Data`.
 */
export function buildRawMessage(m: RawMessageInput): string {
  const boundary = `=_kestrel_${crypto.randomUUID().replace(/-/g, "")}`;

  const headers = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeaderValue(m.subject)}`,
    "MIME-Version: 1.0",
    `List-Unsubscribe: <${m.unsubscribeUrl}>`,
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join(CRLF);

  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(m.text)),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(base64Utf8(m.html)),
    `--${boundary}--`,
    "",
  ].join(CRLF);

  return `${headers}${CRLF}${CRLF}${body}`;
}
