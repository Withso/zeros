# Agent harness capability boundary

Zeros is the platform. Codex, Claude, Cursor, and future providers are
replaceable harnesses. Zeros owns product semantics, conversation and execution
identity, persistence, authorization, security boundaries, UI, and the shared
wire protocol. A harness keeps its native process and protocol/SDK behavior
behind its adapter.

This boundary is incremental: it preserves every qualified native capability
the current harnesses already provide. It does not require a Zeros-owned agent
harness, and it does not reduce all providers to their lowest common feature
set.

## Engine contract

Required lifecycle operations (`initialize`, create, resume, prompt, cancel,
list resumable sessions, and dispose) remain on `AgentAdapter`. Optional product
behavior is consumed through the narrow `AgentCapabilityPorts` domains:

- conversation;
- native browser session;
- background work;
- turn control;
- live runtime configuration;
- permission and question interaction;
- account access; and
- isolated text generation.

`resolveAgentCapabilityPorts(...)` is the migration seam for existing flat
adapter methods. An adapter's explicit domain port wins; otherwise the resolver
binds its legacy method behind the same narrow interface. Engine product call
sites must use the resolved ports. Provider-specific request/response types stay
inside the provider adapter and must not leak through a domain interface.

There is deliberately no `execute(method, params)` port and no renderer-facing
capability-request bridge. A new product feature adds a domain operation with
Zeros-owned input, output, authorization, timeout, cancellation, redaction, and
error semantics. Its adapter may then translate that operation to each
provider's native protocol.

## Capability advertisement

`InitializeResponse.agentCapabilities.domains` is descriptive data, not an RPC
catalog. Each operation is one of:

- `harness-native`: implemented with the provider's supported protocol or SDK
  behind its adapter;
- `zeros-native`: implemented by the platform independently of a harness; or
- `unavailable`: no implementation claim, with a reason.

An implemented capability may be `runtime-dependent` when authoritative data
cannot exist before a provider runtime starts. Requirements such as a durable
provider binding, live session, active turn, or authentication are carried
separately. Legacy `loadSession` and `steering` booleans are derived from the
same engine-owned snapshot for wire compatibility.

Method presence is not enough to claim support. No-op methods are forbidden:
an adapter with no host-answerable permission or question channel omits that
operation. Generated upstream types likewise prove only protocol availability;
they do not prove a Zeros product implementation.

## Qualified baseline

Re-verified 2026-08-21 against Claude Agent SDK 0.3.238, Codex 0.149.0, and
Cursor SDK 1.0.28. `H` means harness-native, `H*` means harness-native but the
cold model catalog requires a live runtime, `Z` means Zeros-native and shared
across harnesses, and `—` means unavailable through the current adapter.

| Zeros product capability               | Codex | Claude | Cursor |
| -------------------------------------- | ----: | -----: | -----: |
| Resume an opaque provider binding      |     H |      H |      H |
| Fork an opaque provider binding        |     H |      — |      — |
| Fork a chat with transcript handoff    |     Z |      Z |      Z |
| Official native browser session        |     H |      H |      — |
| Mid-turn steering                      |     H |      H |      — |
| Live mode switch                       |     H |      H |      H |
| Context compaction                     |     H |      H |      — |
| Stop one provider background task      |     H |      H |      — |
| Native working-tree review command     |     H |      — |      — |
| Host-answerable permission             |     H |      H |      — |
| Host-answerable question               |     H |      H |      — |
| Live model catalog                     |   H\* |    H\* |    H\* |
| Apply model/config on the live session |     H |      H |      H |
| Read signed-in account details         |     H |      H |      — |
| Read configuration-source provenance   |     H |      H |      H |
| Read account quota/reset windows       |     H |      — |      — |
| Validate a candidate API key           |     — |      — |      H |
| Isolated text generation               |     H |      H |      H |

The table describes implemented product behavior, not every capability the
upstream vendor may expose. Codex targeted Stop is implemented through the
background-work domain. Its separate `clean` request remains intentionally
unexposed because the 0.149 contract stops every running terminal; Zeros has no
bulk-stop intent in the shared per-row task card.

### Upgrade-audit observations

- Codex 0.149 adds 23 client requests and five notifications to the generated
  surface. They remain generated-only/forwarded until a narrow product domain
  adopts them; see the exact compatibility manifest.
- Claude 0.3.238 exports `listSessions`, `getSessionMessages`, and
  `forkSession`. The [official session-browser cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-05-building-a-session-browser)
  confirms the same TypeScript APIs. Zeros' Claude adapter still returns an
  empty discovery list and has no fork port, so those are real follow-up gaps,
  not Phase 1 support claims.
- Cursor 1.0.28 remains the latest qualified pin. Its
  [official SDK update](https://cursor.com/changelog/sdk-updates-jun-2026)
  documents durable resume, custom tools, stores, and auto-review. Auto-review
  is a classifier gate, not a host-answerable built-in-tool permission callback;
  the current adapter therefore correctly omits permission/question response
  ports. The Cursor IDE's browser feature is likewise not evidence of a native
  browser contract in the public SDK adapter.

### Consolidated provider-parity qualification (2026-08-23)

- The curated Zeros model catalog remains the presentation authority. Live
  provider discovery is an overlay for availability and runtime capabilities;
  Cursor aliases, descriptions, parameters, variants, default parameters,
  effort, and Fast metadata do not become provider-owned picker structure.
  Router is selectable only when the live local runtime explicitly says so.
- Configuration provenance is a narrow, read-only configuration-domain
  operation. It reports privacy-preserving source-layer labels and suppression,
  never native paths, raw values, plugins, commands, or credentials. Protected
  territory remains authoritative. It is deliberately not presented in Models
  settings until Zeros can show confirmed sources, precedence, and safe
  navigation instead of ambiguous static labels.
- Codex quota is a narrow account-domain read plus a local-desktop notification.
  It is not conversation state and is never relayed. Sparse updates retain the
  last authoritative values; logout emits an explicit null invalidation.
- Cursor native callbacks are attached inside its contained Node host, ordered
  with backpressure, deduplicated against stream mirrors, and fenced on cancel.
  Stable engine turn identity becomes the provider idempotency key. Provider
  billing is best-effort and time-bounded so telemetry cannot block a turn.
- Claude's pinned terminal-reason union is mapped exhaustively. Cursor
  `createPlan`/`updateTodos` and Codex aggregate plan updates do not create a
  native-provider checklist in Zeros. A shared persistent task model remains a
  separate product decision.

## Adding a capability

Before a new capability is called complete:

1. Define the Zeros product semantics and authority owner.
2. Add or extend one narrow engine domain port; never add a generic vendor RPC.
3. Implement provider adapters independently, retaining their native protocol.
4. Derive an honest descriptor, including unavailable and runtime-dependent
   states.
5. Add contract tests for support, absence, correlation, cancellation,
   lifecycle settlement, and cross-session isolation.
6. Add renderer and persistence behavior only if the product feature needs it.
7. Update this baseline and the provider's protocol-coverage ledger.

Serialized compatibility remains additive. Existing provider bindings and
conversation records are not renamed or rewritten merely to match an upstream
provider vocabulary.
