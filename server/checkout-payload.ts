/**
 * Signed checkout payloads for /pay/:payload links.
 *
 * The checkout payload is decoded by the payer's browser and drives what the
 * checkout shows and pays: receiver address, amount, currency, itemised
 * orders. Left as plain base64url JSON, anyone can re-encode it — a link that
 * shows the real merchant's name against an attacker's address is a one-liner.
 *
 * The payload is therefore signed with HMAC-SHA256 under a key derived from
 * SESSION_SECRET. The signature is verified server-side (the key never leaves
 * the server): /api/payment/create and /api/payment/swap/quote verify the
 * payload a checkout sends back, and treat its contents as authoritative for
 * where the money goes. Links minted before this existed are refused by the
 * checkout; every minting path in the app now obtains a signature from the
 * server.
 */

import crypto from "crypto";

/** A checkout segment that is missing, malformed, or does not authenticate. */
export class CheckoutPayloadError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = "CheckoutPayloadError";
  }
}

const SIGNING_KEY_CONTEXT = "serapay-checkout-payload:v1";
const DEV_FALLBACK_KEY_MATERIAL = "serapay-development-checkout-signing-key";

/**
 * HMAC-SHA256 digests are 32 bytes, which is 43 base64url characters. The
 * length check below is what a tampered payload fails first, before any
 * comparison.
 */
const SIGNATURE_LENGTH = 43;

function getSigningKey(): Buffer | null {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret && Buffer.byteLength(secret, "utf8") >= 32) {
    return crypto.createHash("sha256").update(`${SIGNING_KEY_CONTEXT}:${secret}`).digest();
  }
  // validateRuntimeEnv refuses to boot production without a strong
  // SESSION_SECRET, so a missing key can only be development or tests.
  if (process.env.NODE_ENV === "production") return null;
  return crypto.createHash("sha256").update(`${SIGNING_KEY_CONTEXT}:${DEV_FALLBACK_KEY_MATERIAL}`).digest();
}

export function isCheckoutSigningReady(): boolean {
  return getSigningKey() !== null;
}

export function signCheckoutBody(body: string): string {
  const key = getSigningKey();
  if (!key) {
    throw new Error("SESSION_SECRET must be at least 32 bytes to sign checkout links");
  }
  return crypto.createHmac("sha256", key).update(body, "utf8").digest().toString("base64url");
}

/** Signs `payload` and returns the `<body>.<signature>` link segment. */
export function signCheckoutPayload(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${signCheckoutBody(body)}`;
}

/**
 * Verifies a `<body>.<signature>` segment and returns the decoded payload,
 * or null when the segment is unsigned, malformed, or does not authenticate.
 * Comparison is timing-safe; the signature never depends on attacker-controlled
 * buffer allocation.
 */
export function verifyCheckoutPayload(encoded: string): Record<string, unknown> | null {
  const separator = encoded.lastIndexOf(".");
  if (separator <= 0) return null;
  const body = encoded.slice(0, separator);
  const signature = encoded.slice(separator + 1);
  if (!body || signature.length !== SIGNATURE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;

  const key = getSigningKey();
  if (!key) return null;
  const expected = crypto.createHmac("sha256", key).update(body, "utf8").digest();
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
