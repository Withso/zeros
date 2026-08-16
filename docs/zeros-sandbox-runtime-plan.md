# Zeros Sandbox Runtime — uniform code/Design isolation plan

**Status:** Local implementation closure and cross-platform qualification audit,
2026-08-16. The uniform ZSR contract is implemented and fails closed. Every
deterministic repository gate and every live gate supported by the available
Mac host is green, and the final synchronized source has passed the complete
macOS arm64 Seatbelt matrix,
private OrbStack container matrix, browser-preview matrix, engine smoke, and a
Developer-ID-signed packaged-app runtime smoke. Release-wide graduation remains
withheld until the same immutable source is green on macOS x64, Linux arm64,
and an actual production cloud-worker image. No production cloud-workspace
feature work is in the current closure scope: the existing cloud code is
retained without expansion and its unqualified work is recorded, not inferred. See the
[qualification ledger](zeros-sandbox-runtime-qualification.md) for exact run
results and deferrals. Keep this document until every remaining qualification
item below is delivered, explicitly cancelled, or folded into
[design-mode.md](design-mode.md) and
[autonomous-code-design-foundation.md](autonomous-code-design-foundation.md).

**Protected-document relationship:** this plan does not modify
`autonomous-code-design-foundation.md`. Changes to that protected document
remain separate maintainer-approved work.

### Current implementation ledger

This ledger distinguishes code that exists from a release claim. “Implemented”
means source and deterministic tests are present. “Qualified” requires the live
matrix on the exact shipped OS/image/architecture; a nearby CI container or a
weaker provider-native sandbox is not evidence.

| Phase                                  | Current state                                                                                                                                                                                                                       | Graduation evidence still required                                                                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — contract and fail-closed admission | Implemented; all required deterministic repository gates pass on the final working-tree content.                                                                                                                                    | Repeat CI on the immutable commit.                                                                                                                                                                           |
| 1 — exact pin/backend decision         | Implemented with audited `srt` `0.0.73`, patch digest, license, generated policy, native attack helper, and a secure macOS arm64 run on Darwin 25.3.0.                                                                              | First immutable-commit macOS x64 and Linux arm64 runs. This Vercel host cannot substitute because its outer sandbox denies the bubblewrap `/proc` mount and UID map.                                         |
| 2 — supervisor/backends                | Seatbelt and bubblewrap backends plus the retained cloud-worker contract are implemented. macOS arm64 engine and signed packaged-app runtime smokes pass.                                                                           | macOS x64 packaged smoke and an actual cloud image attestation.                                                                                                                                              |
| 3 — uniform providers                  | Claude, Codex, and Cursor use the same gateway/boundary contract; OpenCode is the whole-runtime conformance fixture. Offline startup/handshake smokes pass for the pinned Claude, Codex, Cursor Node, and Cursor Electron runtimes, and a real contained Claude turn completed in Zeros Dev. | A controlled credentialed normal-vs-contained differential on each release backend; the successful user-driven contained turn does not substitute for that comparison.                                     |
| 4 — shadow Git                         | Implemented for every admitted Git owner, cwd/`-C` dispatch, native macOS Git interposition, private metadata/brokers, CAS promotion, credentials, signing, partial clones, LFS, submodules, and linked-worktree validation.        | Repeat the live multi-owner/projection canary on each remaining release architecture/image.                                                                                                                  |
| 5 — feature/services                   | Provider state, MCP, OAuth/open-URL, preview/HMR/WebSocket, local/Unix services, ports, and private containers are implemented. The arm64 Mac passed the real browser-preview and OrbStack normal/privileged-container matrices.    | Provision and qualify a private rootless container worker on every other graduated backend; never fall back to a host daemon socket.                                                                         |
| 6 — tasks/lifecycle                    | Repository tasks, proof-carrying teardown, restart recovery, limits, human-terminal separation, and aggregate shutdown cleanup are implemented. macOS arm64 `smoke:engine` and teardown proof pass.                                 | macOS x64 and Linux release-host lifecycle runs; actual worker cgroup/PID-boundary evidence.                                                                                                                 |
| 7 — cloud backend/qualification        | The existing admission, transport, validation, cleanup, and control-plane foundation is retained. No new cloud-workspace implementation is part of this closure.                                                                    | Actual provider image, delegated cgroups, tenant/workspace identity, live provider differential, lifecycle/soak/SSH, and verified deletion. Existing DB/provider integration tests remain environment-gated. |
| 8 — rollout/design agent               | Boundary diagnostics, ports/services, territory restart state, and pin-maintenance gates are implemented.                                                                                                                           | Remaining backend graduation, a real Design-agent consumer, and explicit per-edit maintainer approval before any protected-foundation change.                                                                |

The runtime publishes a machine-readable `container-workflows-unavailable`
restriction instead of claiming full parity when the safe private container
path is absent. It keeps the session useful without weakening Design integrity,
but must be eliminated (or the backend kept ungraduated) before the
unconditional “only Design differs” release claim is used. The protocol keeps
the former `additional-repository-git-read-only` value only for v1 compatibility
with older engines; current ZSR admission provisions a shadow repository for
every attached Design-bearing Git owner and does not emit it.

### Latest live evidence (2026-08-16 UTC)

- The Linux-hosted repository matrix is green: `pnpm typecheck`, lint, UI,
  secrets, preload, Electron hardening, runtime-pin, packaging-path, protocol,
  workflow, migration, license, Codex-pin, audit, Design containment, Git,
  real-browser UI smoke, UI build, provider-offline smoke, and adapter gates
  passed. `pnpm test:git` passed 588 files and 6,481 tests with 3
  platform-gated skips. `pnpm check:design-containment` passed 20 files and
  424 tests with the same 3 skips; the focused ZSR containment, engine-startup,
  chat-title, and session-admission regression run passed 27 files and 243
  tests without a failure.
- On the attached Apple-silicon Mac (Darwin 25.3.0), the final synchronized
  source passed `pnpm check:zsr` with `secure: true`. The exact SRT patch,
  Seatbelt/process-domain policy, native mutation helper, port interposer,
  Keychain/security-service denial, private Git, code-write, Design mutation,
  descendant, local-service, reverse-port and dynamic-port canaries passed.
- The same source passed the real Chrome preview matrix and the OrbStack 2.2.1
  normal/privileged private-container matrix. Code projection, Design denial,
  unleased-port denial, and teardown proof were green. Cold OrbStack admission
  was approximately 65.4 seconds. The Mac-side `DOCKER_HOST` proxy carried each
  connection over an exact-machine OrbStack CLI relay after a session-HMAC
  readiness proof, so it neither depends on an unstable guest IP route nor
  exposes a host Docker/Podman daemon socket. Relay concurrency, half-close,
  readiness-probe escalation, and teardown are bounded, and machine deletion
  still runs when relay cleanup fails.
- The running development app was inspected after the final source settled. It
  had one GUI-mode Electron main process; the other process using the app
  binary was the expected Cursor host with `ELECTRON_RUN_AS_NODE=1`. The engine
  remained healthy on port 25133, dispatched a real `AGENT_PROMPT` through the
  staged Claude CLI, and reported the completed turn/cache update. Provider
  failure text is rejected as a generated tab title. The renderer permits the
  qualified cold admission path up to 120 seconds and never overlaps another
  admission merely because that ceiling elapsed; Electron startup separately
  waits through bounded stale-containment recovery while the exact child is
  alive, fails promptly if it exits, and kills it before timing out.
- Exact-admission support directories now live in engine-private scratch. The
  only code-territory canary is a UUID-named create/read/unlink probe executed
  synchronously, preventing the former long-lived `.zeros-zsr-admission-*`
  entries from surfacing in Git Changes while still proving normal code writes.
- The final arm64 sidecar passed create/archive/restore engine smoke. A
  Developer-ID-signed directory package built from the synchronized source then
  passed deep/strict code-signature verification, a real packaged-PTY spawn,
  exact relay/supervisor script-hash comparison, required ZSR/provider-resource
  inspection, compiled-fix inspection, and direct packaged-engine execution.
  Notarization remains distribution-release evidence because this was a
  directory qualification build.
- Offline startup/handshake smokes passed for the pinned Claude, Codex, Cursor
  Node, and Cursor Electron runtimes without a model turn. Claude's expected
  HTTP 401 authentication result was handled without exponential retry; cost
  remained `$0 / 0`.
- The current Vercel Linux host cannot qualify a secure Linux backend: its outer
  sandbox blocks the required bubblewrap `/proc` mount and root UID map, and it
  does not delegate the required memory/PID cgroup controllers. ZSR fails closed
  there as designed. macOS x64, Linux arm64, credentialed provider
  differentials, and an actual production cloud-worker image have not run and
  are not claimed.
- The retained control-plane suite passed 96 unit tests while 79 real
  provider/database integrations remained environment-gated. No new production
  cloud-workspace implementation is part of this closure, and source automation
  is not counted as live evidence until it runs on the exact immutable commit
  and image.
- `pnpm check:web-deploy` completed but reported deployment status unverified:
  this environment had neither authenticated GitHub API access nor
  `CLOUDFLARE_ACCOUNT_ID`. It is recorded as external release evidence, not as
  a local ZSR failure or a green deployment claim.
- The production dependency audit remains green under its reviewed allowlist.
  Its 12 accepted findings (2 low, 7 moderate, 3 high) are confined to
  `@cursor/sdk`'s `@connectrpc/connect-node` → `undici@5.29.0` path; the affected
  compatibility branch activates below Node 18, while shipped and validation
  environments use Node 22/24.

The [qualification ledger](zeros-sandbox-runtime-qualification.md) contains the
complete command matrix, parity coverage, accepted warnings, and exact deferred
release/cloud work.

**Research basis:**

- Anthropic Sandbox Runtime repository and documentation:
  <https://github.com/anthropic-experimental/sandbox-runtime>
- Guillaume A.'s whole-OpenCode `srt` case study:
  <https://blog.guillaumea.fr/post/sandboxing-opencode-ai-agents-bubblewrap-srt/>
- OpenCode source:
  <https://github.com/anomalyco/opencode>
- Claude Code sandbox documentation:
  <https://code.claude.com/docs/en/sandboxing>
- Claude Code reference development container:
  <https://github.com/anthropics/claude-code/blob/main/.devcontainer/devcontainer.json>
- OrbStack isolated-machine and Cloud-init contracts:
  <https://docs.orbstack.dev/machines/isolated> and
  <https://docs.orbstack.dev/machines/cloud-init>
- Apple's code-signing requirement language and explicit verification model:
  <https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html>
- GitHub-hosted runner image/architecture labels:
  <https://github.com/actions/runner-images> and
  <https://docs.github.com/en/actions/reference/runners/github-hosted-runners>
- Daytona preview, SSH and snapshot lifecycle contracts:
  <https://www.daytona.io/docs/en/preview/>,
  <https://www.daytona.io/docs/en/ssh-access/> and
  <https://www.daytona.io/docs/en/typescript-sdk/snapshot/>

---

## 1. Product contract

### 1.1 The user-visible promise

A code agent in a Design-bearing workspace must work like the same agent in a
normal Zeros code workspace on the same platform, with one intentional
difference:

> The code agent can read Design, but cannot mutate the active or prospective
> Design territory, directly or indirectly.

“Works like normal” is a release criterion, not an aspiration. It includes:

- The same code reads, searches, edits, creates, deletes, renames, builds,
  tests, package managers, compilers, language servers, file watchers, PTYs,
  and user-authorized additional directories.
- The same provider settings, repository instructions, skills, plugins,
  subagents, hooks, MCP servers, and provider authentication flows.
- The same ordinary network access and access to explicitly authorized local
  services.
- The same user-facing Git workflows: status, diff, add, commit, branches,
  fetch, pull, push, merge, rebase, stash, conflict resolution, LFS,
  submodules, signing, and worktrees when the operation preserves the Design
  authority contract.
- The same ability to start dev servers and reach them from previews, browsers,
  tests, and other processes in the same session.
- The same behavior in local and cloud workspaces relative to each platform's
  normal baseline. A Linux cloud workspace does not gain macOS Keychain or
  Apple Events, but Design containment must add no extra feature loss beyond
  what that normal Linux cloud workspace already has.

The implementation may virtualize Git metadata, provider state, credentials,
ports, sockets, or browser opening. That plumbing should normally be invisible.
An authority-changing action may use the existing permission UI, but it must
have a supported path rather than a dead end.

“Only Design differs” describes the user-visible workflow contract. It does not
mean an untrusted process receives raw engine control state or the canonical Git
record book. Those are implementation capabilities, not coding features; ZSR
projects safe equivalents so ordinary settings and Git commands still work.

### 1.2 Invariants that are not user-overridable

- Code actors never write an active, registered, committed, or prospective
  Design root.
- Code actors never receive a Design API mutation grant.
- Code actors never receive the engine's control token, state path, inherited
  control descriptor, or an equivalent confused-deputy capability.
- `Full Access` means full autonomy inside normal code authority. It never
  disables Design or engine-authority isolation. UI copy is **“Full Access —
  Design protected.”**
- A failed boundary cannot silently become an uncontained run.
- A territory change never retargets a live process. Capabilities are revoked,
  the old boundary is stopped and proved retired, and the session is reissued.
- A provider, OS image, or cloud backend does not graduate while its parity
  differential contains anything other than an intended Design mutation
  denial or an ordinary platform difference.

### 1.3 Scope and honest limits

The integrity promise covers every process causally controlled by a code agent
and every Zeros automation that executes repository- or agent-controlled bytes.
This includes provider CLIs, native file tools, shell commands, local MCP
servers, hooks, plugins, subagents, setup/test/run commands, Git helpers, and
dev servers.

An explicitly human-controlled terminal or external editor continues to run as
the user. It is outside the code-agent promise and must be labelled as such. A
future **Protected terminal** may opt into the same code boundary.

The no-feature-loss claim applies to Zeros-supported local and cloud
environments. An arbitrary third-party host without any enforceable OS,
container, VM, or mount boundary cannot truthfully provide Design integrity;
Zeros must provision a qualified worker for it or refuse admission rather than
pretend a prompt is a sandbox. This is an infrastructure qualification, not a
reduced agent mode.

Like Seatbelt, bubblewrap and ordinary container isolation, this contract
trusts the host kernel and the exact attested runtime in its trusted computing
base; it is not a promise against a kernel/hypervisor zero-day. OrbStack itself
documents that isolated machines share its Linux VM kernel and are intended for
ordinary untrusted dependencies and AI agents, not malware analysis. If the
product threat model expands to hostile kernel exploitation, OrbStack and the
container backend do not graduate; use a dedicated full-VM backend with no raw
protected mount instead. This does not reduce the stated code-agent contract,
but it prevents “kernel-enforced” from being misread as “kernel-independent.”

Design is readable by code agents and normal remote network access remains
available. This is a Design-integrity and engine-authority boundary, not a
Design-confidentiality or general data-loss-prevention claim.

The trusted Git broker guarantees that Zeros-projected credentials and the
normal `git` path cannot publish a ref whose protected snapshot differs. It
cannot make an unrestricted network into a universal remote-ref firewall: an
agent that already owns an unrelated credential, raw SSH agent, or public
write endpoint can invoke another protocol implementation directly. Likewise,
an SSH agent can sign arbitrary challenges by design. Those are properties of
the user's normal network/credential posture. The hard guarantee is local
Design and canonical-engine integrity plus non-disclosure of Zeros-brokered
secrets; absolute remote DLP would require a separately scoped egress and
credential product and would not be normal-workspace parity.

## 2. One runtime for every agent

**Zeros Sandbox Runtime (ZSR)** is the product-owned execution boundary.
Anthropic's `@anthropic-ai/sandbox-runtime` (`srt`) is a candidate component of
ZSR; it is not the public contract and does not own provider admission.

The graduated state is uniform:

- Every Claude, Codex, Cursor, OpenCode, future ACP, and generic CLI session is
  launched through the same `ExecutionBoundary` contract.
- Every session, including a non-Design workspace, has a Zeros supervisor. A
  normal-workspace policy mirrors normal authority; a Design-bearing policy is
  that same authority minus Design and engine-owned territory.
- Policy differs by workspace/actor role, not by provider.
- The platform backend may differ: Seatbelt on local macOS, bubblewrap/seccomp
  on qualified local Linux, and a cloud-native worker/container mount boundary
  in cloud. All implement the same tests and semantics.
- Provider-native permission prompts remain. Provider-native OS sandboxes may
  be retained temporarily during migration or as qualified defense-in-depth,
  but they are never the final source of the Design guarantee and are never
  allowed to create a weaker provider-specific policy.
- There is exactly one authoritative outer boundary. If a provider sandbox
  conflicts with it, the provider sandbox is disabled rather than nesting two
  incompatible policies.

This replaces the previous permanent `provider-native | zeros-jail` split and
the optional Claude/Codex unification phase. Unification is now a graduation
requirement.

## 3. Actor and process model

| Domain              | Contents                                                                                                 | Authority                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `agent-code`        | Provider runtime, native file tools, shells, local MCP, hooks, plugins, subagents, agent-started servers | Normal code-workspace authority minus Design and engine state                            |
| `repo-code-task`    | Zeros setup/run/test/build commands and Git hooks or helpers that execute repository bytes               | Same boundary as `agent-code`                                                            |
| `engine-privileged` | Territory resolution, Design API, validated Git promotion, credential/port brokers                       | Typed operations only; never executes untrusted repository bytes outside a code boundary |
| `human-user`        | Explicit human terminal/editor and external tools                                                        | User authority; outside the agent guarantee and clearly labelled                         |
| `design-actor`      | Human Design surface and future design agents                                                            | Typed Design API/draft grants; no raw Design filesystem or general Git mutation          |

The causal-closure rule is load-bearing: if a trusted Zeros process executes
bytes an agent could change, that execution inherits `agent-code` authority.
This prevents Git hooks, package scripts, filters, preview servers, or MCP
helpers from becoming confused deputies.

## 4. Research findings that shape the implementation

### 4.1 Anthropic Sandbox Runtime

Verified against `0.0.73` on 2026-08-14:

- `srt` is an Apache-2.0 beta research preview. It uses Seatbelt on macOS and
  bubblewrap plus seccomp and proxy bridges on Linux. Its boundary covers a
  wrapped process tree, which is the right primitive for provider shells and
  their child processes.
- Its `SandboxManager` state and proxy set are module-global. Different
  per-session policies therefore require separate Zeros supervisor processes.
- Its write model—allow normal roots and deny protected descendants—matches
  Design territory well.
- Its built-in mandatory denies do **not** match Zeros parity. In filesystem
  policy mode it blocks project files such as `.mcp.json`, `.gitmodules`,
  `.vscode`, `.idea`, `.claude/commands`, and `.claude/agents`. Zeros needs a
  narrowly patched/forked policy or its own filesystem profile; disabling all
  filesystem policy is not acceptable.
- Linux paths are literal rather than glob-based. Generated policy uses
  absolute canonical paths only and protects both existing and prospective
  paths.
- Linux blocks Unix socket creation coarsely. The OpenCode case study had to
  enable all Unix sockets to reach a Nix daemon, which also exposed Docker,
  SSH-agent, and GPG-agent sockets. Zeros must use a per-capability socket or
  service broker instead of `allowAllUnixSockets:true`.
- `allowAppleEvents` permits launching unsandboxed applications and is never
  enabled for a code boundary. URL opening and OAuth move to a trusted UI
  request.
- The exact pin gets a strict Zeros schema, generated-policy snapshot, live
  canary, packaging check, attack matrix, and upgrade gate. Unknown keys,
  mandatory-deny mount artifacts, PTY behavior, nested user namespaces, and
  read/write mount order are tested rather than inferred.

### 4.2 OpenCode validates whole-runtime wrapping

The linked case study successfully launches `srt ... opencode`, preserving the
agent while constraining the process tree. Two practical lessons become Zeros
requirements:

- A direct argv spawn does not expand `~`; every Zeros-generated path is
  absolute before it crosses the supervisor protocol.
- A broad Unix-socket exception restores compatibility by weakening isolation;
  Zeros instead brokers the exact service.

Current OpenCode source reinforces the architectural choice:

- Shell tools spawn child shells from the main OpenCode runtime.
- Local MCP configuration creates stdio child processes and inherits the
  runtime environment.
- Plugins can contribute shell environment.

Wrapping the entire OpenCode runtime therefore naturally contains its shell,
MCP, plugin, and descendant execution. Zeros will keep OpenCode as the generic
provider-contract fixture even before it becomes a shipped adapter.

### 4.3 What Claude's cloud behavior does—and does not—prove

Claude works in cloud/dev-container environments because either its Bash
sandbox primitives are available or the entire CLI already runs inside an
outer container/VM boundary. Claude documents a weaker nested mode for
unprivileged Docker, explicitly noting reduced security, and its reference
devcontainer supplies its own container and firewall.

That solves **host isolation**. It does not by itself solve Zeros' finer
intra-workspace rule: the code process and the trusted Design service share one
checkout, but only the latter may write Design.

Cloud qualification therefore asks whether the deployed host can enforce the
same ZSR projection; it does not ask whether Claude, Codex, Cursor, or OpenCode
should lose features. Provider qualification and host-backend qualification
are separate gates.

For Zeros cloud workspaces, the correct composition is:

1. The existing cloud sandbox isolates the workspace from infrastructure.
2. A per-agent cloud worker or mount namespace gives the code actor a projected
   view: normal code roots read/write, Design and safe policy inputs read-only,
   engine secrets/control state absent, canonical Git control metadata hidden,
   and session Git/state/scratch read/write.
3. Trusted Design and Git promotion services stay outside that code view.

If nested secure bubblewrap works, it may implement step 2. If it does not,
the cloud orchestrator supplies the mount/container boundary directly. The
user must not lose features merely because nested bubblewrap is unavailable.
`enableWeakerNestedSandbox` is allowed only as additional hardening when the
outer cloud boundary already enforces the Design mount contract; it is never
the sole Design boundary.

The current Conductor cloud image illustrates why backend selection matters:
`bwrap`, `socat`, and `rg` are installed, but the live bubblewrap namespace
canary fails because the image's capability configuration is incompatible.
That does not mean cloud sessions should be restricted or refused forever; it
means this image needs the cloud-native projection backend or an image fix.

## 5. Current anchors and immediate findings

| Mechanism                                 | Anchor                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Adapter admission and fail-closed gateway | `apps/desktop/src/engine/agents/types.ts`, `agents/gateway.ts:668-730`                |
| Territory discovery/canonicalization      | `agents/gateway.ts:282-357`, `engine/design/directory.ts`                             |
| Claude custom process root                | `agents/adapters/claude-sdk/contained-process.ts:65-160`                              |
| Codex/generic stdio root                  | `agents/adapters/shared/stdio-process.ts:93-166`                                      |
| Shared Cursor Node host                   | `agents/adapters/cursor-sdk/host/host-client.ts:1-23,565-680`                         |
| Existing provider-native policies         | `claude-sdk/adapter.ts:406-440`, `codex/territory.ts:57-112`                          |
| Git commit/design checks                  | `engine/git/ops.ts:65-155`, `engine/git/git-exec.ts:589-639`                          |
| Design API                                | `engine/design/design-api.ts`, foundation “Design API as the agent mutation boundary” |

Security stabilization must precede dependency adoption:

1. `spawnStdioAgent` reconstructs the child environment with `process.env`
   after callers stripped engine authority. A stripped engine variable can be
   reintroduced. A supplied child environment becomes complete/authoritative,
   with an end-to-end child-environment regression test.
2. `forkProviderBinding` skips the new/load territory admission, environment
   clamp, and territory MCP rules. Fork follows the identical admission path.
3. Territory construction returns “no territory” when the configured Design
   path is temporarily absent before discovering recognized alternatives. A
   missing, moved, or ambiguous registered Design path fails closed; it never
   silently becomes a normal workspace.
4. The current process-group proof does not cover hostile `setsid`/double-fork
   behavior. Qualification tests prove full teardown or select a backend with
   a PID/container boundary.
5. Existing engine Git operations can run repository-controlled hooks, filters,
   helpers, or package scripts with engine authority. Agent-originated Git must
   not reuse that privileged executor unchanged.
6. Zeros run/setup/test actions that execute agent-editable repository code are
   brought under `repo-code-task` authority.

## 6. Architecture decisions

### D1 — Uniform `ExecutionBoundary`

Create `apps/desktop/src/engine/agents/containment/` with a backend-neutral
contract resembling:

```ts
interface ExecutionBoundary {
  prepare(request: BoundaryRequest): Promise<PreparedBoundary>;
}

interface PreparedBoundary {
  spawn(request: SpawnRequest): Promise<BoundaryProcess>;
  requestPort(request: PortRequest): Promise<PortLease>;
  requestLocalService(request: ServiceRequest): Promise<ServiceLease>;
  revoke(): Promise<void>;
  stopAndProve(): Promise<void>;
}
```

The supervisor owns the child, pipes, PTY, network proxy, state roots,
capabilities, violation stream, and teardown. It does not merely return a shell
wrapper string to the engine.

### D2 — Every actual process root integrates with the boundary

- Codex/generic adapters use the shared stdio integration.
- Claude's SDK custom `spawnClaudeCodeProcess` delegates to the prepared
  boundary.
- Cursor is refactored from one global host into a per-session host or a
  per-session jailed execution worker. Cursor's persistent SDK store becomes an
  explicit session/provider-state capability.
- Local MCP and provider helpers must be descendants of the provider boundary;
  an engine-hosted MCP/tool instead receives a per-session method allowlist and
  capability token.
- Zeros repository tasks use the same supervisor with the `repo-code-task`
  actor type.

### D3 — Normal authority minus protected territory

The policy builder starts from the normal Zeros workspace grant for the same
platform and permission posture, including user-authorized extra roots. It
then subtracts:

- Every active, committed, registered, and prospective Design directory.
- Engine-owned `.zeros` policy/control authority. Safe policy inputs may be
  projected read-only; credentials, tokens, sockets, and mutable control state
  are absent.
- Canonical Git metadata, replaced by the session Git view below.
- Engine data/control paths and inherited authority.

Project source and configuration—including `.mcp.json`, `.vscode`, `.idea`,
`.claude/commands`, `.claude/agents`, and `.gitmodules`—remain ordinary code
territory unless a separate explicit authority rule protects them.

### D4 — Provider configuration and state preserve normal behavior

- Read the user's real provider configuration and repository instructions as
  normal.
- Project configuration stays live in the workspace.
- Give mutable provider caches, transcripts, downloads, plugin installs, and
  SDK stores a private session overlay backed by an engine-owned persistence
  service where normal persistence is expected.
- User-global authority-changing writes use the existing permission UI and a
  typed provider-state operation; they never require an unsandboxed child.
- Authentication uses provider-native API credentials through masked/env or
  credential-broker projection. The engine's own credentials never enter the
  boundary.

### D5 — Transparent shadow Git and validated promotion

The agent sees a native, writable session Git repository:

- Private `GIT_DIR`, index, refs, reflogs, config, hooks, and new object store.
- Canonical object storage available read-only through alternates.
- Linux, cloud-worker and private-container backends overmount/project the
  checkout's `.git` path as the private session Git view. Native macOS hides
  canonical Git with Seatbelt and combines the per-repository environment,
  cwd/`-C` dispatcher and a post-Seatbelt `execve`/`posix_spawn` interposer for
  admitted absolute Git binaries. A process that deliberately bypasses the
  compatibility layer still reaches the kernel deny, never canonical control
  state. Admission exercises each repository with its absolute Git binary.
- Canonical control files, refs, config, hooks, and writable object storage are
  absent from the agent view; only the explicitly read-only object pool is
  reachable.
- The live code worktree as `GIT_WORK_TREE`; Design remains read-only.
- Hooks, filters, credential helpers, remote helpers, and custom Git commands
  execute only inside `agent-code` authority.

A session watcher/shim turns durable operations into a validated ChangeSet:

1. Authenticate session, workspace identity, territory generation, expected
   HEAD, branch, remote, ref, and nonce.
2. Bound object count/size and run object/connectivity validation.
3. Compare every protected Design tree and pointer/policy value with the exact
   expected base.
4. Run requested hooks/checks inside the code boundary, then revalidate.
5. Import immutable objects without invoking repository programs.
6. Advance canonical refs with old-OID compare-and-swap.
7. Apply code-only worktree transitions under the workspace mutation lane.

Every outbound ref update, including a direct push of a session-only ref, is
validated against the protected Design tree. Remote credentials never provide
an alternate path around ChangeSet validation.

Common `git` invocations remain native. A command that would change Design is
redirected to an explicit repository-sync/Design operation; destructive Design
reset/clean/restore is refused with a recovery path. LFS, submodules, signing,
worktrees, interactive editors, and custom filters are compatibility work, not
permanent exclusions.

### D6 — Ports, localhost, sockets, and services are capabilities

- Remote internet behavior matches the normal workspace posture.
- The engine/control port remains unreachable even when a broker token leaks.
- Agent-started servers receive exact per-session port leases. Linux gets a
  reverse bridge out of the network namespace; macOS gets bind/inbound rules
  for assigned ports without general localhost outbound.
- Browser/preview access, WebSockets, HMR, IPv4, IPv6, and random-port
  discovery are part of the parity suite.
- Host databases, Nix, Docker/Podman, SSH/GPG agents, and similar local
  services use typed per-session bridges or isolated task workers. Docker and
  Podman specifically use an isolated rootless daemon/worker with only the
  projected workspace; their host control sockets are never forwarded because
  an unrestricted daemon API can mount the original Design path. The CLI
  workflow should work; broad host socket access is never the mechanism.
- URL opening and OAuth are trusted UI requests. Apple Events are not granted
  to code processes.

### D7 — Territory is a generation, not a path snapshot

Admission protects the union of committed recognition, configured pointer,
engine registry, prospective lease, and both sides of an in-progress move.
Resolution, runtime probing, canary, and session publication share a transition
lock and generation.

On change: mark draining, revoke capabilities, stop/prove the old boundary,
validate the new union, publish, and re-admit. Broker requests carrying a stale
generation fail.

The default bare `Zeros Design/` bootstrap heuristic should eventually be
replaced by an explicit prospective Design lease so an ordinary folder does
not unexpectedly activate protection. That foundation change requires
maintainer confirmation.

### D8 — Cloud uses the strongest available implementation of the same contract

Backend selection is an implementation detail:

1. Prefer an orchestrator-created per-agent container/worker with explicit
   mounts and resource limits.
2. Use secure nested `srt`/bubblewrap when its live canary passes.
3. Use weaker nested mode only when an independently attested outer mount
   boundary already enforces Design and Git isolation.

No cloud image earns a reduced feature matrix. An image/backend graduates only
when the normal-cloud baseline and Design-contained run differ solely on
Design mutation attempts and internal implementation details.

### D9 — Design agents stay on the Design API

The human canvas remains a trusted in-process Design API consumer. A future
design agent receives a private draft, `ActorContext`, `CapabilityGrant`, and
base revision; it submits typed transactions and promotes with CAS. It does not
receive raw filesystem or general Git write authority.

## 7. Delivery phases

Every phase follows the repository verification requirements. A bug gets a
failing regression test first. Platform-only checks are reported only on the
platform where they ran.

### Phase 0 — Stabilize the current boundary and freeze the contract

1. Add the parity contract, causal process domains, and territory-generation
   model to executable/source-contract tests.
2. Fix complete child-environment construction and test the actual spawned
   child's environment.
3. Route fork through the same admission, clamp, territory identity, and MCP
   rules as new/load.
4. Fix the missing/moved/ambiguous Design fail-open and add committed,
   uncommitted rename, absent target, prospective path, case, Unicode, symlink,
   hardlink, worktree, and nested-owner regression tests.
5. Prevent agent-originated engine Git and repository-task confused deputies.
   Until the safe executor exists, do not replace agent Git prompts with raw
   privileged `runGit` calls.
6. Add the current UI truth: **Full Access — Design protected**, provider
   preflight state, and precise remediation.

**Exit:** all existing Claude/Codex containment paths are at least as safe as
today, and none of the known bypasses remains while ZSR is built.

### Phase 1 — Exact-pin feasibility and backend selection

1. Complete the dependency/license review before adding the package.
2. Spike exact `srt` `0.0.73` on macOS arm64/x64 and Linux x64/arm64 using
   absolute paths and strict generated configuration.
3. Prove vanilla and patched behavior for Design denies, writable project
   settings, later-created paths, hardlinks, rename/exchange, inherited FDs,
   PTY, network, Unix sockets, cross-process signals/inspection, violation
   reporting, state roots, and teardown.
4. Run whole-runtime fixtures for Claude, Codex, a per-session Cursor-host
   prototype, and OpenCode. OpenCode must prove shell, plugin environment,
   local MCP, subagent, and child-process inheritance.
5. Spike both directions of networking: agent to approved local service and
   host/browser to agent-started server, including HMR/WebSocket.
6. Run the same probe in a candidate cloud worker. If secure nested bubblewrap
   fails, prove the cloud-native mount/container backend instead.
7. Record the go/no-go: audited Zeros `srt` patch/fork, Zeros-native profiles,
   or a composition of the two. Keep the interface backend-neutral.

**Exit:** an evidence-backed backend decision. No production dependency or
provider rollout proceeds on an assumption.

### Phase 2 — ZSR supervisor and platform backends

1. Implement `ExecutionBoundary`, `BoundaryRequest`, `BoundaryProcess`, and
   backend capability/probe types.
2. Implement a per-session supervisor that owns spawn, stdio/PTY, absolute
   argv, exact environment, policy state, credentials, ports, violations,
   resource limits, revocation, and teardown.
3. Implement the policy builder: normal grant minus territory, with private
   temp/provider/Git state and no shared writable runtime paths.
4. Implement qualified local macOS, local Linux, and cloud-worker backends.
5. Add a live admission canary: permitted code write must succeed; direct and
   alias Design writes, engine connection, and capability replay must fail.
6. Add crash recovery and session-generation persistence sufficient to revoke
   leaked broker/port credentials after engine restart.

**Exit:** a dummy/generic process passes the full attack and parity harness on
each claimed backend.

### Phase 3 — Uniform provider migration

1. Integrate Codex through the stdio root.
2. Integrate Claude through its SDK custom spawn seam; its native tool
   permission UX remains, while the outer ZSR boundary covers native file tools
   as well as Bash descendants.
3. Refactor Cursor to one host/execution worker per session and move its store
   behind explicit state persistence.
4. Keep OpenCode as the provider-onboarding conformance fixture and add a
   shipped adapter only when product scope calls for it.
5. Re-enable each provider only after its normal-vs-contained differential is
   empty apart from Design mutation.
6. Remove the permanent provider-mode split. Existing provider-native
   containment remains a rollout fallback only until the matching ZSR path is
   qualified.

**Exit:** Claude, Codex, and Cursor all run under one Zeros-owned contract on
qualified local and cloud backends.

### Phase 4 — Transparent Git compatibility

1. Build the shadow Git repository and private index/object/ref lifecycle.
2. Build ChangeSet validation and CAS promotion without privileged execution of
   repository-controlled hooks, filters, helpers, editors, or aliases.
3. Implement code-only branch/checkout/pull/merge/rebase/stash/reset candidates
   and explicit Design-impact routing.
4. Implement scoped remote credential, signing, and exact remote/ref grants.
5. Qualify interactive Git, hooks, filters, LFS, submodules, worktrees, partial
   clones, alternates, linked worktrees, merge conflicts, concurrent human Git,
   and multiple agent sessions.
6. Surface session-staged/committed state coherently in existing Git views.

**Exit:** the Git parity suite passes; only operations whose result mutates
Design receive a different outcome.

### Phase 5 — Feature and local-service parity

1. Re-enable settings, repository instructions, MCP, hooks, plugins, skills,
   subagents, browser tools, image workflows, and provider state one at a time.
2. Implement the reverse port broker and browser/preview integration.
3. Implement trusted OAuth/open-URL and provider credential flows.
4. Add exact local-service adapters required by the compatibility corpus:
   databases, Nix, Docker/Podman, SSH/GPG agents, language daemons, and
   Watchman-equivalent behavior.
5. Qualify package managers and major toolchains against the normal-workspace
   baseline, including project configuration writes that vanilla `srt` blocks.
6. Run the attack matrix in every permission posture, especially Full Access.

**Exit:** no provider feature is stripped solely because Design exists.

### Phase 6 — Repository tasks, terminals, and lifecycle hardening

1. Run Zeros setup/run/test/build/preview tasks under `repo-code-task` when
   their bytes are repository- or agent-controlled.
2. Preserve an explicit human **Run as me** path outside the guarantee, with a
   clear badge; optionally add a Protected terminal.
3. Add Linux cgroup/container limits and appropriate macOS process/file/socket
   limits without breaking normal workloads.
4. Prove `setsid`, double fork, child process-group changes, ignored signals,
   inherited descriptors, supervisor crash, engine restart, and forced kill.
5. Revoke capabilities and ports before kill, then reap and clean private state
   without deleting user files.

**Exit:** no Zeros automation becomes an authority bridge and no hostile child
survives with live capabilities.

### Phase 7 — Cloud parity and image qualification

1. Define a cloud `ExecutionBoundary` API between the trusted workspace
   coordinator and per-agent worker.
2. Mount/project code read-write, Design/safe policy read-only, and private
   state/Git/scratch read-write. Engine control state and canonical Git control
   metadata are absent, and the checkout `.git` path presents the private
   session view. Multiple workers may share normal code territory when that is
   the baseline, but no shared mount gives them write access to Design, engine
   state, or canonical Git metadata.
3. Preserve the normal cloud toolchain, internet, MCP, Git, dev server, browser,
   auth, and run-script behavior. Zeros' port service is independent of
   platform variables such as `CONDUCTOR_PORT`.
4. Attest image digest, architecture, kernel/LSM/userns state, runtime/helper
   versions, mount table, seccomp/resource policy, and live canary results.
5. Gate the remote listener with independent preview and bridge capabilities,
   mandatory asymmetric owner binding, schema/frame bounds, a completed
   `CONNECTED` deadline, exactly one canonical credential carrier, bounded
   HTTP/WebSocket peers, aggregate inbound-handler/retained-byte and outbound
   queues, a reserved bounded control lane, and one-time disconnect cleanup.
   Do not release post-handshake frames while JWKS/static-key verification is
   still in flight. JWKS resolution must coalesce concurrent lookups, bound
   headers and streamed decompressed bodies, enforce deadlines, and reject
   algorithm/key-use confusion.
6. Run the same attack matrix and normal-vs-contained differential suite in the
   actual deployed image, not a nearby CI container.
7. Make backend repair or cloud-native fallback automatic for Zeros-controlled
   images. Admission refusal is reserved for genuinely unsupported third-party
   environments, never used as the ordinary cloud experience.

**Exit:** a user can run the same workflow in a normal and Design-bearing cloud
workspace; all positive operations match and only Design mutations fail.

### Phase 8 — Design-agent boundary, rollout, and maintenance

1. Add draft Design API capabilities only with a real design-agent consumer.
2. Roll out by provider/backend behind internal flags, but graduate only after
   the uniform contract is complete for that provider/backend.
3. Show pre-send health, active boundary, mapped ports/services, Git
   transitions, territory restarts, and redacted diagnostics. Never silently
   strip a feature mid-session.
4. Exact-pin updates are weekly/no-automerge and rerun packaging, license,
   attack, parity, and cloud-image gates.
5. With maintainer approval, update the protected foundation checkpoints and
   durable `design-mode.md` contract.

## 8. Normal-vs-contained parity matrix

Every row is compared against the same provider, version, permission posture,
workspace fixture, and platform without a Design territory.

| Use case                                                 | Required contained result                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Read/search code and Design                              | Identical                                                                                    |
| Write/delete/rename code                                 | Identical                                                                                    |
| Write active/prospective Design from code actor          | Kernel/API denial; Design unchanged                                                          |
| Build/test/package manager/compiler                      | Identical exit, outputs, and artifacts outside Design                                        |
| Project `.mcp.json`, IDE config, commands, agents, rules | Identical                                                                                    |
| User settings/plugin/skill install                       | Identical outcome through private state or approved persistence                              |
| Local/remote MCP                                         | Identical tools and results; local child inherits ZSR                                        |
| Subagents/background tasks                               | Identical behavior; same session authority                                                   |
| Dev server/HMR/WebSocket/preview                         | Identical reachability through a port lease                                                  |
| Remote network                                           | Identical normal-workspace posture                                                           |
| Approved local DB/Nix/Docker/SSH/GPG service             | Identical CLI workflow through scoped service capability                                     |
| OAuth/open browser                                       | Identical outcome through trusted UI                                                         |
| Git status through advanced safe workflows               | Same semantic result and compatible CLI behavior; a Design-changing result routes explicitly |
| Full Access                                              | Identical code autonomy; Design stays protected                                              |
| Human terminal                                           | Identical user authority; visibly outside agent containment                                  |

A provider/backend cannot graduate with a “documented limitation” in this
table. It either implements the missing compatibility path or remains behind a
flag.

## 9. Blocking attack and race matrix

### Filesystem and territory

- Direct write, truncate, chmod/chown/flags, unlink, directory rename, rename
  exchange, symlink, dangling symlink, hardlink created before and after
  admission, reflink/clone, mmap, pre-opened writable FD, FIFO/device attempts,
  ancestor rename, `openat`/directory-FD aliases, mount/remount, and namespace
  tricks.
- Missing/recreated Design root, uncommitted rename, active pointer change,
  committed marker change, bare default folder, case-only and Unicode-normalized
  aliases, nested workspace owners, linked Git worktrees, submodules.
- External transition during a turn and stale generation/capability replay.

### Process and capability

- Child/grandchild, native file tool, MCP, hook, plugin, subagent, setup/run
  task, `setsid`, double fork, daemonization, ignored SIGTERM, supervisor crash,
  engine restart, inherited FD/socket, environment-token recovery, cross-PID
  signal, `ptrace`/debug inspection, `/proc` environment reads, Mach task/process
  lookup, and attempts to kill or control the engine or another session.
- IPv4, IPv6, mapped IPv6, Unix/Mach sockets, engine/control port, cross-session
  broker/port use, Apple Events, Docker socket, SSH/GPG agent, credential files.

### Git

- Agent-crafted index/tree/object preserving code while smuggling Design,
  staged-tree races, `index.lock`, concurrent human Git, stale HEAD, ref races,
  aliases, `-c`, `GIT_*`, pagers, editors, askpass, credential/remote helpers,
  hooks, filters, merge drivers, external diff, `ext::`, custom upload-pack and
  receive-pack, force pushes, LFS, submodules, worktrees, partial clones,
  replace refs, grafts, alternates, and corrupt/oversized objects.

### Compatibility

- Claude, Codex, Cursor, and OpenCode login/config discovery; MCP and plugin
  startup; native and custom file tools; PTY/TUI; package managers; language
  servers; file watchers; dev/test servers; HMR; browser previews; OAuth;
  provider persistence; Git signing and credential refresh.

## 10. Verification and CI mapping

Baseline before handoff for each applicable phase:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm check:ui`
- `pnpm test:git`
- `pnpm check:secrets`
- `pnpm check:audit`
- `pnpm check:design-containment`
- Every applicable `check:*` command required by `AGENTS.md`

Additional gates:

| Area                     | Gate                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Runtime pin/packaging    | `check:runtime-pins`, `check:packaging-paths`, `check:licenses`, packaged smoke                                                     |
| Spawn/preload            | `check:preload`, relevant Electron tests                                                                                            |
| UI permissions/ports/Git | `test:ui-smoke`, `build:ui` where performance-sensitive                                                                             |
| macOS engine lifecycle   | `smoke:engine` and `check:zsr:orbstack` on macOS; never claimed from Linux                                                          |
| Provider                 | Existing provider smoke plus normal-vs-contained differential suite                                                                 |
| Git                      | `test:git`, broker abuse, multi-actor race and end-to-end workflow suites                                                           |
| Cloud                    | Protected `zsr-cloud-qualification.yml`: exact-image admission, live provider differential, lifecycle/soak/SSH and verified cleanup |

## 11. Remaining closure order and maintainer decisions

Local macOS arm64 closure is complete. Release-wide closure now proceeds in
evidence order; no missing item is converted into a softer policy:

1. Keep the deterministic Linux/unit gate green, including the native
   `openat`, mmap, rename-exchange, hardlink, broker-abuse and race probes.
2. Retain the completed macOS arm64 Seatbelt/process-domain,
   port-interposer/Keychain, browser, OrbStack normal/privileged-container,
   engine, signed-package, and teardown evidence. Run the identical complete
   matrix on macOS x64; never infer that result from arm64 or Linux.
3. Run the complete bubblewrap/native-helper, Git, service, browser, cgroup,
   packaged-runtime, and teardown matrix on Linux arm64 and on a Linux x64 host
   that grants the required namespace and controller capabilities. The current
   Vercel host's fail-closed result is not secure-backend qualification.
4. When an actual production cloud workspace exists, build and attest the exact
   commit/image and run the root-supervisor, identity, live-provider
   differential, lifecycle, zero-drop soak, SSH, reconnect, egress, and verified
   deletion matrix described in the qualification ledger. Do not add or infer
   production cloud functionality merely to close the local ZSR milestone.
5. Complete the separately approved cloud-workspace production lifecycle,
   tenant binding, durable record, setup worker, and user surfaces before
   calling Phase 7 a shipping cloud experience. The retained control-plane and
   validation foundation is not that qualification.
6. Either bundle/provision a supported private container backend for every
   graduated desktop image or keep `container-workflows-unavailable` visible.
   Never regain apparent parity by forwarding `/var/run/docker.sock`, a Podman
   host socket, or an equivalent VM control API.
7. Rerun every repository gate in section 10 on the release commit, resolve all
   failures, and only then remove rollout flags/provider fallback paths.

Maintainer decisions still required before their corresponding changes:

1. Confirm the audited exact-pinned `srt` patch and third-party license record
   for release under the repository's dependency policy.
2. Explicitly approve each protected
   `autonomous-code-design-foundation.md` edit before it is made. This plan has
   intentionally not edited that document.
3. Approve any future durable global provider-state or host-hook persistence
   broker; the implemented default remains isolated and purpose-scoped.
4. Approve a production cloud provider and tenant/identity architecture under
   the cloud-workspace roadmap. The operator validation harness is not that
   approval or implementation.

No provider-specific containment policy decision remains: Claude, Codex,
Cursor, OpenCode-compatible and future CLI processes all enter through the
same ZSR contract. Platform backends may differ only in how they enforce that
contract and in ordinary platform capabilities.
