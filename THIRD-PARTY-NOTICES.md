# Third-party notices

Zeros itself is MIT licensed (see `LICENSE`). It links, bundles or vendors the
third-party work listed below, each under its own licence.

This file records **what** we use and **under which licence**; it deliberately
does not reproduce licence text. Every entry links upstream, where the
authoritative licence and any NOTICE file live. For the exact resolved version
of every transitive dependency, read `pnpm-lock.yaml` — it is the machine
-readable source of truth and it is committed.

Two categories need naming explicitly because they are *in the tree*, not just
in `node_modules`: the generated Codex protocol bindings, and the vendored d3
bundle in the design lab. Both are called out below.

---

## Code generated from third-party sources (in-tree)

### Codex app-server protocol bindings

- **Path:** `src/engine/agents/adapters/codex/generated/` (1,001 files)
- **Derived from:** [openai/codex](https://github.com/openai/codex) —
  **Apache-2.0**, pinned to the tag in `package.json` → `codexProtocolVersion`
  (currently recorded in `src/engine/agents/adapters/codex/generated/.version`).
- **How:** `scripts/codegen-codex.mjs` sparse-clones the pinned tag and runs
  the upstream `codex-app-server-protocol` export binary. Nothing is
  hand-edited; every file carries a `GENERATED CODE! DO NOT MODIFY BY HAND!`
  header. The output is committed so machines without a Rust toolchain can
  still build.
- **Generator:** [ts-rs](https://github.com/Aleph-Alpha/ts-rs) (Aleph Alpha) —
  used by upstream to emit the TypeScript; dual **MIT / Apache-2.0**.

These files are marked `linguist-generated` in `.gitattributes`. That mark is
about diff noise and GitHub's language bar, not about provenance — provenance
is this entry.

### Vendored d3 (design lab only)

- **Path:** `styles/Artifacts/run-globe/run-globe-d3.min.js`
- **What:** [d3-array](https://github.com/d3/d3-array) v3 +
  [d3-geo](https://github.com/d3/d3-geo) v3.1.1 UMD builds, concatenated
  unmodified. Copyright Mike Bostock. **ISC**.
- **Why vendored:** the design lab under `styles/Artifacts/` is a build-free
  set of HTML mockups that must open straight off `file://`, so it loads d3
  with a plain `<script>` tag rather than through the bundler.
- **Note:** `styles/Artifacts/` is a *development-only* tree. It is served
  exclusively by a Vite `configureServer` middleware (`vite.config.ts`) and by
  `scripts/serve-loaders.mjs`; it never enters a production build, and it is
  not tracked in git (see `.gitignore`).

### Precomputed globe geometry (design lab only)

- **Path:** `styles/Artifacts/run-globe/run-globe-geo.js`
- **Derived from:** [world-atlas](https://github.com/topojson/world-atlas)
  `countries-110m` (**ISC**), itself built from
  [Natural Earth](https://github.com/nvkelso/natural-earth-vector) 1:110m
  vector data, which Natural Earth releases into the **public domain**.
- **How:** `styles/Artifacts/run-globe/build-geo.mjs` (simplify → land feature
  → round). See `styles/Artifacts/run-globe/README.md`.

---

## Native app shell

| Project | Licence | Upstream |
| --- | --- | --- |
| Electron | MIT | https://github.com/electron/electron |
| electron-updater (electron-builder) | MIT | https://github.com/electron-userland/electron-builder |
| node-pty | MIT | https://github.com/microsoft/node-pty |
| better-sqlite3 | MIT | https://github.com/WiseLibs/better-sqlite3 |
| @vscode/ripgrep | MIT | https://github.com/microsoft/vscode-ripgrep |
| fix-path | MIT | https://github.com/sindresorhus/fix-path |

## Agent SDKs and protocol clients

| Project | Licence | Upstream |
| --- | --- | --- |
| @anthropic-ai/claude-agent-sdk | See the licence shipped inside the package | https://github.com/anthropics/claude-agent-sdk-typescript |
| @openai/codex | Apache-2.0 | https://github.com/openai/codex |
| @cursor/sdk | See the licence shipped inside the package | https://www.npmjs.com/package/@cursor/sdk |
| @modelcontextprotocol/sdk | MIT | https://github.com/modelcontextprotocol/typescript-sdk |

The two "see the licence shipped inside the package" entries declare
`SEE LICENSE IN …` in their own `package.json`; read the file in the installed
package rather than assuming a standard identifier.

## Renderer and UI

| Project | Licence | Upstream |
| --- | --- | --- |
| React / React DOM / React Router | MIT | https://github.com/facebook/react |
| Vite | MIT | https://github.com/vitejs/vite |
| Tailwind CSS | MIT | https://github.com/tailwindlabs/tailwindcss |
| Radix UI primitives | MIT | https://github.com/radix-ui/primitives |
| shadcn/ui (component source, copied into `src/zeros/ui/primitives/`) | MIT | https://github.com/shadcn-ui/ui |
| lucide-react | ISC | https://github.com/lucide-icons/lucide |
| cmdk | MIT | https://github.com/pacocoursey/cmdk |
| sonner | MIT | https://github.com/emilkowalski/sonner |
| zustand | MIT | https://github.com/pmndrs/zustand |
| class-variance-authority | Apache-2.0 | https://github.com/joe-bell/cva |
| clsx | MIT | https://github.com/lukeed/clsx |
| tailwind-merge | MIT | https://github.com/dcastil/tailwind-merge |
| tw-animate-css | MIT | https://github.com/Wombosvideo/tw-animate-css |
| use-stick-to-bottom | MIT | https://github.com/samdenty/use-stick-to-bottom |
| qrcode.react | ISC | https://github.com/zpao/qrcode.react |
| Geist / Geist Mono (via @fontsource-variable) | OFL-1.1 | https://github.com/vercel/geist-font |

## Editors, terminals and text rendering

| Project | Licence | Upstream |
| --- | --- | --- |
| CodeMirror 6 (`@codemirror/*`, `@lezer/*`) | MIT | https://github.com/codemirror/dev |
| @uiw/react-codemirror | MIT | https://github.com/uiwjs/react-codemirror |
| @replit/codemirror-indentation-markers | MIT | https://github.com/replit/codemirror-indentation-markers |
| Tiptap / ProseMirror (`@tiptap/*`) | MIT | https://github.com/ueberdosis/tiptap |
| xterm.js (`@xterm/*`) | MIT | https://github.com/xtermjs/xterm.js |
| shiki | MIT | https://github.com/shikijs/shiki |
| marked | MIT | https://github.com/markedjs/marked |
| DOMPurify | MPL-2.0 OR Apache-2.0 | https://github.com/cure53/DOMPurify |
| diff | BSD-3-Clause | https://github.com/kpdecker/jsdiff |

## Git, files and engine plumbing

| Project | Licence | Upstream |
| --- | --- | --- |
| isomorphic-git | MIT | https://github.com/isomorphic-git/isomorphic-git |
| @pierre/diffs, @pierre/trees | Apache-2.0 | https://www.npmjs.com/package/@pierre/diffs |
| chokidar | MIT | https://github.com/paulmillr/chokidar |
| tinyglobby | MIT | https://github.com/SuperchupuDev/tinyglobby |
| ws | MIT | https://github.com/websockets/ws |
| PostCSS | MIT | https://github.com/postcss/postcss |
| zod | MIT | https://github.com/colinhacks/zod |
| nanoid | MIT | https://github.com/ai/nanoid |
| smol-toml | BSD-3-Clause | https://github.com/squirrelchat/smol-toml |
| @decimalturn/toml-patch | MIT | https://github.com/DecimalTurn/toml-patch |
| @octokit/rest, @octokit/auth-oauth-device | MIT | https://github.com/octokit |

## Telemetry

| Project | Licence | Upstream |
| --- | --- | --- |
| posthog-js | See the licence shipped inside the package | https://github.com/PostHog/posthog-js |

---

## Keeping this file honest

When you add a runtime dependency that is (a) bundled into the shipped app or
(b) copied/vendored into the tree, add it here in the same pass. Anything that
is only a build-time devDependency does not ship and does not need an entry —
`pnpm-lock.yaml` still records it.
