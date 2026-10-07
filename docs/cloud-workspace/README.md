# Cloud workspaces

Zeros cloud execution uses **Boat**, an immutable saved **v2 Cloud Computer
source**, a qualified **v4 worker runtime pin**, and **actor protocol 2**.
Personal workspaces remain Local. Organization-owned Local workspaces use the
local engine; organization ownership alone never selects cloud execution.

The control plane owns authorization, lifecycle/allocation journals, one durable
command queue, receipts and normalized history. The Boat engine owns live
workspace ordering, native agents, Git, Files and Design. Desktop routes by the
exact `cloud://` workspace identity and retains confirmed views during refresh.
Electron main owns native access, receive-only replicas and the bounded cloud
transcript presentation cache. See [architecture](architecture.md).

Retired generations return terminal `cloud_workspace_v2_required` before new
execution authority or allocation. Authorized metadata, history, sharing,
management and deletion remain available. No automatic source conversion or
Local fallback occurs. Saved source/runtime pins and historical database/wire
schema versions remain compatibility contracts.

Repository implementation is separate from deployment and release qualification.
Cloud already operates in Alpha; this overhaul has not itself been qualified on
live Alpha or signed macOS. Updating desktop/control-plane source does not change
an existing VM's pin. See [qualification status](qualification-status.md) for
migration, publication, adoption and acceptance gates.

## Read first

- [Architecture](architecture.md): authority, identity and create/command paths.
- [Product contract](product-contract.md): ownership and user-visible behavior.
- [Engineering reference](engineering-reference.md): source map, Git and Local guards.
- [Qualification status](qualification-status.md): implementation versus release evidence.
- [Wake performance](wake-performance.md): readiness, preparation reuse and measurement.
- [Warm pool and reliability follow-ups](warm-pool.md): accounted prebooted capacity,
  VM durable outbox, outbound VM transport, one multiplexed client↔backend channel,
  incremental transcript feeds and Mac send outbox with acks.

## Behavior guides

| Area | Owning guides |
| --- | --- |
| Client routing, commands and access | [Client/runtime contract](client-runtime-contract.md), [relay capacity](relay-capacity.md), [native access acceptance](native-access-acceptance.md), [native preview acceptance](native-preview-acceptance.md) |
| Durable data and copies | [Data and sync](data-and-sync.md), [native checkpoint format](checkpoint-native-format.md) |
| Organization and account authority | [Organization setup](organization-setup.md), [Pro backend](pro-backend.md), [account Pro operations](account-pro-operations.md), [compute credits](compute-credits.md) |
| Cloud Computer | [Template builds](computer-template-builds.md), [template forks](template-forks.md), [template retention](computer-template-retention.md), [Computer tools](computer-tools.md), [environment/setup](computer-environment.md) |
| Native agents and customization | [Authentication/language tools](agent-authentication-and-language-tools.md), [MCP and skills](mcp-and-skills.md), [provider background work](provider-background-work.md) |
| Runtime and updates | [Runtime bundles](runtime-bundles.md), [live runtime updates](live-runtime-updates.md), [runtime lifecycle acceptance](runtime-lifecycle-acceptance.md), [runtime skew gate](runtime-skew-gate.md), [release worker retirement and cleanup](release-worker-qualification.md) |
| Operations | [Provider contract](provider-contract.md), [lifecycle diagnostics](lifecycle-diagnostics.md), [infrastructure and operations](infrastructure-and-operations.md), [database qualification](database-qualification.md) |
| Security and deployment seams | [Security](security.md), [enterprise/self-hosting](enterprise-and-self-hosting.md) |

## Documentation policy

Give each behavior one owning guide and link to it from other guides. Keep
schemas, authority, recovery, limits and acceptance procedures current with code.
Keep unfinished work explicitly proposed and live/platform qualification
explicitly unproven. Completed implementation roadmaps and dated audits belong
in Git history; their durable decisions belong in the guides above. Private
operational evidence, credentials and scratch vendor research stay outside public
docs. Code, tests, migrations and deployment manifests remain authoritative.
