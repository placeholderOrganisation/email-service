import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // In-memory Mongo is shared across files; run them serially.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Set before any module loads (config/env.ts reads it once at import time),
    // so admin.test.ts can authenticate against a known token.
    env: { ADMIN_TOKEN: "test-admin-token" },
  },
});
