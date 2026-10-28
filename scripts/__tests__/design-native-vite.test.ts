import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { resolveConfig } from "vite";
import { nativeViteConfiguration, nativeProductionViteConfiguration } from "../design-native-vite.mjs";

it("builds optimized production assets with a separate shared-store probe and isolated output", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-native-production-"));
  try {
    vi.stubEnv("NODE_ENV", "production");
    const probe = path.join(output, "qualification.ts");
    const configFile = path.join(output, "vite.config.mjs");
    await fs.writeFile(probe, "export const modules = {};");
    await fs.writeFile(configFile, nativeProductionViteConfiguration(root, path.join(output, "cache"), path.join(output, "dist"), probe));
    const config = await resolveConfig({ root, configFile, mode: "production", logLevel: "silent" }, "build");
    expect(config.isProduction).toBe(true);
    expect(config.build.minify).not.toBe(false);
    expect(config.build.outDir).toBe(path.join(output, "dist"));
    expect(config.build.manifest).toBe(true);
    expect(config.build.rollupOptions.input).toMatchObject({ main: path.join(root, "index.html"), qualification: probe });
    expect(config.cacheDir).toBe(path.join(output, "cache"));
  } finally { vi.unstubAllEnvs(); await fs.rm(output, { recursive: true, force: true }); }
});

it("loads the production Vite config with its original directory and an isolated cache", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-native-vite-"));
  try {
    const configFile = path.join(output, "vite.config.mjs");
    const cacheDir = path.join(output, "cache");
    await fs.writeFile(configFile, nativeViteConfiguration(root, cacheDir));
    const config = await resolveConfig({ root, configFile, logLevel: "silent" }, "serve");
    expect(config.cacheDir).toBe(cacheDir);
    expect(config.resolve.alias.find(alias => alias.find === "@")?.replacement)
      .toBe(path.join(root, "apps/desktop/src"));
  } finally { await fs.rm(output, { recursive: true, force: true }); }
});
