import { afterEach, describe, expect, it } from "vitest";
import { env } from "../config/env.js";
import { decrypt, encrypt } from "./crypto.js";

const originalKey = env.google.tokenEncryptionKey;
afterEach(() => {
  env.google.tokenEncryptionKey = originalKey;
});

function flipHexChar(hex: string): string {
  const last = hex.slice(-1);
  return hex.slice(0, -1) + (last === "0" ? "1" : "0");
}

describe("token encryption", () => {
  it("round-trips and never emits the plaintext", () => {
    const secret = "1//refresh-token-with-unicode-é";
    const payload = encrypt(secret);
    expect(payload).not.toContain(secret);
    expect(payload.split(":")).toHaveLength(3);
    expect(decrypt(payload)).toBe(secret);
  });

  it("uses a fresh IV per encryption", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("detects a tampered ciphertext or auth tag", () => {
    const [iv, tag, data] = encrypt("secret-value").split(":");
    expect(() => decrypt(`${iv}:${tag}:${flipHexChar(data)}`)).toThrow();
    expect(() => decrypt(`${iv}:${flipHexChar(tag)}:${data}`)).toThrow();
    expect(() => decrypt("not-a-payload")).toThrow("Invalid encrypted payload");
  });

  it("fails to decrypt under a different key", () => {
    const payload = encrypt("secret-value");
    env.google.tokenEncryptionKey = "a-different-key";
    expect(() => decrypt(payload)).toThrow();
  });

  it("accepts a 64-hex raw key", () => {
    env.google.tokenEncryptionKey = "ab".repeat(32);
    expect(decrypt(encrypt("raw-key"))).toBe("raw-key");
  });

  it("throws a clear error when the key is unset", () => {
    env.google.tokenEncryptionKey = "";
    expect(() => encrypt("x")).toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY is not set/);
  });
});
