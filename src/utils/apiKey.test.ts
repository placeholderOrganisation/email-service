import { describe, expect, it } from "vitest";
import { generateApiKey, hashApiKey } from "./apiKey.js";

describe("apiKey", () => {
  it("generates a prefixed key whose hash matches re-hashing the plaintext", () => {
    const key = generateApiKey();
    expect(key.plaintext.startsWith("esk_")).toBe(true);
    expect(key.hash).toBe(hashApiKey(key.plaintext));
    expect(key.last4).toBe(key.plaintext.slice(-4));
  });

  it("produces distinct keys and hashes each call", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});
