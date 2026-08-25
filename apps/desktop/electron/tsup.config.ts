// ──────────────────────────────────────────────────────────
// tsup config for the Electron main & preload processes.
// ──────────────────────────────────────────────────────────
//
// Output lands at `<repo>/dist-electron/`:
//   - main.cjs     (app entry, package.json "main" points here)
//   - preload.cjs  (injected via BrowserWindow webPreferences.preload)
//
// Both are CommonJS because Electron's main process loader expects
// CJS by default. We switch to .cjs extension so Node doesn't try to
// interpret them as ESM due to package.json's implicit type.
// ──────────────────────────────────────────────────────────

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    main: "apps/desktop/electron/main.ts",
    preload: "apps/desktop/electron/preload.ts",
    // (preload-webview.ts deleted with the iframe migration —
    // workbench browser tabs are <iframe> elements, no separate
    // preload context to inject into.)
  },
  format: ["cjs"],
  outDir: "dist-electron",
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  outExtension: () => ({ js: ".cjs" }),
  // Bake the release channel at compile time so the Electron MAIN knows it
  // before any data-dir / updater code runs (the renderer uses VITE_ZEROS_CHANNEL
  // instead). "" in a normal dev compile → main falls back to the dev/packaged
  // signal; the beta release workflow sets ZEROS_CHANNEL=beta for this step.
  // main.ts reads this via `declare const __ZEROS_CHANNEL_BAKED__` and seeds
  // process.env.ZEROS_CHANNEL so the spawned engine inherits the same value.
  define: {
    __ZEROS_CHANNEL_BAKED__: JSON.stringify(process.env.ZEROS_CHANNEL || ""),
    // Main-process GitHub App OAuth cannot read Vite's renderer-only
    // import.meta.env at runtime. Bake the same public control-plane origin into
    // main.cjs; an explicit ZEROS_CONTROL_PLANE_URL still overrides it in dev.
    __ZEROS_CONTROL_PLANE_URL_BAKED__: JSON.stringify(
      process.env.VITE_CONTROL_PLANE_URL || "",
    ),
    // Auth redemption/refresh happens in Electron main, not the renderer. Bake
    // the same channel-specific web origin there or Alpha/Beta silently fall
    // back to Production after the browser handoff.
    __ZEROS_APP_BASE_URL_BAKED__: JSON.stringify(
      process.env.VITE_APP_BASE_URL || "",
    ),
    // Desktop WorkOS is a public PKCE client. Bake only public verification
    // values; no WorkOS API key has a define or runtime input in Electron.
    __ZEROS_AUTH_PROVIDER_BAKED__: JSON.stringify(
      process.env.AUTH_PROVIDER || "",
    ),
    __ZEROS_AUTH_DESKTOP_CLIENT_ID_BAKED__: JSON.stringify(
      process.env.AUTH_DESKTOP_CLIENT_ID || "",
    ),
    __ZEROS_AUTH_ISSUER_BAKED__: JSON.stringify(process.env.AUTH_ISSUER || ""),
    __ZEROS_AUTH_JWKS_URL_BAKED__: JSON.stringify(
      process.env.AUTH_JWKS_URL || "",
    ),
    __ZEROS_AUTH_AUDIENCE_BAKED__: JSON.stringify(
      process.env.AUTH_AUDIENCE || "",
    ),
  },
  external: [
    "electron",
    // ESM-only package — Electron main is CJS, so this must stay external
    // and be loaded via a runtime dynamic `import()` (see loadOctokit in
    // apps/desktop/src/engine/git/github.ts). If tsup tries to inline it, the bundle
    // hits ERR_REQUIRE_ESM at app boot.
    "@octokit/rest",
    // Native modules — never bundle, electron-rebuild handles the
    // platform-specific binary.
    "better-sqlite3",
    // node-pty: the Electron main no longer imports it, but sidecar.ts does a
    // runtime `require.resolve("node-pty")` to hand the engine the path for the
    // Node PTY host. Keep it external so esbuild leaves that resolve as a
    // runtime call against the app's node_modules instead of trying to inline
    // the native module.
    "node-pty",
  ],
  // @decimalturn/toml-patch is ESM-only ("type":"module"). tsup externalizes
  // package.json deps by default, which would leave a runtime `require()` of an
  // ESM module in the CJS main.cjs → ERR_REQUIRE_ESM at app boot. It's pure JS
  // and dependency-free, so force-bundle it (esbuild transpiles ESM→CJS inline)
  // rather than do the dynamic-import() dance the octokit packages use.
  //
  // @zeros workspace libraries export RAW .ts sources. Left external, a
  // runtime require in the CJS bundle makes Electron's embedded Node parse TypeScript →
  // `SyntaxError: Unexpected token 'export'` at app boot (a system Node ≥22.18
  // masks this via type stripping — Electron's does not). Force-bundle them.
  noExternal: [
    "@decimalturn/toml-patch",
    // jose is ESM-only while Electron main is bundled as CommonJS. It is pure
    // JavaScript, so bundling keeps JWT verification boot-safe.
    "jose",
    /^@zeros\/(?:design-core|design-web|protocol)/,
  ],
  // Banner runs BEFORE any import resolution — lets us log and
  // catch uncaught exceptions even when one of the imported native
  // modules (node-pty) throws on load in packaged builds.
  // No effect in dev.
  banner: {
    js: `try{require('fs').appendFileSync('/tmp/zeros-boot.log','[banner] main.cjs entered '+new Date().toISOString()+'\\n');}catch(e){}
process.on('uncaughtException',function(err){try{require('fs').appendFileSync('/tmp/zeros-boot.log','[uncaught] '+(err&&err.stack||err)+'\\n');}catch(e){}});
`,
  },
});
