/**
 * Sign SNS messages the way SNS does, with a local RSA key, so the SES webhook's real
 * verification runs end to end with no AWS: a signer is a keypair plus a certificate for
 * its public key, served at an SNS-shaped URL a spec mocks `fetch` to answer.
 */

import { canonicalString, type SnsEnvelope } from "../../src/providers/sns";

/** Standard base64 of raw bytes, as SNS writes a signature. */
export function base64Bytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function derLen(n: number): number[] {
  if (n < 0x80) {
    return [n];
  }
  const bytes: number[] = [];
  let x = n;
  while (x > 0) {
    bytes.unshift(x & 0xff);
    x >>>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derSeq(...items: Uint8Array[]): Uint8Array {
  const total = items.reduce((n, a) => n + a.length, 0);
  const content = new Uint8Array(total);
  let o = 0;
  for (const a of items) {
    content.set(a, o);
    o += a.length;
  }
  const header = new Uint8Array([0x30, ...derLen(content.length)]);
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

const wrap64 = (s: string): string => (s.match(/.{1,64}/g) ?? []).join("\n");

export interface Signer {
  privateKey: CryptoKey;
  certPem: string;
  certUrl: string;
}

/**
 * Generate an RSA keypair and wrap its public key (SPKI) in a minimal DER certificate,
 * enough structure for the adapter's SPKI extractor to find it, served as PEM. `hash` is
 * the one the message's SignatureVersion names ("1" is SHA-1, "2" SHA-256). A unique cert
 * URL per signer sidesteps the adapter's key cache.
 */
export async function makeSigner(hash: "SHA-1" | "SHA-256" = "SHA-256"): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash,
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
  );
  const certDer = derSeq(derSeq(spki)); // Certificate ::= SEQ { TBS ::= SEQ { SPKI } }
  const certPem = `-----BEGIN CERTIFICATE-----\n${wrap64(base64Bytes(certDer))}\n-----END CERTIFICATE-----\n`;
  const certUrl = `https://sns.us-east-1.amazonaws.com/SimpleNotificationService-${crypto.randomUUID()}.pem`;
  return { privateKey: pair.privateKey, certPem, certUrl };
}

/** The envelope with its `Signature` set over SNS's canonical string for its type. */
export async function signEnvelope(envelope: SnsEnvelope, signer: Signer): Promise<SnsEnvelope> {
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signer.privateKey,
    new TextEncoder().encode(canonicalString(envelope)),
  );
  return { ...envelope, Signature: base64Bytes(new Uint8Array(sig)) };
}
