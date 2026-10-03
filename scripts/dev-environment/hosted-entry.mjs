#!/usr/bin/env node
import path from "node:path";
import { ensureDevelopmentDependencies } from "./dependencies.mjs";

// Do not preload tsx or statically import the hosted launcher: tsx/esbuild and
// the R2 SDK may all be absent in a freshly synced Mac checkout.
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Dependency installation interrupted; Run will retry it"));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, cancel);
try {
  await ensureDevelopmentDependencies(path.resolve(import.meta.dirname, "../.."), { signal: controller.signal });
  controller.signal.throwIfAborted();
  await import("tsx");
  controller.signal.throwIfAborted();
  await import("./hosted-launcher.mjs");
} catch (error) {
  console.error(`[zeros-dev] ${error instanceof Error ? error.message : "Dev startup failed"}`);
  process.exitCode = 1;
} finally { for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, cancel); }
