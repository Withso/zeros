# Codex app-server harness boundary

Zeros uses the long-lived Codex app-server for interactive Codex sessions. The
[official app-server contract](https://learn.chatgpt.com/docs/app-server) is the
upstream authority; generated bindings for the version pinned in
`package.json#codexProtocolVersion` are the local wire authority.

This integration is intentionally split into two layers:

- The Codex harness owns process startup, JSON-RPC, initialization, generated
  method/parameter types, Codex host requests, thread/turn transport (including
  typed start/resume/fork), and translation into Zeros' canonical agent events.
- Zeros owns live execution identity, durable conversation identity,
  [provider-binding persistence](agent-identity-model.md),
  lifecycle projection, browser/tool implementations, skills, plugins, apps,
  MCP configuration, approval UI, and every renderer-facing capability.

Codex protocol availability must never be interpreted as a reason to create a
Codex-owned duplicate of a Zeros product domain. A Codex-specific product
feature consumes the narrow engine-owned ports documented in
[Agent harness capability boundary](agent-harness-capability-boundary.md). It
must not expose arbitrary app-server RPC to the renderer or shared agent
protocol.

## Pin and generated bindings

`@openai/codex`, `package.json#codexProtocolVersion`, and the generated tree at
`apps/desktop/src/engine/agents/adapters/codex/generated/` move together. Run
`pnpm codegen:codex` only as part of an intentional pin upgrade. The pinned
Codex CLI generates TypeScript and JSON Schema into a sibling staging tree;
Zeros prunes retired bindings and publishes that tree only after every step
succeeds. A failed exporter therefore leaves the last committed bindings
intact. Generated files are not edited by hand.

`pnpm check:codex-pin` verifies both the pin/generated-schema relationship and
the compatibility manifest. A regenerated method cannot silently appear or
disappear without review.

## Compatibility classifications

`protocol-coverage.json` classifies every method in `ClientRequest`,
`ServerRequest`, and `ServerNotificationEnvelope`. The manifest describes the
harness boundary, not UI completeness:

This is a structural classification and protocol-drift check, not proof that
every classified method has a behavioral implementation or test.

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

At the 0.149.0 pin this covers 239 methods: 151 client requests, 11 server
requests, and 77 server notifications. The 23 added client requests and five
added notifications are classified without making product-support claims. Run
`pnpm check:codex-coverage` for the offline drift check.

## Qualified Phase 2 product paths

The generated surface now backs two additional, narrow product behaviors:

- A bare `/review` prompt runs the explicit `runReview` lifecycle wrapper,
  which sends `review/start` inline against uncommitted changes and waits on the
  same turn-completion correlation as `turn/start`. The entered/exited review
  items are bookkeeping; the accompanying final `agentMessage` becomes the
  ordinary Zeros answer so the findings cannot render twice.
- The shared background-task Stop action resolves a Zeros-owned opaque task id
  to its session-owned `(threadId, processId)` and sends only
  `thread/backgroundTerminals/terminate`. List publication is replace-style and
  latest-wins across termination races, bounded across the exact session, and
  revalidated only while task rows remain visible so native process exit clears
  the shared card. `thread/backgroundTerminals/clean` is not used because its
  contract stops all running terminals, not completed records.

Neither path adds a renderer-facing app-server method or parameter bridge.
Native Codex history search/read remains outside the product surface; future
conversation search is a Zeros-owned cross-harness domain.

## Qualified Phase 3 product paths

Phase 3 adds three more engine-owned capability domains and a bounded event
projection; it does not expose a generic Codex capability bridge:

- The memory port reads and compare-and-swap writes the user config layer for
  `features.memories` and
  `memories.disable_on_external_context`, synchronizes the native memory mode
  on live threads, and exposes confirmed global `memory/reset` only to the local
  desktop Settings surface. Provider work runs in the contained one-shot
  runtime with MCP disabled.
- The goal port maps exact live executions to `thread/goal/get`, `.set`, and
  `.clear`. A bare, attachment-free `/goal` is Zeros' explicit UI trigger;
  native goal updates remain provider-owned state and stale initial reads
  cannot overwrite a later mutation or notification.
- The safety port keeps denied Guardian actions bounded and engine-only. The
  renderer receives a sanitized audit row plus a short-lived opaque retry id;
  `thread/approveGuardianDeniedAction` consumes that authority once and revokes
  it only after confirmed success. Retry ids are not folded into durable chat
  messages.
- Hook, MCP-progress, model-verification/reroute/buffering, environment,
  external-import, Guardian, and MCP-health notifications are projected through
  existing Zeros transcript primitives. Exact-thread filters reject child
  events where the native contract is thread-scoped, late/replayed lifecycle
  edges cannot reopen completed work, and native paths, callback URLs, raw
  action payloads, and diagnostic strings stay adapter-side.

Claude's independent native auto-memory option is carried through its Agent SDK
adapter. Cursor currently exposes no equivalent public SDK setting, goal, or
Guardian approval channel, so Zeros does not advertise synthetic parity.

## Qualified consolidated provider settings and quota paths

Two additional app-server reads stay behind narrow Zeros domains:

- Configuration provenance calls `config/read` with layer inclusion inside a
  contained one-shot runtime. Only stable layer labels and loaded/suppressed
  state cross the adapter; file paths, config values, provider diagnostics, and
  disabled-reason text remain engine-side. The narrow read remains available
  for a future actionable diagnostic, but Models settings does not request or
  present it and there is no raw configuration editor.
- Account quota calls `account/rateLimits/read`; live
  `account/rateLimits/updated` notifications are sparse-merged before a compact
  Models → Codex Usage limits block is updated. Quota messages are local-host
  diagnostics, never relay conversation state. `account/updated` logout clears
  the cached snapshot and emits null immediately so data from a prior account
  cannot remain visible.

`account/usage/read`, reset-credit consumption, login/logout controls, provider
dashboards, projects/sections/queues, imports, voice, remote control,
environments, skills/plugins/hooks/apps/custom tools, and native MCP
administration remain unprojected. Existing `turn/plan/updated` is a deliberate
semantic no-op until Zeros owns a persistent cross-harness checklist product;
it is not mislabeled as a tool call.

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

## Provider binding adapter

Codex `thread.id` is stored only inside the common `ProviderBinding`; the live
route remains a separately minted Zeros `executionId`. Common resume and fork
commands call the adapter without exposing an arbitrary Codex RPC bridge to the
renderer. `thread/fork` returns a new opaque binding and no live execution.

The only Codex thread lifecycle notification projected into product state is an
exact-parent `thread/deleted`, translated to binding detachment. The adapter
deliberately ignores Codex archive/unarchive/close/name/pin as Zeros metadata,
and it does not send Zeros title/pin/archive/delete changes back to Codex.
Codex `gitInfo` remains available in the pinned harness response types but is
not reconciled into Zeros workspace or chat metadata.

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

The Codex harness itself does not define or own:

- Zeros conversation/execution identifiers, provider-binding persistence,
  database migrations, destination-conversation creation, archive/rename/pin
  synchronization, or product lifecycle policy;
- renderer capability RPC, Codex settings panels, marketplace/plugin/app UI,
  or SDK jobs;
- browser automation, browser leases, native views, CDP, or MCP browser
  servers; or
- Zeros-native skills, MCP, apps, plugins, and future cross-agent tool
  registries.

Those capabilities should be delivered in later Zeros-owned PRs, with this
harness acting only as the Codex transport adapter.
