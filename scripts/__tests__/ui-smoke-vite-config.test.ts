import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { resolveConfig } from "vite";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

describe("UI smoke Vite configuration", () => {
  it("disables reloads that destroy in-flight browser evaluations", async () => {
    const config = await resolveConfig({ root: ROOT }, "serve", "ui-smoke");

    expect(config.server.hmr).toBe(false);
    expect(config.optimizeDeps.entries).toEqual([
      "index.html",
      "apps/desktop/src/renderer/harnesses/harness-*.html",
    ]);
  });

  it("preserves live reload and the bounded scan for normal development", async () => {
    const config = await resolveConfig({ root: ROOT }, "serve", "development");

    expect(config.server.hmr).not.toBe(false);
    expect(config.optimizeDeps.entries).toEqual(["index.html"]);
  });

  it.each(["ui-smoke-composer.mjs", "smoke-file-media-electron.mjs"])("runs %s in the isolated browser mode", (script) => {
    const source = readFileSync(
      path.join(ROOT, "scripts", script),
      "utf8",
    );

    const smokeMode = source.match(
      /"--mode",\s*"([^"]+)"/,
    )?.[1];

    expect(smokeMode).toBe("ui-smoke");
    // The runner probes and navigates 127.0.0.1. On IPv6-first hosts,
    // localhost can bind only ::1 and leave that probe unreachable.
    expect(source.match(/"--host",\s*"([^"]+)"/)?.[1]).toBe("127.0.0.1");
  });
});
