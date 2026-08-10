import { defineConfig, loadEnv } from "vite";
import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

// Strict CSP for the PACKAGED Electron renderer (loaded from file://). Injected
// ONLY by `vite build` — dev (serve) needs HMR's ws+eval. connect-src enumerates
// every origin the renderer actually talks to (engine WS, control plane, PostHog,
// BYO-key AI providers, model catalog); frame-src
// stays open for the embedded browser tab; script-src is locked to 'self'
// (+ wasm-unsafe-eval for shiki) to neutralise injected/remote scripts so an
// XSS can't exfiltrate the in-memory session token.
//
// The control-plane origin is derived from VITE_CONTROL_PLANE_URL so local and
// Railway-provided domains work as well as the custom *.zeros.build domains.
// Organizations and feedback now share this one authenticated backend.
function buildElectronRendererCsp(controlPlaneOrigin: string): string {
  const connectSrc = [
    "'self'",
    "ws://localhost:*",
    "ws://127.0.0.1:*",
    "http://localhost:*",
    "wss://*.zeros.build",
    "https://*.zeros.build",
    "https://*.posthog.com",
    "https://*.i.posthog.com",
    "https://api.openai.com",
    "https://api.anthropic.com",
    // GitHub Pages origin that hosts the versioned provider/model catalog
    // JSON + its JSON Schemas (see catalogs/*-v1.schema.json `$id`). The
    // shipped app imports the catalog statically, so this entry only keeps
    // the door open for a hot catalog refresh without a re-release; it is
    // NOT a tracking or telemetry endpoint.
    "https://withso.github.io",
    controlPlaneOrigin,
  ]
    .filter(Boolean)
    .join(" ");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    // NB: frame-ancestors is intentionally omitted — it's ignored when delivered
    // via <meta> (header-only), and the Electron window is never framed anyway.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-src https: http: blob: data: zeros-design:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "media-src 'self' blob: data:",
  ].join("; ");
}

// Origin (scheme+host) parsed from the environment-specific control-plane URL.
// Returns "" when the env is unset or unparseable.
function controlPlaneOriginFromEnv(url: string | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

function electronRendererCsp(command: string, mode: string) {
  // Resolve the CSP once at config-eval time (loadEnv reads .env* + matching
  // process.env). Only injected on `vite build`; dev serve returns html as-is.
  const controlPlaneOrigin = controlPlaneOriginFromEnv(
    loadEnv(mode, process.cwd(), "VITE_").VITE_CONTROL_PLANE_URL,
  );
  const csp = buildElectronRendererCsp(controlPlaneOrigin);
  return {
    name: "zeros-electron-renderer-csp",
    transformIndexHtml(html: string): string {
      if (command !== "build") return html;
      const tag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
      return html.replace(/<\/head>/i, `    ${tag}\n  </head>`);
    },
  };
}

function loadersShowcasePlugin() {
  // Showcase HTML lives in styles/Artifacts/ (moved out of the old Loaders/
  // dir). Still served under /loaders and /Loaders for back-compat, e.g.
  // http://localhost:5193/Loaders/loaders-preview.html.
  const loadersDir = path.resolve(__dirname, "styles/Artifacts");
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
  };

  return {
    name: "zeros-loaders-showcase",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith("/loaders") && !url.startsWith("/Loaders")) {
          return next();
        }

        let rel = url
          .replace(/^\/loaders\/?/i, "")
          .replace(/^\/Loaders\/?/i, "");
        if (!rel || rel === "/") rel = "loaders-preview.html";

        const filePath = path.join(loadersDir, rel);
        if (!filePath.startsWith(loadersDir)) {
          res.statusCode = 403;
          res.end("Forbidden");
          return;
        }

        import("node:fs")
          .then(({ existsSync, readFileSync }) => {
            if (!existsSync(filePath)) {
              res.statusCode = 404;
              res.end("Not found");
              return;
            }
            const ext = path.extname(filePath);
            res.setHeader(
              "Content-Type",
              mime[ext] ?? "application/octet-stream",
            );
            res.setHeader("Cache-Control", "no-store");
            res.end(readFileSync(filePath));
          })
          .catch(next);
      });
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  // Electron renderer loads from file://, so assets use a RELATIVE base ('./');
  // an absolute '/assets/*' would resolve to the filesystem root and render a
  // blank window. (The web target that needed '/' was removed.)
  base: "./",
  // Keep prior Vite logs visible across restarts so debugging a
  // dev-session cascade doesn't lose the lead-up. Without this every
  // server restart wipes the terminal, hiding the "vite.config.ts
  // changed" line that diagnosed the problem in the first place.
  clearScreen: false,
  server: {
    // Pinned desktop-renderer port. Distinct from the marketing site (3000)
    // and the Wrangler web hub (8788), so Electron's Vite never collides
    // with `pnpm dev` in apps/marketing/ — which used to silently
    // grab 5173 and leave Electron loading the marketing home page.
    // strictPort: true makes the collision fail loudly instead of
    // letting Vite fall back to 5174.
    //
    // ZEROS_VITE_PORT lets scripts/dev-instance.mjs move a per-worktree dev
    // instance to a free port (the launcher already probed it free, and points
    // that instance's Electron renderer at it via ELECTRON_RENDERER_URL + the
    // engine's WS origin allowlist via the same var). Unset → the pinned 5193.
    port: Number(process.env.ZEROS_VITE_PORT) || 5193,
    strictPort: true,
    host: true,
    watch: {
      // 2026-05-29 audit: a long dev session showed Vite force-
      // reloading the Electron renderer 19+ times in an hour with
      // "vite.config.ts changed, restarting server…". Each reload is
      // a full page nav → ~1-3 s of blank black window. Root cause:
      // chokidar fires for any change anywhere under the repo and
      // Vite's config-watcher treats any ancestor event as a config
      // mtime touch. The previous ignored list was coarse — git
      // ops, log/db writes, lock-file rewrites, sibling apps and
      // websites all slipped through and tickled the config watcher.
      //
      // Pattern groups:
      //   - generated/build outputs (dist-*, .next/, build/, out/)
      //   - native bindings + binaries
      //   - workspace-local state (agent/worktree scratch dot-dirs)
      //   - log/db/lock files (mtime changes constantly, never source-relevant)
      //   - .git internals (rewritten on every checkout/commit/stash)
      //   - sibling apps + websites (separate Vite roots; their
      //     edits should NEVER trigger a Mac-app restart)
      //   - macOS/editor noise (.DS_Store, *.swp, *~)
      ignored: [
        "**/*.0c",
        "**/.zeros/**",
        // Per-workspace scratch dirs written by worktree/agent runners
        // (attachments, hand-off files). Gitignored and rewritten
        // constantly; their churn must never reload the Mac-app renderer.
        "**/.conductor/**",
        "**/.context/**",
        "**/.git/**",
        "**/.git",
        "**/dist-engine/**",
        "**/dist-electron/**",
        "**/dist/**",
        "**/build/**",
        "**/out/**",
        "**/.next/**",
        "**/binaries/**",
        "**/node_modules/**",
        "**/coverage/**",
        "**/*.log",
        "**/*.db",
        "**/*.db-shm",
        "**/*.db-wal",
        "**/*.sqlite",
        "**/*.swp",
        "**/*~",
        "**/.DS_Store",
        // Sibling deployables own separate build loops. Ignore them without
        // swallowing apps/desktop, which is this Vite server's source tree.
        "**/apps/control-plane/**",
        "**/apps/web/**",
        "**/apps/marketing/**",
        "**/docs/**",
        // pnpm/npm lockfile churn: spurious mtime touches happen
        // when pnpm normalises ordering with no semantic change.
        "**/pnpm-lock.yaml",
        "**/package-lock.json",
        "**/yarn.lock",
      ],
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    electronRendererCsp(command, mode),
    loadersShowcasePlugin(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./apps/desktop/src"),
    },
    // CodeMirror requires a SINGLE instance of its state/view core. Two copies —
    // one pre-bundled into @uiw/react-codemirror, one from our direct
    // @codemirror/* imports — break Facet/extension identity at runtime
    // ("Unrecognized extension value"/"calling a builtin... is not a function").
    // Dedupe forces one instance across the whole graph (Vite #1801). Only DIRECT
    // deps are listed — @lezer/common is transitive (pnpm already pins one
    // version), and listing it makes Rollup fail to resolve it from the root.
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@lezer/highlight",
    ],
  },
  // Module workers (syntax.worker.ts) need ESM output for code-splitting.
  // Shiki has dynamic imports internally
  // for grammars/themes; the default "iife" worker format rejects
  // the build with "UMD and IIFE output formats are not supported
  // for code-splitting builds".
  worker: {
    format: "es",
  },
  // Pre-bundle the statically-imported xterm.js stack so a freshly-
  // installed dev server doesn't have to optimize them on first
  // request. `@xterm/addon-canvas` is intentionally OMITTED: it's
  // loaded via dynamic `import()` with a graceful fallback (see
  // terminal-session-view.tsx) so checkouts that haven't run
  // `pnpm install` since the dep was added still build + run. Listing
  // it here would make Vite blow up at boot if the dep is missing.
  optimizeDeps: {
    // Pin the dependency pre-scan to the Mac app's own entry. Without
    // this, Vite's scanner globs every **/*.html under the repo root —
    // pulling in sibling app roots and standalone design artifacts. The log
    // from the black-
    // screen session shows it crawling all of them, then failing with
    // "Failed to run dependency scan … server is being restarted":
    // the scan is async and a config restart mid-crawl aborts it. The
    // Mac-app deps are all reachable from index.html, so scoping the
    // scan here is both correct and far cheaper.
    entries: ["index.html"],
    include: [
      "@xterm/xterm",
      "@xterm/addon-fit",
      // @pierre/trees ships its React surface as a subpath export
      // (`@pierre/trees/react`). The dep pre-scan above is scoped to
      // index.html via `entries`, and Vite's dev server doesn't
      // reliably auto-pre-bundle a freshly-added subpath export — so
      // it throws "Failed to resolve import @pierre/trees/react" on
      // first paint of the Files tab, even though the prod (rollup)
      // build resolves it fine. Pre-bundling it here (same treatment
      // as the xterm stack) fixes dev resolution. The Files tab is a
      // static import and pinned, so it mounts at startup anyway.
      "@pierre/trees/react",
    ],
  },
  assetsInclude: ["**/*.svg", "**/*.csv"],
}));
