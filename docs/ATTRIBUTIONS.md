# Attributions

Zeros builds on the following open-source projects and assets.
All are used under their respective licenses; see individual project
repositories for full license text.

## UI components & design

- **[shadcn/ui](https://ui.shadcn.com/)** — used under [MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md).
- **[lucide-react](https://lucide.dev)** — icon set, ISC license.
- **[Unsplash](https://unsplash.com)** — sample imagery in
marketing-surface mocks, [Unsplash license](https://unsplash.com/license).

## Core native-app stack

- **[Electron](https://www.electronjs.org)** (MIT) — desktop shell, main
  process, preload bridge.
- **Built-in / npm modules** — deep links, notifications, and app menus
  are implemented with Electron and macOS APIs in `electron/` (replacing
  older Tauri plugin equivalents).
- **[node-pty](https://github.com/microsoft/node-pty)** (MIT) —
  embedded terminal PTY in the main process.
- **[electron-updater](https://github.com/electron-userland/electron-builder)**
  (MIT) — in-app update checks (see `electron/updater.ts`).

## Note on older docs

Attributions previously listed Tauri, `git2-rs`, and other Rust crates
from a former `src-tauri/` tree. The shipping app uses the stack above;
keep historical crate mentions only in archived or labeled docs.

## JS engine stack

- **[PostCSS](https://postcss.org)** (MIT) — CSS parsing in
`src/engine/css-resolver.ts`.
- **[@parcel/watcher](https://github.com/parcel-bundler/watcher)**
(MIT) — native filesystem watcher.
- **[tinyglobby](https://github.com/SuperchupuDev/tinyglobby)** (MIT)
— CSS file discovery.
- **[ws](https://github.com/websockets/ws)** (MIT) — engine ↔ webview
WebSocket bridge.
- **[xterm.js](https://xtermjs.org)** (MIT) — terminal renderer in
the Terminal panel.
- **[@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript)**
(MIT) — direct Anthropic Messages API streaming.
- **[@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)**
(MIT) — MCP server implementation for external AI tools.

## Design references

- **Original UI design:** [Figma Design File](https://www.figma.com/design/pHn0A8C25STCmSniuSFuQp/Design-Collaboration-Tool)
- **Cursor** (cursor.com) — UI/UX inspiration for the 3-column shell.
- **Clonk / Komand** (clonk.ai) — inspiration for the skills system,
pricing model, worktree parallel agents.

## TODO

- Audit `package.json` / `electron-builder` native deps and list any
  crates or binaries not captured above.
- Add full LICENSE file references once distribution begins in
Phase 5 (per App Store / notarization requirements if ever
pursued).
- Generate a machine-readable `third-party-licenses.txt` on
build for the About panel.
