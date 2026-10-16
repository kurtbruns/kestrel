/**
 * Credential redaction for a provider's own words. AWS answers a badly signed request
 * (`IncompleteSignatureException`, `SignatureDoesNotMatch`) by echoing what it was sent:
 * the Authorization header's `Credential=` scope and `Signature=`, and in a canonical
 * request the access key ID and any session token. None of that may reach a halt, a
 * notification, a test-send answer, or a log line (SPEC §9, §12), so the adapter redacts
 * where it builds SES's words and the logger redacts again on the way out.
 */

// `Credential=AKIA…/20261016/us-east-1/ses/aws4_request`, as the header or a query string carries it.
const CREDENTIAL = /(Credential=)[^,\s&"']+/gi;
// `Signature=<hex>`, the request's signature.
const SIGNATURE = /(Signature=)[0-9a-f]+/gi;
// A session token, as a signed header (`x-amz-security-token:…`) or a query parameter.
const SECURITY_TOKEN = /(x-amz-security-token[:=]\s*)[^\s&,"']+/gi;
// An access key ID on its own (long-term `AKIA`, temporary `ASIA`).
const ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;

/** `text` with every AWS credential, signature, and access key ID in it replaced by `…`. */
export function redactCredentials(text: string): string {
  return text
    .replace(CREDENTIAL, "$1…")
    .replace(SIGNATURE, "$1…")
    .replace(SECURITY_TOKEN, "$1…")
    .replace(ACCESS_KEY_ID, "…");
}
