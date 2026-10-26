import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // In-memory Mongo is shared across files; run them serially.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Set before any module loads (config/env.ts reads it once at import time),
    // so admin.test.ts can authenticate against a known token. OPENAI_API_KEY is
    // forced empty so the AI service uses its deterministic mock (no live calls).
    // Google is "configured" with dummy values; tests stub the Google client so
    // nothing ever reaches the network.
    env: {
      ADMIN_TOKEN: "test-admin-token",
      OPENAI_API_KEY: "",
      GOOGLE_OAUTH_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret",
      GOOGLE_OAUTH_REDIRECT_URI: "http://localhost:4100/admin/google/callback",
      GOOGLE_TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    },
  },
});
