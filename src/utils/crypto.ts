import crypto from "node:crypto";
import { env } from "../config/env.js";

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const raw = env.google.tokenEncryptionKey;
  if (!raw) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is not set; cannot encrypt/decrypt tokens");
  // A 64-char hex string is used directly as 32 raw bytes. Any other secret
  // (e.g. a Render-generated value) is hashed to a stable 32-byte key.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypts a string for storage at rest. Output format: iv:authTag:ciphertext (hex).
 */
export function encrypt(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

/** Decrypts an `encrypt` payload. Throws if it was tampered with or the key changed. */
export function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error("Invalid encrypted payload");
  }
  const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return dec.toString("utf8");
}
