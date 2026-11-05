import { defineConfig } from "vitest/config";

/** Real-extension tests (Playwright + Chromium + dist/). Run with `npm run test:e2e`. */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
