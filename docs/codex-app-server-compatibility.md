# Codex app-server harness boundary

Zeros uses the long-lived Codex app-server for interactive Codex sessions. The
[official app-server contract](https://learn.chatgpt.com/docs/app-server) is the
upstream authority; generated bindings for the version pinned in
`package.json#codexProtocolVersion` are the local wire authority.

This integration is intentionally split into two layers:

- The Codex harness owns process startup, JSON-RPC, initialization, generated
  method/parameter types, Codex host requests, thread/turn transport, and
  translation into Zeros' canonical agent events.
- Zeros owns live session identity, durable chat identity, persistence,
  lifecycle projection, browser/tool implementations, skills, plugins, apps,
  MCP configuration, approval UI, and every renderer-facing capability.

Codex protocol availability must never be interpreted as a reason to create a
Codex-owned duplicate of a Zeros product domain. A Codex-specific product
feature should consume this harness behind an engine-owned interface. It must
not expose arbitrary app-server RPC to the renderer or shared agent protocol.

## Pin and generated bindings

`@openai/codex`, `package.json#codexProtocolVersion`, and the generated tree at
`apps/desktop/src/engine/agents/adapters/codex/generated/` move together. Run
`pnpm codegen:codex` only as part of an intentional pin upgrade. Generated
files are not edited by hand.

`pnpm check:codex-pin` verifies both the pin/generated-schema relationship and
the compatibility manifest. A regenerated method cannot silently appear or
disappear without review.

## Compatibility classifications

`protocol-coverage.json` classifies every method in `ClientRequest`,
`ServerRequest`, and `ServerNotificationEnvelope`. The manifest describes the
harness boundary, not UI completeness:

- Client `handled`: the harness has an explicit lifecycle wrapper.
- Client `generated-only`: generated method/params are available to typed,
  Codex-only engine integrations, but the harness makes no product-support
  claim.
- Server `handled`: the harness returns a safe method-specific response or
  completes the existing approval/question lifecycle.
- Server `provider-conditional`: the method is registered only when an explicit
  host callback exists.
- Notification `canonical`: the translator consumes the event, including
  deliberate semantic no-ops for aggregate events already represented by a
  more precise Zeros event.
- Notification `handled`: the runtime consumes the event internally.
- Notification `forwarded`: generated typed subscription is available, but no
  canonical or product behavior is claimed.

At the 0.146.0 pin this covers 211 methods: 128 client requests, 11 server
requests, and 72 server notifications. Run `pnpm check:codex-coverage` for the
offline drift check.

## Host requests and authentication

All blocking handlers are registered before the client sends `initialized`.
Approvals, native questions, MCP elicitation, peer-side request resolution, and
host time retain their existing safe response behavior.

The harness additionally provides typed callbacks for:

- `item/tool/call`, with a method-shaped failure response when no tool host is
  registered;
- `account/chatgptAuthTokens/refresh`, only for Codex's explicit external-token
  mode; and
- `attestation/generate`, advertised only when a provider exists.

Ordinary Codex login remains Codex-managed. In particular, the external token
callback must not reuse the unrelated Zeros/Auth0 application token. Response
validation happens before credentials or attestation are returned to Codex.

## Dynamic tools and canonical events

The generated `ThreadStartParams` already carries experimental `dynamicTools`.
Codex invokes an advertised tool through `item/tool/call`; the harness routes
that request to a provider-neutral callback. A browser implementation, file
tool, or future common tool registry is a separate Zeros-owned layer.

Dynamic-tool lifecycle items use the same canonical `tool_call` and
`tool_call_update` events as other agents. Responses-compatible text, image,
and audio items are converted into Zeros-owned content blocks. Remote HTTP(S)
media remains a resource link. No browser artifact schema or product-specific
path is embedded in the Codex translator.

## Packaged runtime and sandbox resources

Packaged Electron builds cannot resolve Codex's optional platform npm package
from the Bun-compiled engine. `scripts/stage-codex-cli.mjs` therefore stages the
complete pinned target below:

```text
Resources/codex-runtime/
  package.json
  vendor/<triple>/
    bin/codex
    bin/codex-code-mode-host
    codex-path/rg
    codex-package.json
    codex-resources/...
```

The full target is intentional. On Linux, `codex-resources` contains the
bundled sandbox helpers, including `bwrap` and `zsh`. Electron passes the exact
binary, version, and `CODEX_MANAGED_PACKAGE_ROOT` to the engine as one atomic
selection; an explicit binary override does not inherit staged metadata.

Target mapping and file completeness are tested on the current host. Actual
Windows sandbox behavior still requires a Windows packaging/runtime check and
must not be claimed from macOS or Linux CI.

## Explicit non-goals

This harness change does not add or change:

- Zeros chat/session identifiers, Codex native thread persistence, database
  migrations, fork/archive/rename/pin synchronization, or lifecycle projection;
- renderer capability RPC, Codex settings panels, marketplace/plugin/app UI,
  or SDK jobs;
- browser automation, browser leases, native views, CDP, or MCP browser
  servers; or
- Zeros-native skills, MCP, apps, plugins, and future cross-agent tool
  registries.

Those capabilities should be delivered in later Zeros-owned PRs, with this
harness acting only as the Codex transport adapter.
