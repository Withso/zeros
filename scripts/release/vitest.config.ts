import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["scripts/release/**/*.test.ts"], environment: "node", maxWorkers: 2,
  // The real drain and canary controls reset the same public schema.
  fileParallelism: !process.env.TEST_DATABASE_URL,
} });
