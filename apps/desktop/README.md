# Desktop application

This directory contains the desktop product, whose current shipping target is
macOS. The repository root owns its package manifest, lockfile, Vite/Electron
build configuration, and desktop scripts so release and native-module workflows
retain one build root as Windows and Linux targets are added later.

## Process boundaries

| Path | Responsibility |
| --- | --- |
| `electron/` | Electron main process, preload bridge, native OS integration, IPC, updater, secrets, and engine supervision |
| `src/engine/` | Local Node sidecar: agents, Git/worktrees, SQLite, PTY, settings, and transport |
| `src/renderer/` | React renderer: feature UI, shell composition, state, platform bridge, and shared primitives |
| `src/assets/` | Desktop-owned images and agent marks |

The renderer has no direct Node access. Native capabilities pass through the
allowlisted preload bridge; engine capabilities pass through the authenticated
loopback transport. Keep validation and authorization at those boundaries.

## Renderer layout

- `features/` contains product capabilities such as agents, repositories,
  browser, design workspaces, organization context, settings, and authentication.
- `shell/` composes conversation and workbench surfaces plus window-level
  navigation, dialogs, terminal, and pull-request UI.
- `platform/` adapts native/bridge/browser APIs.
- `state/` contains cross-feature renderer stores and persistence.
- `shared/` contains feature-neutral UI, theme, and utilities.
- `config/` contains build/runtime configuration; `harnesses/` contains visual
  test entrypoints.

Run desktop commands from the repository root. See the root
[README](../../README.md) and [repository architecture](../../REPOSITORY-ARCHITECTURE.md).
