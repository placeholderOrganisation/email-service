import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // In-memory Mongo is shared across files; run them serially.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
