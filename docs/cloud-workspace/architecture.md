# Cloud workspace architecture

## System boundaries

```text
Desktop: exact cloud:// selection, retained views, bounded transcript cache
  | account HTTP: history, commands, lifecycle, admissions
  v
Control plane: organization/actor/device authority
  immutable Computer source + runtime generation pins; allocation journal
  one durable command queue + receipts; ordered events + normalized history
  | current: authenticated bridge relay + engine outbound HTTP
  v
Boat VM: protected bootstrap -> pinned engine + existing SQLite
  contained worker: repository, native provider CLIs, scoped Git operations
  checked engine-write publication; separately admitted PTY/preview/capture
```

The control plane authorizes work and persists its delivery/result evidence. The
engine sequences live workspace operations. Provider resources are replaceable
execution capacity; they do not replace the stable workspace ID, durable record
or configured Git remote. The renderer presents these authorities through one
workspace runtime router; status UI does not become another lifecycle controller.

Cloud execution admits only generations with a valid saved v2 Cloud Computer
source and a complete v4 worker pin, using actor protocol 2. Unsupported saved
generations return `cloud_workspace_v2_required` before execution admission;
setup and automatic recovery treat that refusal as terminal. Catalog metadata,
authorized history, sharing and explicit resource deletion remain available.
Existing sources and pins are retained without selecting today's template or
converting historical workspaces. See [Computer Environment](computer-environment.md).
Local and organization-owned local workspaces retain their normal local paths.

## Identity and placement boundary

Cloud keys encode organization and workspace UUIDs. Device SQLite owns Local
paths and released Local identity aliases; the control plane owns cloud rows,
generations, actor/device grants, billing epochs and immutable source/runtime
pins. Never infer placement from organization membership, a provider resource ID
or a VM path. Personal Local and organization Local run the same local engine
operations without cloud admission, history or cloud-only credentials.

A Local↔cloud copy creates a fresh destination UUID and immutable provenance.
The source remains authoritative for itself. Receive-only replicas belong to one
user/device/workspace; paths remain device-local, and replica edits never upload
or change cloud authority. See [data and sync](data-and-sync.md).

## Create and wake

1. Desktop publishes an account/org/idempotency-scoped pending create immediately.
   A confirmed server UUID replaces that placeholder atomically. A rejected or
   late reply can remove only its own pending row.
2. The control plane validates current membership, roles, funding and the exact
   ready v2 Computer source. It records immutable generation inputs, runtime
   pin and allocation/setup intent before provider I/O.
3. Boat fork/resume runs the fixed image-owned setup path. Setup claims, retries
   and readiness remain fenced by workspace, generation, lease and execution
   fence. A retry deadline wakes the existing worker scheduler; periodic
   maintenance remains independent.
4. Required ownership recovery, runtime verification, lifecycle handlers, fresh
   engine registration and initial durable sync complete before readiness.
   Optional Design capture starts afterward and cannot delay readiness.
5. Desktop consumes the exact ready catalog event and obtains current runtime
   admission. A two-second fallback covers missed events. Account, generation
   and Stop/restart-operation guards reject stale readiness.

Ordinary wake retains the accepted runtime pin. Qualified same-base updates use
the existing fenced runtime transition, not today's template as an implicit
replacement. Preparation reuse can avoid repeated clone/configure/hooks only
under its validated identity; launch authority, attestation and registration
remain fresh. See [wake performance](wake-performance.md),
[template forks](template-forks.md) and [runtime updates](live-runtime-updates.md).

## Commands and durable history

Desktop sends a stable command identity to the control plane's existing durable
queue. The engine receives admitted work and reports ordered event batches;
receipts describe accepted/running/terminal/uncertain outcomes. A succeeded
receipt still requires transcript catch-up before presentation settles. An
ambiguous dispatch or missing terminal event cannot fabricate success or justify
automatically replaying a native turn. Delivery ACKs alone cannot establish
exactly-once external tool effects.

Authorized history can be read without a running VM. Desktop's bounded durable
cache stores a sanitized confirmed latest window/revision and tail message ID;
it is presentation state, not command or execution authority. Native streaming
and confirmed history supersede provisional Cached rows. The current history
API supports bounded tail/older windows; a forward feed-offset API remains a
follow-up. See [client/runtime contract](client-runtime-contract.md).

## Connections and native services

`CloudRuntimeBridgeRelay` currently carries authenticated frames through the
provider-mediated engine connection for each desktop attachment. It bounds
connections, bytes and admissions and rechecks actor/device/generation authority.
The engine also sends outbound registration, heartbeats and durable HTTP
requests. This is the current topology; a resident VM outbound stream and one
multiplexed client↔backend channel remain separate proposed changes.

The exact-execution connection registry can retain a cloud peer beside the Local
sidecar used by a Local terminal or replica. Passive stopped-workspace reads do
not wake or admit an engine. Hidden surfaces are inert and bounded; live usage
sampling requires the current connected cloud execution.

Electron main owns SSH/Terminal, localhost forwarding, preview headers, device
keys and revocation. Renderer IPC returns bearer-free receipts/URLs. Previews are
scoped to the exact authorized Browser frame; tunnels bind loopback. Native
editor launch remains hidden pending multi-connection SSH qualification. See
[native access](native-access-acceptance.md) and
[native preview](native-preview-acceptance.md).

## Repository ownership

| Responsibility | Source boundary |
| --- | --- |
| Lifecycle, policy, durable queue/history, provider operations | `apps/control-plane/src/cloud-workspaces/` |
| Shared wire schemas, crypto and redaction | `packages/protocol/` |
| Live workspace, native agents, Files/Git/Design and publication | `apps/desktop/src/engine/` |
| Exact workspace routing and retained views | `apps/desktop/src/renderer/platform/bridge/`, `apps/desktop/src/renderer/state/` |
| Native access, transcript cache and replica processes | `apps/desktop/electron/` |
| Protected runtime builds and qualification | `scripts/cloud-workspace-validation/`, release workflows |
| Browser authentication and management seams | `apps/web/` |

Keep provider credentials and provisioning outside renderer/shared code. Add a
new package or app only when it has a real stable multi-consumer or independent
build/deployment boundary. See [engineering reference](engineering-reference.md).

## Failure and rollout boundaries

Intent is durable before dispatch; provider timeouts retain unknown outcomes for
reconciliation. Results recheck authority, desired state and the exact generation
before publication. Expiry/revocation retires runtime, device and service grants.
Storage erasure requires matching terminal evidence; DELETE acceptance and a 404
do not prove physical deletion. Local selection and other exact workspace views
retain their own confirmed state throughout these failures.

Release order is forward migration → control plane → qualified runtime/base
publication → compatible explicit/next-wake pin adoption → desktop. This overhaul
has repository evidence, not new live Alpha or signed macOS qualification. Flat
OCI publication and the shared Dev image kit remain separate from the qualified
v4 workspace artifact. The opt-in v3 release-worker promotion lane is retired;
default-disabled releases, historical receipts and cleanup remain available. See
[qualification status](qualification-status.md).

The [follow-up design](warm-pool.md) owns accounted warm capacity, a persisted
VM event outbox/inbox, resident outbound transport, a multiplexed backend device
stream, incremental durable transcript feeds and a Mac composer outbox with
explicit acknowledgements. Each must preserve the existing queue, identity,
uncertain-outcome, funding and revocation contracts.
