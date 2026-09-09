/**
 * Amazon SNS message verification and SES-event normalization for the webhook.
 *
 * SNS posts a signed JSON envelope. We MUST verify the signature before acting
 * on anything (confirming a subscription, or applying delivery events), because
 * the webhook route is public. Verification:
 *   - fetch the signing certificate from `SigningCertURL`, whose host is pinned
 *     to `sns.*.amazonaws.com` (an attacker cannot host a cert there);
 *   - rebuild the canonical string per the SNS rules (field order depends on
 *     message type; `Subject` is included only when present);
 *   - RSA-verify `Signature` over it. SignatureVersion "1" is SHA-1, "2" is
 *     SHA-256 (`crypto.subtle`, RSASSA-PKCS1-v1_5).
 *
 * Everything here is provider-agnostic SNS/SES wire handling; the SesProvider
 * wires it into the seam.
 */
import type { DeliveryEvent } from "./types";

export interface SnsEnvelope {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  /** Notification only. */
  Subject?: string;
  /** SubscriptionConfirmation / UnsubscribeConfirmation only. */
  SubscribeURL?: string;
  Token?: string;
}

/** Pin a URL to the SNS host family: `https://sns.<region>.amazonaws.com/...`. */
export function isSnsHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h.startsWith("sns.") && h.endsWith(".amazonaws.com");
}

// The fields that make up the string-to-sign, in the exact order SNS uses.
const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const SUBSCRIPTION_KEYS = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
] as const;

/** Build the canonical string-to-sign. `Subject` is skipped when absent. */
export function canonicalString(msg: SnsEnvelope): string {
  const keys = msg.Type === "Notification" ? NOTIFICATION_KEYS : SUBSCRIPTION_KEYS;
  const fields = msg as unknown as Record<string, unknown>;
  let out = "";
  for (const k of keys) {
    const v = fields[k];
    if (v === undefined || v === null) continue;
    out += `${k}\n${String(v)}\n`;
  }
  return out;
}

// --- signing certificate → public key ---------------------------------------

// One imported key per (hash, certURL). Certs rotate rarely; caching avoids a
// fetch + parse per message.
const keyCache = new Map<string, CryptoKey>();

/** Clear the signing-cert cache (tests only). */
export function _clearKeyCache(): void {
  keyCache.clear();
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pemBlock(pem: string, label: string): Uint8Array | null {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`);
  const m = pem.match(re);
  return m && m[1] ? base64ToBytes(m[1]) : null;
}

// Minimal ASN.1 DER reader — just enough to pull the SubjectPublicKeyInfo out of
// an X.509 certificate. WebCrypto imports an SPKI, not a certificate.
interface Tlv {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
}

function readTlv(buf: Uint8Array, offset: number): Tlv {
  const tag = buf[offset]!;
  let i = offset + 1;
  let len = buf[i++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let k = 0; k < n; k++) len = (len << 8) | buf[i++]!;
  }
  return { tag, start: offset, contentStart: i, end: i + len };
}

function children(buf: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let off = t.contentStart;
  while (off < t.end) {
    const c = readTlv(buf, off);
    out.push(c);
    off = c.end;
  }
  return out;
}

// OID 1.2.840.113549.1.1.1 (rsaEncryption), the marker of the SPKI's algorithm.
const RSA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

/** Extract the DER SubjectPublicKeyInfo from an X.509 certificate DER. */
function extractSpkiFromCert(der: Uint8Array): Uint8Array {
  const cert = readTlv(der, 0); // Certificate ::= SEQUENCE { tbs, sigAlg, sig }
  const tbs = children(der, cert)[0]; // TBSCertificate ::= SEQUENCE { ... }
  if (!tbs) throw new Error("malformed certificate");
  // The SPKI is the child SEQUENCE whose first element is an AlgorithmIdentifier
  // holding the rsaEncryption OID. issuer/subject (SET-first) and validity
  // (time-first) never match, so this is unambiguous.
  for (const child of children(der, tbs)) {
    if (child.tag !== 0x30) continue;
    const alg = children(der, child)[0];
    if (!alg || alg.tag !== 0x30) continue;
    const oid = children(der, alg)[0];
    if (!oid || oid.tag !== 0x06) continue;
    const bytes = der.subarray(oid.contentStart, oid.end);
    if (bytes.length === RSA_OID.length && RSA_OID.every((b, i) => b === bytes[i])) {
      return der.slice(child.start, child.end);
    }
  }
  throw new Error("SubjectPublicKeyInfo not found");
}

/** Accept a PEM PUBLIC KEY (SPKI) directly, or an X.509 CERTIFICATE to unwrap. */
function spkiFromPem(pem: string): Uint8Array {
  const pub = pemBlock(pem, "PUBLIC KEY");
  if (pub) return pub;
  const cert = pemBlock(pem, "CERTIFICATE");
  if (cert) return extractSpkiFromCert(cert);
  throw new Error("PEM has neither a PUBLIC KEY nor a CERTIFICATE");
}

async function fetchVerifyKey(certUrl: string, hash: "SHA-1" | "SHA-256"): Promise<CryptoKey> {
  const cacheKey = `${hash}:${certUrl}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;

  let u: URL;
  try {
    u = new URL(certUrl);
  } catch {
    throw new Error("invalid SigningCertURL");
  }
  if (u.protocol !== "https:" || !isSnsHost(u.hostname)) {
    throw new Error(`untrusted SigningCertURL host: ${u.hostname}`);
  }

  const res = await fetch(certUrl);
  if (!res.ok) throw new Error(`signing cert fetch failed: ${res.status}`);
  const pem = await res.text();
  const key = await crypto.subtle.importKey(
    "spki",
    spkiFromPem(pem),
    { name: "RSASSA-PKCS1-v1_5", hash },
    false,
    ["verify"],
  );
  keyCache.set(cacheKey, key);
  return key;
}

/**
 * Verify an SNS message signature. Returns false (never throws) on any problem —
 * bad version, untrusted cert host, fetch/parse failure, or signature mismatch —
 * so the caller can reject uniformly.
 */
export async function verifySnsSignature(msg: SnsEnvelope): Promise<boolean> {
  if (!msg.Signature || !msg.SigningCertURL) return false;
  const hash = msg.SignatureVersion === "2" ? "SHA-256" : msg.SignatureVersion === "1" ? "SHA-1" : null;
  if (!hash) return false;

  let key: CryptoKey;
  try {
    key = await fetchVerifyKey(msg.SigningCertURL, hash);
  } catch {
    return false;
  }

  try {
    const data = new TextEncoder().encode(canonicalString(msg));
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64ToBytes(msg.Signature), data);
  } catch {
    return false;
  }
}

// --- SES event → normalized DeliveryEvent[] ---------------------------------

interface SesRecipient {
  emailAddress?: string;
  diagnosticCode?: string;
}

interface SesMessage {
  notificationType?: string;
  eventType?: string;
  mail?: { messageId?: string; destination?: string[] };
  bounce?: {
    bounceType?: string;
    bounceSubType?: string;
    bouncedRecipients?: SesRecipient[];
  };
  complaint?: {
    complaintFeedbackType?: string;
    complainedRecipients?: SesRecipient[];
  };
  delivery?: { recipients?: string[] };
}

/**
 * Normalize the SES payload carried in an SNS `Notification`'s inner `Message`.
 * Handles both the legacy notification shape (`notificationType`) and the
 * configuration-set event shape (`eventType`). A `Bounce` is hard only when
 * `bounceType` is `Permanent`.
 */
export function mapSesNotification(messageJson: string): DeliveryEvent[] {
  let payload: SesMessage;
  try {
    payload = JSON.parse(messageJson) as SesMessage;
  } catch {
    return [];
  }
  const kind = payload.notificationType ?? payload.eventType;
  const providerId = payload.mail?.messageId;
  const events: DeliveryEvent[] = [];

  if (kind === "Bounce" && payload.bounce) {
    const hard = payload.bounce.bounceType === "Permanent";
    const fallback = `${payload.bounce.bounceType ?? "Bounce"}/${payload.bounce.bounceSubType ?? ""}`;
    for (const r of payload.bounce.bouncedRecipients ?? []) {
      if (!r.emailAddress) continue;
      events.push({
        type: "bounced",
        providerId,
        email: r.emailAddress,
        hard,
        detail: r.diagnosticCode ?? fallback,
      });
    }
  } else if (kind === "Complaint" && payload.complaint) {
    const detail = payload.complaint.complaintFeedbackType ?? "complaint";
    for (const r of payload.complaint.complainedRecipients ?? []) {
      if (!r.emailAddress) continue;
      events.push({ type: "complained", providerId, email: r.emailAddress, detail });
    }
  } else if (kind === "Delivery" && payload.delivery) {
    const recipients = payload.delivery.recipients ?? payload.mail?.destination ?? [];
    for (const email of recipients) {
      events.push({ type: "delivered", providerId, email });
    }
  }

  return events;
}
