import { defineConfig } from "vitest/config";

/** Isolated A1/A2 unit runner. It makes no repository-wide coverage claim. */
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/qa/harness/__tests__/*.test.ts"],
    pool: "threads",
    coverage: { enabled: false },
  },
});
