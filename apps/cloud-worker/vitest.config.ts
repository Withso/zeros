import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@zeros/protocol": fileURLToPath(new URL("../../packages/protocol/src", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    maxWorkers: 1,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    restoreMocks: true,
  },
});
