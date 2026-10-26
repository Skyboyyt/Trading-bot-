import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/*/test/**/*.test.ts", "apps/{api,worker}/test/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["packages/*/test/**/*.int.test.ts", "apps/{api,worker}/test/**/*.int.test.ts", "tests/**/*.int.test.ts"],
          globalSetup: ["tests/setup/global-db.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
