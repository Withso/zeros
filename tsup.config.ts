import { defineConfig } from "tsup";
import * as fs from "fs";

const pkg = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
const VERSION = pkg.version;

// Mac-only pivot: browser library and Vite plugin builds removed.
// This builds ONLY the engine, as the DEV sidecar bundle dist-engine/cli.js
// (run via `node dist-engine/cli.js` during `pnpm electron:dev`). The PACKAGED
// app does NOT ship this output — it bundles a separate bun-compiled single-file
// binary (scripts/build-sidecar.mjs → binaries/, wired in via electron-builder
// extraResources). See electron-builder.yml.
export default defineConfig([
  {
    entry: ["src/cli.ts"],
    format: ["cjs"],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: true,
    outDir: "dist-engine",
    platform: "node",
    target: "node18",
    external: [
      /^node:/,
      "postcss",
      "chokidar",
      "ws",
      "tinyglobby",
      "@octokit/rest",
      // Native modules — bundling fails because tsup can't statically
      // resolve the .node binary. Stays external so the engine cli
      // imports the prebuilt native bindings at runtime.
      "better-sqlite3",
      // 01w (2026-05-20) — node-pty has a native binding (pty.node)
      // that can't be bundled. Loaded at runtime via Node's normal
      // resolver from node_modules/node-pty.
      "node-pty",
    ],
    // @decimalturn/toml-patch is ESM-only; bundle it (pure JS, dependency-free)
    // so the CJS engine bundle never `require()`s an ESM module — matches the
    // electron config. (Under bun the require would work, but node/electron paths
    // must not hit ERR_REQUIRE_ESM.)
    //
    // @zeros/core's exports map points at RAW .ts sources — an external
    // `require("@zeros/core/…")` only works on runtimes with TS type
    // stripping (bun; Node ≥22.18). Force-bundle it so `node dist-engine/cli.js`
    // runs on ANY Node — matches the electron config, where the raw-TS
    // require crashed app boot.
    noExternal: ["@decimalturn/toml-patch", /^@zeros\/core/],
    define: {
      __VERSION__: JSON.stringify(VERSION),
    },
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);
