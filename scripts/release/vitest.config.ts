import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["scripts/release/**/*.test.ts"], environment: "node", maxWorkers: 2,
  // The real drain and canary controls reset the same public schema.
  fileParallelism: !process.env.TEST_DATABASE_URL,
  // These polls wait for real HTTP and WebSocket round trips (runtime-adoption's prompt reached a driver after the
  // default 1 s on a loaded runner and failed Release alpha 44037444038's Preflight). A genuine hang still fails.
  expect: { poll: { timeout: 10_000 } },
} });
