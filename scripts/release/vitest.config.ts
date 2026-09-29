import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["scripts/release/**/*.test.ts"], environment: "node", maxWorkers: 2 } });
