import crypto from "node:crypto";

const PREFIX = "esk_"; // "email service key" — makes keys greppable in logs/config.

/**
 * Generates a new API key. Returns the plaintext (shown to the caller once) plus
 * the values we persist: a sha256 hash and the last 4 chars for identification.
 *
 * API keys are high-entropy random tokens, so a fast hash (sha256) is the correct
 * choice — bcrypt/argon2 exist to slow down guessing of low-entropy passwords and
 * would only add latency to every authenticated request here.
 */
export function generateApiKey(): { plaintext: string; hash: string; last4: string } {
  const plaintext = PREFIX + crypto.randomBytes(24).toString("base64url");
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    last4: plaintext.slice(-4),
  };
}

export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}
