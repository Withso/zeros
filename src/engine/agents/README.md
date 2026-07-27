# Agent runtime

Per-agent adapters that drive each coding agent directly. The active set is
exactly three: **Claude** (the official `@anthropic-ai/claude-agent-sdk`),
**Codex** (the `codex app-server` JSON-RPC runtime), and **Cursor** (the
bundled `@cursor/sdk`). Every canonical wire shape is owned in
`@zeros/core/agent-events` — no generic-protocol layer, no npx adapter chain.

## History

This module previously hosted a generic **ACP** (Agent Client Protocol)
fabric, stream-json adapters, and a localhost **hook-server**, used to drive
Cursor / OpenCode / Factory Droid / Antigravity / Gemini. Those agents and the
entire ACP + stream-json + hook-server machinery were removed (2026-06-16 — see
git history). All three survivors run on first-party SDKs/runtimes:

- **Claude** — in-loop `canUseTool` permissions via the Agent SDK (no hook server).
- **Codex** — `codex app-server`, JSON-RPC 2.0 over stdio (shared stdio fabric
  in `adapters/shared/{stdio-process,jsonrpc}.ts`).
- **Cursor** — `@cursor/sdk`, in-process `Agent.create/send` + `run.stream()`.

## Layout

```
src/engine/agents/
├── README.md              — this file
├── types.ts               — AgentAdapter interface + event types
├── gateway.ts             — AgentGateway (orchestrator; drops into ZerosEngine)
├── registry.ts            — local manifest of the 3 supported agents
├── session-paths.ts       — <engine-data-dir>/sessions/ layout + boot-time GC
├── task-tools.ts          — TodoWrite / TaskCreate plan parsing (shared)
└── adapters/
    ├── shared/            — login-shell PATH, stdio JSON-RPC client + process
    │                        spawn, session-expiry classifier, command/subagent
    │                        discovery, constants
    ├── claude/            — ClaudeStreamTranslator (consumed by claude-sdk)
    ├── claude-sdk/        — Claude via @anthropic-ai/claude-agent-sdk
    ├── codex/             — Codex via `codex app-server` (JSON-RPC) + generated bindings
    └── cursor-sdk/        — Cursor via @cursor/sdk (in-process)
```

## How agents plug in

Every adapter implements `AgentAdapter` (see `types.ts`): it owns its sessions,
translates the agent's native events into the canonical `AgentSessionEvent`
stream, and reports lifecycle failures through `AgentFailure`. The gateway
multiplexes these over the WebSocket.

| Agent | Runtime | Permissions | Event source |
|---|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` (`query()` streaming-input) | in-loop `canUseTool` | typed SDK messages + `~/.claude/projects` JSONL |
| Codex | `codex app-server` (JSON-RPC stdio) | `item/*/requestApproval` round-trip | JSON-RPC notifications (thread/turn/item) + `~/.codex/sessions` rollout |
| Cursor | bundled `@cursor/sdk` (in-process) | none interactive (headless SDK) | typed `run.stream()` SDKMessages |

## Auth posture

Presence-only credential probing, never read: Claude via the macOS Keychain /
`~/.claude` dotfiles, Codex via `codex login status`, Cursor via the
`CURSOR_API_KEY` secret (the `@cursor/sdk` is API-key only). We never store
tokens or handle OAuth ourselves — the vendor owns the session, we orchestrate.

## Session state

Each session gets a directory at `<engine-data-dir>/sessions/<session-id>/`:

- `meta.json` — agent id, cwd, created-at, pid (for crash-recovery GC)
- `env/` — per-agent config overrides
- `log/` — transcript, stderr tail
- `telemetry/` — rollout copies for Codex

Directories are cleaned on session end or app-quit; `sweepDeadSessions()` GCs
any left by a hard crash on the next boot.
