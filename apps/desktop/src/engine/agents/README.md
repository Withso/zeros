# Agent runtime

This module owns the three supported coding-agent runtimes: Claude Code, Codex,
and Cursor. Each adapter translates its provider's native lifecycle into the
canonical events and messages in `@zeros/protocol`; the gateway exposes that
uniform contract to the engine transport.

## Layout

```text
agents/
├── adapters/
│   ├── claude/       # Claude event translation
│   ├── claude-sdk/   # Claude Agent SDK session adapter
│   ├── codex/        # Codex app-server adapter and generated protocol types
│   ├── cursor-sdk/   # Cursor SDK adapter and isolated host
│   └── shared/       # stdio, JSON-RPC, discovery, expiry, and config isolation
├── gateway/          # gateway HTTP/auth/vault helpers
├── gateway.ts        # session orchestration and event routing
├── registry.ts       # supported-agent manifest and factories
├── probes.ts         # installation/runtime/auth status probes
├── mcp-registry.ts   # external MCP server registry
├── mcp-scan.ts       # provider/project MCP discovery
├── session-paths.ts  # per-session state and crash cleanup
└── types.ts          # adapter boundary
```

## Adapter contract

Every adapter implements `AgentAdapter` from `types.ts`. It owns provider
sessions, converts native events into `AgentSessionEvent`, settles permission
requests, and reports normalized failures. The gateway multiplexes those events
to subscribed clients without leaking provider-specific transport details into
the renderer.

| Agent | Runtime | Event source |
| --- | --- | --- |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | SDK streaming input/output and provider history |
| Codex | `codex app-server` over JSON-RPC stdio | thread, turn, item, and approval notifications |
| Cursor | bundled `@cursor/sdk` | typed in-process run stream |

Adding an agent requires a registry entry, adapter implementation, capability
mapping, auth/runtime probe, normalized lifecycle coverage, and renderer brand
metadata. Do not add a generic protocol layer solely to make unlike provider
semantics appear identical.

## Credentials and session state

Credential material remains in provider-managed storage or the app's encrypted
secret store. Probes return availability booleans only; token values never cross
the agent boundary or enter logs. Any content-aware probe reads only the minimum
field needed to determine validity.

Per-session state lives under `<engine-data-dir>/sessions/<session-id>/` with
`env/`, `log/`, `telemetry/`, and `meta.json`. Graceful teardown removes it;
boot-time cleanup removes state belonging to processes that no longer exist.

Run adjacent adapter and gateway tests after every change. Protocol changes also
require the `packages/protocol` tests and `pnpm check:protocol`.
