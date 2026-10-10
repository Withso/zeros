# Cloud workspace architecture

## System boundaries

```text
Desktop: exact cloud:// selection, retained views, bounded transcript cache
  | account HTTP: history, commands, lifecycle, admissions
  v
Control plane: organization/actor/device authority
  immutable Computer source + runtime generation pins; allocation journal
  legacy queue/journal OR boot credential vault + compact mirrored history
  | verified direct WSS or authenticated relay; engine background HTTP
  v
Boat VM: protected bootstrap -> pinned engine + existing SQLite
  zeros-engine (10003): engine, real checkout, providers, tools, terminals and capture
  one trust domain: agents can read engine data and other-conversation state
  one shared workload cgroup; original process groups; actor-admitted PTY/preview/capture
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

## Resource layout

The root broker places all agents, tools, terminals/SSH/LSP and capture in one
shared workload cgroup before exec. Engine/control processes use a sibling engine
cgroup. Both belong to the common engine-runtime parent, which protects the
separate `/host` sibling; `/host` limits are unchanged. In
`memoryBudget.source=nominal`, parent bounds scale at each boot to the VM allocation:

- Parent `cpu.max` is `admitted SKU CPUs * 100000` with period `100000`.
  The raw effective CPU count comes from the nearest readable
  `cpuset.cpus.effective` in the engine's own cgroup and exact ancestors;
  it never falls back to os.cpus(). A wider raw cpuset does not enlarge the
  admitted parent budget.
- Parent `memory.max` starts at nominal SKU memory minus 1 GiB of host reserve.
  Nominal memory is the configured/admitted allocation, such as 8192 MiB for the
  default SKU. The effective limit is
  `min(nominal SKU memory - 1 GiB, measured MemTotal - /host memory limit)`.
  It must not exceed that measured ceiling in nominal mode. The report records
  nominal memory, measured MemTotal, `/host` memory limit and effective cap,
  including any reduction below the nominal budget.
- Parent `pids.max=4096` and `memory.oom.group=1` remain unchanged.

Admission keeps the existing SKU sufficiency floor: normal kernel overhead is
accepted when measured MemTotal is below nominal memory and still passes that
floor. Nominal memory is not a new minimum MemTotal requirement. Admission and
readers enforce strict per-mode equality: nominal CPU must equal the admitted SKU
CPU count, and nominal memory must equal the SKU-derived budget with its measured
cap and recorded reduction.

Cgroup v2 migration checks destination and common-ancestor write access, not the
target UID. `/host` stays outside the delegated parent and every root process
stays outside engine-runtime, with no root helper inside it. The root broker
retains control from outside the tree; UID 0 alone is not a migration barrier.

The parent enables only the CPU controller for its children. The engine cgroup
stays uncapped at its leaf (`cpu.max=max 100000`); inherited parent bounds remain.
The shared workload has
`cpu.max=round(0.75 * min(raw cpuset CPUs, actual ancestor quota in CPUs) * 100000)`
with period `100000`. Convert finite ancestor `cpu.max` values to CPUs with
`quota / period`; use the tightest actual quota, including the newly set parent.
Both children use `cpu.weight=100`. There are no new per-leaf memory/pids limits
and no per-launch resource groups.

These CPU examples assume admitted SKU CPUs, raw cpuset CPUs and actual ancestor
quota coincide:

| Admitted SKU CPUs | Workload `cpu.max` | Parent `cpu.max` |
| --- | --- | --- |
| 1 | 75000 100000 | 100000 100000 |
| 2 | 150000 100000 | 200000 100000 |
| 4 | 300000 100000 | 400000 100000 |
| 8 | 600000 100000 | 800000 100000 |
| 16 | 1200000 100000 | 1600000 100000 |

When the raw cpuset is wider than the admitted SKU, the parent still governs the
workload cap:

| Admitted SKU CPUs | Raw cpuset CPUs | Actual ancestor quota (CPUs) | Parent `cpu.max` | Workload `cpu.max` |
| --- | --- | --- | --- | --- |
| 4 | 8 | 4 | 400000 100000 | 300000 100000 |

The table gives the nominal parent budget before measured cap.

| Nominal SKU memory | Nominal parent budget (bytes) |
| --- | --- |
| 4 GiB | 3221225472 |
| 8 GiB | 7516192768 |
| 16 GiB | 16106127360 |

The default 4 vCPU / 8 GiB SKU matches main's nominal constants: parent CPU
`400000 100000`, memory `7516192768`, pids `4096` and OOM group `1`; the measured
ceiling may reduce the memory limit and that reduction is reported. The measured
memory cap applies only in nominal mode.

With unavailable or malformed required inputs, the broker selects
`memoryBudget.source=fallback` and the parent falls back to main's exact constants.
The fallback parent is exactly `cpu.max=400000 100000`, `memory.max=7516192768`,
`pids.max=4096`, `memory.oom.group=1` (4 CPUs and 7 GiB (7516192768 bytes)). This
reproduces main byte-for-byte: fallback applies no MemTotal or `/host` cap, even
when some raw measurements are available. The workload cap stays uncapped with a
closed diagnostic; fallback requires the matching workload-cap skip diagnostic.
Use the report's root-published `memoryBudget.source`, assigned by the broker,
as the only mode indicator. Record raw measurements honestly; never infer the mode
from them. Boot does not fail for unavailable measurements and shared custody
remains mandatory. Archived v1 reports remain
byte-for-byte unchanged. These bounds do not imply memory/pids resource
qualification.

Idle inspects the complete engine-runtime census, including the engine leaf and
new siblings, exempting only exact infrastructure births and the original C3
quiet populated-shell exception. Conversation Stop proves its original process
group only. VM drain closes launches and completes checkpoint/seal before the
outside root broker kills the whole tree and records final `populated=0`.

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

Legacy cloud sends stable command identities to the CP queue and journals event
batches there. Activated `boot-owner-v1` accepts them in the VM's WAL/FULL queue,
commits claims before native handoff, and serves local live/reconnect replay.
The CP asynchronously mirrors compact controls, final conversation records and
receipts for stopped reads. No mirror row is another dispatcher. Both modes
preserve uncertain outcomes; an ACK never proves exactly-once external effects.
See [queue and canonical history](data-and-sync.md#negotiated-local-queue-and-compact-history).

Native agents use the shared Local gateway/adapters after cloud admission.
Legacy uses an actor-bound grant and real execution lease. Boot mode captures
the owner's background-published selection plus independently confirmed actor
authority, then enters an engine-owned native session lifetime. Warm turns retain only
the exact eligible conversation scope. The factory pins cwd, model/key, private
HOME and MCP/skill snapshots. Cloud-only
authority checks stay outside the adapters' ordinary tool/transcript path;
refusal never bypasses admission or dispatches through the live bridge.
See [native configuration and restrictions](agent-authentication-and-language-tools.md#native-execution-and-compatibility).

Authorized history can be read without a running VM. Desktop's bounded durable
cache stores a sanitized confirmed latest window/revision and tail message ID;
it is presentation state, not command or execution authority. Native streaming
and confirmed history supersede provisional Cached rows. The current history
API supports bounded tail/older windows; a forward feed-offset API remains a
follow-up. See [client/runtime contract](client-runtime-contract.md).

## Connections and native services

Step 1 direct transport publishes a verified Boat WSS target with a one-use
actor grant. The renderer verifies exact activated boot readiness before work.
Transport failure can obtain a fresh same-boot CP relay admission; it cannot
replay work or downgrade on authority refusal. Existing SSH remains a separately
selected transport. `CloudRuntimeBridgeRelay` still bounds/revalidates relayed
connections. Engine registration, authority renewal, credential refresh and
mirroring continue in background HTTP. VM-verified signed tickets and a resident
multiplexed uplink remain follow-ups. See
[portable ingress](client-runtime-contract.md#portable-runtime-ingress).

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
| Lifecycle, policy, legacy queue, compact history and provider operations | `apps/control-plane/src/cloud-workspaces/` |
| Shared wire schemas, crypto and redaction | `packages/protocol/` |
| Live workspace, local queue/outbox, native agents, Files/Git/Design and publication | `apps/desktop/src/engine/` |
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
publication → compatible desktop → explicit/next-wake adoption and negotiated
activation. This overhaul
has repository evidence, not new live Alpha or signed macOS qualification. Flat
OCI publication and the shared Dev image kit remain separate from the qualified
v4 workspace artifact. The opt-in v3 release-worker promotion lane is retired;
default-disabled releases, historical receipts and cleanup remain available. See
[qualification status](qualification-status.md).

The [follow-up design](warm-pool.md) owns accounted warm capacity, broader
VM inbox/restore recovery, resident outbound transport, a multiplexed backend device
stream, incremental durable transcript feeds and a Mac composer outbox with
explicit acknowledgements. Each must preserve the existing queue, identity,
uncertain-outcome, funding and revocation contracts.
