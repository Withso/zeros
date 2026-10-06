# Live updates for running cloud workspaces

Decision proposal, 2026-10-06. Internal Alpha only. Extends
[HU's transition design](runtime-hot-update.md); does not enable live updates or
claim measured process survival. Repository baseline: `41e84ffe`.

## Decision

**Stage on qualification; activate at a safe point without stopping user
processes.** Keep one resident workload host outside the replaceable engine's
process group, cgroup and PID/mount namespace lifetime. It owns terminal masters,
terminal state and user jobs. Replace the engine, retain the VM and workload
host, and reuse HU's generation transfer, enrollment, rollback and crash journal.
Do not implement a second transition owner.

“Immediate” means eligible running workspaces start staging without waiting for
sleep or user inactivity, and activate after current engine-owned work drains.
An in-flight agent turn finishes on its existing runtime; subsequent prompts
wait in the durable queue. We cannot promise an immediate code change inside an
arbitrarily long turn while also promising never to interrupt it. Stage age,
drain time and handoff gap must be measured separately.

Target **≤2 seconds** from last authenticated source response to first
authenticated target response with ordered replay, with no update banner on
successful handoffs. This is an acceptance target, not a measured capability.
The current attester and enrollment path cannot yet justify it. Longer failures
use existing 10-second pending / 45-second error presentation; do not conceal
outages or remove those thresholds.

## Research: what is established

VERIFIED means directly read documentation, source or local artifacts; it does
not mean a vendor's live update was exercised. INFERENCE is an architectural
conclusion. UNCONFIRMED means the inspected evidence does not establish it.
No provider operation or process restart was performed.

### Conductor

- **VERIFIED, local artifacts:** this sandbox has two versioned
  `/conductor-infra/<sha>` trees. `/conductor/{bin,worker,manifest.json}` point to
  the same tree. Its manifest identifies runner version 22, built
  `2026-10-06T03:20:53.208Z`. Read-only symlink/manifest inspection establishes
  installation layout, not when or why selection changed.
- **VERIFIED, shipped code/binary:** the host binary contains PTY IPC, TCP tunnel
  and frontend-supervision symbols, including a restart-on-frontend-exit path.
  The worker emits `sandboxRestart` for recovered sessions at startup
  (`/conductor/worker/index.js:253409`). Its idle monitor defaults to five minutes
  and requests sleep at 4h55m; the server may defer that request
  (`index.js:248070`). These are configurable defaults, not a verified enforced
  lifetime in this VM. No process arguments or environments were inspected.
- **VERIFIED, public contract:** a rebuilt Cloud Computer changes the environment
  of new workspaces; existing workspaces retain their environment.
  [Cloud documentation](https://www.conductor.build/docs/cloud).
  The October 2 changelog describes update-restart confirmation when a run
  script or unsent prompt exists; it does not identify a live cloud worker swap.
  [Changelog](https://www.conductor.build/changelog).
- **INFERENCE:** separating PTYs/tunnels from the frontend permits frontend
  replacement without making that frontend the shell's lifetime owner.
  Versioned payloads permit staged selection. Neither proves agent-turn survival.
- **UNCONFIRMED:** automatic qualification push into busy VMs, host-binary live
  replacement, preserved provider sessions during replacement, or a bounded
  reconnect gap. The prior research reports named in the task were not present
  in this checkout; their supplied summary agrees with these limited findings.
  No restart experiment was attempted on the workspace running this agent.

### Other systems and applicable patterns

| System | Verified behavior and limit of the evidence | Implication for Zeros |
| --- | --- | --- |
| VS Code Server | The client installs/updates its server on connection. Server installation paths include quality and commit. [FAQ](https://code.visualstudio.com/docs/remote/faq#_can-i-install-vs-code-server-manually), [upstream paths](https://github.com/microsoft/vscode/blob/main/cli/src/tunnels/paths.rs). This is not proof of cross-version live PTY migration. | Immutable side-by-side payloads solve installation, not process ownership. |
| GitHub Codespaces | Configuration changes use container rebuild; `/workspaces` survives. [Rebuild contract](https://docs.github.com/en/codespaces/developing-in-a-codespace/rebuilding-the-container-in-a-codespace). No busy-agent hot replacement guarantee is established there. | File persistence is insufficient evidence of shell survival. |
| Gitpod Classic | Stopping backs up `/workspace`; restarting restores it into a new container. IDE choice applies on workspace start. [Lifecycle](https://www.gitpod.io/docs/classic/user/configure/workspaces/workspace-lifecycle), [IDE example](https://www.gitpod.io/docs/classic/user/references/ides-and-editors/rider). | This is a restart model; do not present it as live replacement. |
| Coder | Workspace update stops a running workspace and starts it with the updated template; optional automatic update applies at start. [Workspace management](https://coder.com/docs/user-guides/workspace-management). Transparent in-place **agent self-update** preserving all sessions is unconfirmed by the inspected sources. | Do not assume self-update implies session preservation. |
| Daytona | Named sessions support asynchronous long-running commands and explicit cleanup. [Process execution](https://www.daytona.io/docs/en/process-code-execution/). Survival across daemon replacement is unconfirmed. | Stable command/session ownership is useful, but requires a separate restart test. |
| E2B | `envd` is a versioned in-sandbox daemon. The SDK selects behavior/fallbacks by daemon version, including file upload and watcher support. [Daemon contract](https://github.com/e2b-dev/infra/blob/main/packages/envd/README.md), [SDK](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/filesystem/index.ts). Live daemon replacement is unconfirmed. | Negotiate capabilities against the runtime actually serving the request. |
| Modal | Memory snapshots clone filesystem and process state into another sandbox; documented restrictions include active exec and exec-launched background processes. [Snapshots](https://modal.com/docs/guide/sandbox-snapshots). | Snapshot recovery neither replaces old code in memory nor proves unrestricted live migration. |
| Fly Machines | A successful update of a running Machine reboots it. [Machines API](https://fly.io/docs/machines/api/machines-resource/#update-a-machine). | VM update is outside our uninterrupted-work contract. |
| Replit | Its engineering recap reports substantially fewer container restarts and less loss of program state. It does not specify a live runtime handoff contract. [2023 recap](https://replit.com/blog/replit-recap-2023). | Reduced restart frequency is not a zero-interruption update guarantee. |

Unix descriptor handoff (`SCM_RIGHTS`) or inherited descriptors can preserve
kernel endpoints, but application buffers, TLS/SSH state and ownership still
need a protocol. [systemd's FD store](https://systemd.io/FILE_DESCRIPTOR_STORE/)
retains descriptors across service restarts; it does not serialize a Node heap
or automatically preserve children killed with their service. [Envoy hot
restart](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/hot_restart)
shares listening sockets but drains existing connections in the old process;
it does not transfer them. [nginx binary upgrade](https://nginx.org/en/docs/control.html#upgrade)
runs old and new masters/workers concurrently before retiring old workers.
**Inference:** a resident workload host is simpler than FD transplantation for
Zeros; no external source code is imported by this design.

## Handoff and preservation contract

1. **Offer and stage.** Qualification completion *and* release confirmation
   schedule bounded work through the existing worker notification mechanism.
   Reconcile missed notifications from durable eligibility; never depend on a
   push being delivered. Select by exact organization, workspace, source
   generation, base/controller compatibility and delegated credential kinds.
   Stage through HU's verified installer beside the active tree. Keep source
   authority, pointers and processes unchanged. Limit download concurrency,
   disk use and staging retries; superseded offers cannot activate.
2. **Drain and reserve.** Close new claims at the shared transition lock, allow
   dispatched work to finish, and queue subsequent prompts with their existing
   identities/paused states. Establish a synchronous engine admission fence for
   mutations/process starts, then recheck after every await. Unknown activity is
   busy. Ordinary terminal I/O need not wait once it has resident ownership;
   never treat an engine-owned PTY as resident based only on a PID.
3. **Prepare while source serves.** Verify target bytes and compatibility. An
   isolated candidate preflight must not take the source lifetime lock, publish
   the active descriptor, consume source proofs, open writable SQLite or acquire
   provider authority. This requires a separately qualified attestation change.
4. **Handoff.** Finish Git/Design mutations and durable writes, close the source
   SQLite connection, fence the source engine, retain resident workloads, and
   invoke HU's selection/enrollment protocol. Exactly one engine may write
   state or admit work. The resident host attaches only the freshly enrolled
   exact engine under a monotonic fence; old sockets and stale capabilities
   cannot write, resize, kill, attach, or acquire credentials.
5. **Prove and resume.** Publish a fresh boot/session/descriptor-bound proof and
   fresh engine UUID, transfer authority using HU, check authenticated readiness
   and record synchronization, reconnect every device and replay in order.
   Revalidate queued work's actor, role, model and delegation before claim.
6. **Recover.** A target that fails health is fenced before a fresh enrollment
   of the saved verified source. Reverse HU's transfer if necessary. Do not
   replay dispatched/uncertain external effects or restore the checkout from a
   checkpoint. The resident host continues existing authorized user jobs.
   Unknown authority closes admission; a network partition has no finite
   availability guarantee.

| Surface | Required behavior |
| --- | --- |
| Terminal / Run / user dev server | Resident host owns PTY masters, bounded screen/scrollback, ordered output, exit status, cwd/session registry and descendants. New engine attaches using stable session IDs and a snapshot cursor. Input acknowledgements prevent replaying keystrokes. Explicit close and actual workspace stop still retire descendants. Engine disconnect alone does not. |
| Agent turns / MCP / provider subprocesses | First release drains turns, pending tools, approvals/questions, background leases and provider processes; do not kill or adopt an active SDK connection. Product MCP gateways restart between turns with fresh grants. A later resident execution host could preserve active turns, but opaque SDK state and lease renewal make that a separate design, not this slice. |
| SSH / SFTP / tunnels | Current native service grants bind generation, engine and authority epoch; engine retirement invalidates them. Leave active sessions as blockers until a resident transport plus allocation-scoped, independently renewable authority is designed and reviewed. Never merely stop checking grants. [Current contract](client-runtime-contract.md#native-human-ssh-sftp-and-port-streams). |
| Previews / watchers / language services | A resident dev server keeps its PID and listener. Existing engine-owned relay connections still require draining or resident relay ownership. Recreate restartable file/Git watchers and reconcile authoritative snapshots so edits during the gap are discovered. Active preview streams block until continuity is qualified. |
| Git / Design | Finish non-idempotent mutations, merge/rebase operations and Design checked transactions before handoff. Keep checkout/index/refs/Design IDs, source and open operation state on disk. Do not rerun setup, alter a user's working tree or mistake file survival for completed transaction survival. |
| SQLite / native histories | Flush/close the old writer before the new writer opens. Qualify forward **and rollback** readability of schema and provider histories for the exact runtime pair; only additive compatible changes during the rollback window. No concurrent writers or automatic destructive migration. |
| Credentials / containment | Resident host gets only bounded operation material, never provider administration credentials. Preserve separate workload containment and revoke operation grants normally. Update proofs attest resident controller/workload-host identity separately from engine identity; new engine bytes cannot stand in for old host bytes. Never change protected base bytes under the same compatibility ID. |
| Multiple devices | One workspace transition and queue; preserve stable `cloud://` identity, input ownership and output cursors. Discard late source events by engine/epoch. Exact-key snapshots remain visible; switching owner/placement cannot retarget a pending attachment or update. |

### Existing running workspaces

The current [PTY host](../../apps/desktop/src/engine/pty/pty-host.cjs#L294)
kills shells on stdin close; [engine stop](../../apps/desktop/src/engine/zeros-engine.ts#L3188)
kills terminals and clears their registry; the
[supervisor](../../scripts/cloud-workspace-validation/sandbox/cloud-worker-supervisor.mjs#L355)
retires engine/setup scopes. Removing those kills alone leaves namespace,
credential and orphan-cleanup failures. Existing PTY masters/state cannot be
retroactively transferred by installing new engine code.

Therefore legacy busy workspaces keep working on their old runtime until a
non-destructive migration point. HU's initial quiet host migration remains
necessary. Freshly resident-owned terminals can survive later engine updates.
Do not advertise immediate uninterrupted activation for legacy PTYs, active
provider turns or SSH until their respective ownership migrations are qualified.
The skew contract below is required while any such workspace remains pinned.

## Version-skew release gate

**N is the proposed qualified runtime; N−1 is the previous qualified runtime for
the same base/credential profile, not the preceding Git commit or protocol
integer.** Current control plane and desktop must preserve all previously
supported core operations with both. New features require an advertised
runtime capability or a tested fallback; lack of support must be rejected before
durable dispatch, never converted into `command_dispatch_rejected` mid-turn.
Handshake range equality alone is insufficient: the existing
[protocol check](../../scripts/check-protocol-version.mjs#L2) is advisory.

N−1 is a minimum. Do not drop a still-running older qualified cohort just
because another runtime was published. Retire support only after allocation
inventory confirms no running cohort needs it (and queued/stopped admission has
a qualified migration path). Revocation remains authoritative, with an explicit
error when no safe runtime exists; compatibility cannot resurrect revoked code.

CI must use immutable manifest/source/digest-pinned released fixtures or bundles,
not two copies of current schemas. Exercise current desktop ↔ N−1 engine ↔
current control plane and previous desktop ↔ N engine ↔ current control plane:
handshake/capabilities, ordinary prompt + Stop/approval + queued claim/settle,
terminal attach/input/snapshot, Files/Git/Design creation, record/event replay,
service admission and registration/credential renewal. Include strict old
parsers, optional/missing fields and capability-gated new commands. An intentional
negative fixture must make the gate fail. Store no live credentials in fixtures.

Wire this as a **required** compatibility/release-qualification gate before
desktop/control-plane publication; neither successful N qualification nor an
advisory protocol bump may bypass it. Roll-forward and rollback data-format
tests are separate. Local tests with frozen schemas can be a first slice but
must not be represented as full released-binary qualification. The supplied old
runtime's source commit is absent from this shallow checkout; its exact verified
artifact and the preceding desktop fixture need orchestrator confirmation.

## Ownership and PR slices

| Slice | Owner / boundary | Evidence before enabling |
| --- | --- | --- |
| LU-0: this decision | LU; separate doc, no edits to HU's design | Sources and exact limitations above. |
| LU-1: skew gate | LU; frozen contracts, compatibility harness and required CI integration | Deliberately incompatible request fails; both placements and released N/N−1 matrix pass. Baseline artifact/provenance must be agreed first. CI changes require owner merge. |
| LU-2: resident workload host | LU; new host/engine adapter, terminal registry/mirror ownership and packaging | Real shell plus detached dev server keep PID/state/output across old-engine exit, target attach and rollback; stale engine/refused auth, bounded buffers, explicit close, stop and host-crash tests. |
| LU-3: safe-point handoff | LU engine admission/drain; HU supervisor protocol, final decision and enrollment | No admitted mutation/claim crosses fence; source/candidate race, pending approval, drain failure, SQLite close/reopen and rollback tests. |
| LU-4: qualification-driven staging | LU trigger/staging integration; HU transition APIs; PERF notification worker | Busy workspace stages without pointer/process change; duplicate/lost push, supersession, revocation and source-generation races. |
| LU-5: Alpha acceptance | LU workload-survival and latency assertions compose with HU's runner | Two clients, active PTY/server, queued sends, failed target health, fresh proof/UUID, same allocation/boot, cleanup and measured ≤2s successful gap. |
| HU existing slices | HU owns 0135, retained allocation/compute fencing, transition enrollment, journal reconciliation, quiet fallback and IW2 queue integration | LU consumes these; does not edit their files/protocol without agreement through the orchestrator. |

**Required coordination before LU-2/3 integration:** agree a separate resident
workload scope and credential/revocation boundary with HU; whether the unchanged
v4-5 base can attest that scope; the supervisor's handoff/attach fence; and the
isolated preflight/final-proof split. If a protected base change is necessary,
use a new base compatibility ID. Any database addition needs a number assigned
by the orchestrator. SSH/active-preview continuity needs a separately agreed
service-authority change. HU's 60-second/no-present-client gate is retained for
its quiet path; LU only replaces it on individually qualified resident paths.

The Alpha runner must read `.env.agent`, use deployed supported endpoints and a
staff-only older-runtime create pin, and refuse before creating anything if
capabilities are absent. Create only `zeros-v2-test-lu-*` resources, journal
idempotency/resource IDs before mutation, use synthetic terminal/HTTP sequence
markers, and report closed checks/timings. Test duplicate input and sends,
rollback, two-device replay and unaffected user files. Delete in `finally`,
recover lost create replies by idempotency, and verify all generations' pending
deletion inventory is empty. Never print tokens, signed URLs, process arguments,
environments or raw provider errors. No live run was performed here.

## Local workspace impact

Local-owner and organization-owned local workspaces retain their existing
engine/PTY-host lifecycle, filesystem identity and offline behavior. Select the
new host only at the cloud-worker boundary. Shared adapters require a regression
proving local stdio spawn and explicit teardown remain unchanged. Local-owner
cloud placement remains invalid. macOS lifecycle checks remain owner-run.

## Cloud workspace impact and owner experience

Organization cloud workspaces stage a qualified update while the owner keeps
typing. A drained agent switches runtime before the next queued turn; resident
shells and dev servers continue. The qualified short gap reconnects without a
banner, preserves terminal output and conversation ordering, and converges on
all devices. Existing unsupported activity delays activation without killing
work. Qualification/staging failure leaves the source usable; target failure
uses HU rollback. Until those gates pass, this is a proposed experience, not a
claim that today's old workspace has received the fix.

Owner/placement switches retain independent exact-key connections and update
state; no cloud host/capability may attach to a local or foreign workspace.
