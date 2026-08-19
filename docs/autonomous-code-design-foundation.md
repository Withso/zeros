# Autonomous Code and Design Foundation

**Status:** Foundational target architecture, current implementation checkpoint,
and incremental roadmap (updated 2026-08-13). Phase 0 is the prerequisite;
Phases 1–8 are the eight delivery phases, not a claim that every future system
already exists.

> [!IMPORTANT]
> **Protected architecture contract — explicit user instruction**
>
> AI agents and automation must not delete this document. Before writing
> anything to this document—including editing, appending, overwriting, moving,
> renaming, or deleting it—an AI agent must stop and obtain the user's explicit
> confirmation for that specific document change. Permission to change related
> code, tests, or other documentation is not permission to modify this file.
> Reading and referencing this document is allowed.

## Purpose

This document defines the foundation for code and design to coexist in one
semantic Zeros workspace while humans and autonomous workers operate safely and
concurrently. It covers today's local desktop and GitHub product as well as
future design agents, visual exploration, cloud workspaces, multiple execution
providers, and additional Git forges.

The central architecture is:

> One semantic workspace, many isolated physical executions, one controlled
> path back into canonical state.

The future capabilities described here are not all implemented. The contracts
are intentionally provider-neutral and forge-neutral, but implementation must
remain incremental: preserve today's behavior, add an abstraction with its first
real consumer, and do not deploy speculative services merely because a future
phase names them.

## 2026-08-13 implementation checkpoint

The repository now implements the minimum foundation needed by today's local,
human-Design, GitHub product without pretending that design agents or cloud
execution exist.

### Implemented now

- `viewMode` is a presentation-only field persisted explicitly in
  `workspaces.view_mode`; `kind` is a synchronized compatibility mirror.
  Code-agent role and immutable write capabilities live in the agent runtime
  contract and do not change when the user switches views.
- The forward-only SQLite ladder includes an invariant repair for internal
  checkpoint databases that had already consumed migration versions 28–30 for
  now-retired speculative command/artifact tables. It adds and backfills the
  final provider-neutral chat identity columns without deleting those older
  tables or rewriting an applied migration. This is upgrade compatibility, not
  a reintroduction of the deferred orchestration services.
- The human canvas uses the trusted in-process **Design Document API**. The
  shared package's default authorization fails closed, and coding agents receive
  no Design API, Design MCP server, or engine bearer capability.
- Each code-agent admission resolves one canonical workspace, the active Design
  pointer, every recognized Design document, `.zeros` policy, and the
  worktree/common Git metadata. It validates real, symlink-free directory
  segments, walks tracked, ignored, and untracked entries, and refuses
  pre-existing hard-linked Design files. A territory-bearing session is scoped
  to that one canonical physical workspace: workspace/cwd symlink or case
  aliases, provider `/add-dir` roots, and provider-owned launch path/wrapper
  overrides or generic process-injection environment names are refused or
  removed rather than silently widening write authority beyond the tree Zeros
  validated. Ordinary code-only workspaces keep their existing alias,
  additional-directory, and environment behavior.
- Zeros' pinned Codex and Claude runtimes establish immutable path-scoped
  profiles on qualified macOS and Linux hosts. Admission fails closed if the
  runtime, host primitive, or exact profile is unavailable. Custom/PATH
  executables and Cursor are refused for Design-bearing sessions because they
  are not qualified for this promise.
- Ask/Auto/Full/Read Only postures cannot widen the Codex profile. Claude native
  bypass is clamped while Design territory exists; Claude Code is pinned at
  2.1.231 and admission enforces the documented 2.1.228 built-in Write
  path-rule floor. Settings sources, hooks, plugins, MCP tools, workflows,
  artifacts, remote control, and native subagents are disabled for that
  session. Claude's administrator-managed policy tier is still read by the SDK,
  so admission resolves it and refuses dynamic helpers, managed-only permission
  rules, extra write roots, disabled/weakened isolation, executable
  hooks/plugins/wrappers, socket/Mach expansions, or other settings that are
  incompatible with the qualified profile. Claude admission also rejects a
  workspace/denied path containing glob, bracket, parenthesis, backslash,
  newline, or NUL metacharacters because its `Edit(...)` matcher has no verified
  literal encoding for those names. These are fail-closed provider/path
  qualifications; Codex's exact-path profile does not have the matcher
  restriction.
- Territory-bearing provider processes run in dedicated process groups. A
  settings change, first Design creation, or territory-changing Git operation
  blocks starts and verifies that the complete old process tree is gone before
  publishing new authority.
- Design document writes, pointer changes, and Design-affecting Git rewrites use
  the existing per-workspace mutation lane. First initialization also covers a
  checkout-hook-created untracked default folder. Git/settings watchers
  reconcile external state and retire sessions whose semantic territory is
  stale.
- The macOS ACL fence now walks the real Design tree—root, all directories, and
  all existing tracked, untracked, and ignored entries—and is reapplied after a
  new frame/directory or serialized Git/Design operation. It is explicitly
  defense in depth, not the code-agent security promise.
- A named release gate runs provider posture/admission/lifecycle tests on Linux
  and macOS, the real Codex filesystem attack matrix on both, the real Claude
  built-in Write/Edit denials against a local mock inference endpoint, the real
  Claude sandbox filesystem attack matrix, and the macOS ACL attack matrix. It
  covers overwrite, append, truncation, nested/ignored creation, rename/atomic
  replacement, symlink, hard-link, policy, Git metadata, and generic Git
  attempts without requiring external model traffic.

### Intentionally deferred until there is a real consumer

- A design agent, design-agent spawning, and the code-to-design
  `design.explore` orchestration API.
- Durable WorkOrder/run/outbox infrastructure, distributed revisions, leases,
  and events beyond today's concrete SQLite/Git/Design mutation lanes.
- A general `ExecutionProvider`, private cloud/local worker overlays, and the
  full ChangeSet integration broker.
- Exploration-session and content-addressed artifact services beyond today's
  deterministic human-canvas render/export contracts.
- Daytona qualification, cloud secret brokerage, crash-resumable distributed
  orchestration, and shared-volume collision testing.
- GitLab, Bitbucket, and Origin forge implementations.
- A design-agent capability that mounts code read-only and exposes Design
  mutation only through an authorized typed API.

### Honest product promise today

For a workspace with a recognized Design territory, a Zeros-launched code agent
cannot mutate that territory through shell, patch, editor, built-in file tools,
or generic Git while running on a qualified pinned Codex/Claude runtime and
supported OS. Startup or authority transition fails closed when Zeros cannot
establish or retire that boundary. This claim excludes kernel/provider sandbox
vulnerabilities, root/administrator compromise, and separate trusted human
processes running as the application user. Those human terminals/editors receive
only broker checks plus the removable macOS ACL guard. For Claude, "qualified"
also means every absolute denied path is representable literally by the current
provider matcher and the effective administrator policy does not override the
qualified boundary; unusual paths or incompatible policy are refused at
admission instead of receiving a weaker promise. A root/MDM administrator is
outside this same-user agent guarantee.

A directory name is not yet a semantic Design resource. Before a committed
document marker or Zeros' controlled initialization exists, an ordinary
repository remains an ordinary code workspace. One conservative bootstrap rule
applies: if the configured/default `Zeros Design/` destination already exists,
agent admission treats that real subtree as prospective read-only territory so
untracked checkout-hook seeds and drafts cannot be modified during the
recognition gap. It is not exposed as a Design document until initialization.
If the destination did not exist when a code session was admitted, Zeros'
first-Design transition retires that pre-boundary session before creating,
recognizing, or committing it.

The guarantee is tested on Linux and macOS. Daytona is not qualified and must
not inherit the claim until the same provider-specific release matrix passes in
its real sandbox environment.

## Verdict

The following principles are the correct scaling foundations:

1. Separate presentation mode, agent behavior, and write authority.
2. Make the Design API the exclusive design-agent mutation path.
3. Introduce one logical workspace mutation coordinator with durable revisions
   and events.
4. Treat the canonical workspace as semantic identity while allowing isolated
   physical overlays for workers.
5. Add real containment tests on macOS and Linux/Daytona, including untracked
   file creation and concurrent Git/design operations.
6. Keep ACLs only as defense in depth, never as the promised guarantee.

Two qualifications are essential:

1. Use one **logical canonical-mutation coordinator per workspace**, not one
   global mutex that serializes every read, render, test, or exploration.
2. Use Git as the universal **change-isolation and integration substrate**, not
   as the security sandbox.

The product can support seamless code-to-design autonomous work across local
machines, Daytona, future sandbox providers, GitHub, GitLab, Bitbucket, and
eventually Origin. It will not get there safely by adding only "switch mode" and
"spawn design agent" APIs. It also needs durable orchestration, true process
containment, capability enforcement, immutable artifacts, and a canonical
integration broker.

## What the repository already gets right

Zeros is not starting from zero:

- [Design Foundation 1.0](design-foundation-1.0.md) already defines versioned
  transactions, stable IDs, exact base revisions, atomic batches, receipts,
  idempotency, and Git as the checkpoint boundary.
- The shared Design API already performs revision checks, per-document
  serialization, repository compare-and-swap, and reconciliation.
- Git turn handling already uses scratch indexes, hidden refs, whole-tree
  snapshots, actual-diff attribution, and blob-level conflict detection.
- The [cloud architecture](cloud-workspace/architecture.md) and
  [data/synchronization contract](cloud-workspace/data-and-sync.md) already
  specify stable workspace identity, provider-neutral placement, revisions,
  idempotency, and disposable execution environments.

The important remaining gaps are the intentionally deferred autonomous and
cloud layers: durable cross-process orchestration, design-agent capabilities,
private execution overlays and ChangeSet integration, artifact/exploration
storage, provider qualification for Daytona, and non-GitHub forge adapters.
Today's in-memory Design write lane is correct for the one desktop engine
process; it must be replaced or wrapped by durable coordination before multiple
engines may mutate the same semantic document.

## Permanent identity separation

These concepts must never be interchangeable:

| Concept                   | Owner               | Meaning                                                      | Security authority                                    |
| ------------------------- | ------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| **viewMode**              | Client/session      | What the user is viewing: code, design, or split             | None                                                  |
| **AgentRole**             | Work order/run      | Coding, designing, reviewing, rendering, or testing behavior | Selects prompts and default tools, but grants nothing |
| **CapabilityGrant**       | Policy/orchestrator | Exact resources and operations a run may use                 | Yes                                                   |
| **WorkspaceId**           | Control plane       | Stable semantic workspace identity                           | Authorization/resource boundary                       |
| **WorkspaceGenerationId** | Execution plane     | Current physical machine or sandbox incarnation              | Fencing/lifecycle boundary                            |
| **AgentRunId**            | Orchestrator        | One isolated attempt or child task                           | Audit, budget, and artifact owner                     |

Keep serialized **kind** compatibility during migration, but stop using it for
authorization. A user may view Design while a code agent works. A code agent
may invoke a design specialist while the client stays in Code. No autonomous
workflow should require a global UI mode transition.

## Target architecture

```text
Desktop / Web / Mobile clients
          |
          | UI state: viewMode only
          v
Parent agent / conversation manager
          |
          | structured WorkOrder
          v
Durable Run Orchestrator ------------ Event stream / audit / budgets
          |
          +-- Capability service
          |
          +-- ExecutionProvider
          |      +-- local isolated run
          |      +-- Linux/container run
          |      +-- Daytona sandbox/fork
          |      +-- future provider
          |
          +-- Design Mutation Service
          |      +-- per-document revision/CAS lane
          |
          +-- Artifact and Exploration Service
          |      +-- images, variants, reports, provenance
          |
          +-- Workspace Integration Coordinator
                 +-- validate ChangeSet
                 +-- CAS-advance canonical Git ref
                 +-- ForgeAdapter
                        +-- GitHub
                        +-- GitLab
                        +-- Bitbucket
                        +-- future Origin
```

Agents communicate through structured, durable objects:

- Work orders
- Events
- Design transactions
- Git change sets
- Artifact references
- Structured completion results

They do not coordinate by concurrently mutating the same canonical directory.
This is what lets local and cloud execution expose the same product behavior.

## Canonical mutation protocol

Every write-capable command should eventually carry an envelope equivalent to:

```ts
interface WorkspaceCommand {
  commandId: string;
  idempotencyKey: string;

  workspaceId: string;
  generationId: string;
  engineEpoch: number;

  actorId: string;
  runId?: string;
  capabilityGrantId: string;

  expectedWorkspaceRevision: number;
  expectedGitHead?: GitObjectId;
  expectedDesignRevision?: string;

  operation: VersionedOperation;
}
```

The coordinator:

1. Validates workspace, generation, engine epoch, actor, and capability.
2. Rejects reuse of an idempotency key with different canonical content.
3. Validates the exact expected resource revisions.
4. Executes or dispatches the mutation.
5. Atomically records materialized state and its event/outbox record where the
   storage boundary permits.
6. Publishes durable events using an outbox.
7. Returns a durable receipt.

Retries are at-least-once. Effects become retry-safe through idempotency and
compare-and-swap. The system must not claim distributed exactly-once effects
across SQLite/PostgreSQL, Git, object storage, sandbox providers, and forge
APIs. Caller-supplied idempotency identity is the established safe-retry model.
[AWS Builders' Library](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)

### Concurrency lanes

Use one logical workspace coordinator while preserving independent lanes:

- One serialized lane for canonical Git-head advancement.
- One serialized lane per design document.
- One lifecycle lane for start, stop, archive, restore, and delete.
- Concurrent reads.
- Concurrent rendering and validation.
- Concurrent tests.
- Concurrent design explorations, each in its own namespace.

This preserves correctness without making the workspace a bottleneck.
Workspaces naturally shard by **WorkspaceId**. A lease plus a monotonic
**engineEpoch** fencing token prevents an old engine from writing after a
replacement takes ownership.

## Git's exact responsibility

Git supplies universal change isolation:

- Exact base identity.
- Immutable trees and commits.
- Portable diffs, packs, and bundles.
- Merge and rebase semantics.
- Independence from the hosting forge.

Linked worktrees separate **HEAD**, the index, and working files, but they share
the object store, ordinary refs, and most repository configuration. They prevent
normal checkout collisions; they are not a hostile-process security boundary.
[Git worktree documentation](https://git-scm.com/docs/git-worktree)

The worker lifecycle is:

1. Resolve an exact base commit/tree.
2. Create a detached per-run worktree, independent clone, overlay, or provider
   snapshot.
3. Give the worker no authority to update the canonical branch.
4. Let it produce a result tree or commit.
5. Package the result as a **ChangeSet**, optionally using a Git bundle or pack
   for remote transport.
   [Git bundle documentation](https://git-scm.com/docs/git-bundle)
6. Import it through the integration broker.
7. Recompute the actual diff rather than trusting claimed paths.
8. Validate paths, modes, symlinks, submodules, size limits, secrets, territory,
   and capability policy.
9. Run the required checks.
10. Advance the canonical ref with an expected-old-object compare-and-swap using
    Git's ref transaction mechanisms.
    [Git update-ref documentation](https://git-scm.com/docs/git-update-ref)
11. Push with an exact expected lease if a ref rewrite is required; never use a
    generic force push.

Workers do not receive forge credentials and do not push directly.

### Forge neutrality

Keep repository mechanics separate from hosted review metadata:

```ts
interface GitRepositoryAdapter {
  resolveRevision(...): Promise<GitObjectId>;
  fetchObjects(...): Promise<void>;
  importChangeSet(...): Promise<void>;
  integrateWithCas(...): Promise<IntegrationReceipt>;
  pushWithLease(...): Promise<void>;
}

interface ForgeAdapter {
  authorizeRepository(...): Promise<RepositoryGrant>;
  createChangeRequest(...): Promise<ChangeRequest>;
  updateChangeRequest(...): Promise<void>;
  readReviewsAndChecks(...): Promise<ReviewState>;
}
```

GitHub pull requests, GitLab merge requests, and Bitbucket pull requests are
different metadata systems layered on Git.
[GitHub](https://docs.github.com/en/rest/pulls/pulls),
[GitLab](https://docs.gitlab.com/api/merge_requests/), and
[Bitbucket](https://developer.atlassian.com/cloud/bitbucket/rest/) therefore
belong behind adapters.

Only the GitHub adapter exists today. That is correct. Keep the internal
boundary neutral, but do not implement GitLab or Bitbucket until each becomes a
real product requirement. Cursor currently publishes only a high-level Origin
description and waitlist, not an integration contract. Add an Origin adapter
only after a stable API exists. [Cursor Origin](https://cursor.com/origin)

Represent Git object IDs as an algorithm plus hexadecimal value, not as an
assumed 40-character SHA-1 string.

## Design API as the agent mutation boundary

Two similarly named boundaries serve different jobs:

- The **Design Document API** is the semantic transaction kernel. Today's
  trusted human canvas calls it in-process. A future design actor may call it
  only through an authenticated capability-bearing adapter.
- The future **Design Orchestration API** is the parent-agent surface:
  `design.explore`, status, cancellation, artifact retrieval, and promotion
  requests. It spawns a separately contained design run; it never turns raw
  file editing into a code-agent tool.

Neither an orchestration API nor a design agent is wired to coding agents
today. This is deliberate: exposing a premature file-editing endpoint would
collapse the boundary this architecture is meant to establish.

For autonomous workers, the rule is absolute:

> A design agent never writes canonical HTML or CSS through filesystem, shell,
> patch, editor, or generic Git tools.

A design agent receives bounded operations such as:

- Read a document projection.
- Inspect nodes, styles, components, parameters, and variants.
- Fork a draft.
- Apply a typed transaction.
- Validate a draft.
- Render and export artifacts.
- Request promotion.

The desktop canvas, headless workers, CI, and future agents use the same
semantic transaction kernel. MCP, HTTP, local IPC, or another protocol is an
adapter; none becomes the document model.

For an agent-facing endpoint:

- Authorization is mandatory and fails closed.
- Every request includes an **ActorContext** and **CapabilityGrant**.
- Raw source splice remains denied unless a separately reviewed capability
  explicitly permits it.
- Undo and redo are authorized operations.
- Every mutation carries an exact base revision.
- Sessions are caches; the durable repository and revision are authoritative.
- In-memory queues may optimize execution but cannot supply correctness.

Upstream Git operations can introduce design-source changes. The Design service
imports those as external revisions and reconciles them; they are not a
design-agent mutation bypass.

## Capabilities, not roles

Use short-lived, revocable, workspace/run-bound capability grants. Child runs
may receive attenuated grants but can never widen them.

An eventual design exploration grant might be:

```text
subject: run/design-123
workspace: ws-42
generation: gen-8
actions:
  - design.read
  - design.draft.apply
  - design.render
  - artifact.publish
documents:
  - frame/home
network:
  - none
secrets:
  - none
limits:
  variants: 3
  childDepth: 0
  duration: 15m
  artifactBytes: 100MB
```

This follows attenuated capability design: delegated credentials can narrow who,
where, when, and for what purpose a request is valid.
[Google Macaroons research](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/)

Enforce authorization at every privileged service boundary. Model or SDK
guardrails are not containment; OpenAI documents that its tool-guardrail
pipeline does not wrap built-in shell, patch, local-shell, computer-use, and
several hosted tools.
[OpenAI guardrails](https://openai.github.io/openai-agents-python/guardrails/)

Use four layers:

1. API authorization and capability checks.
2. OS, container, or VM containment.
3. Change-set validation before integration.
4. ACLs as accidental-write defense only.

## Real containment

A process running as the application user can generally undo restrictions that
the same user owns. Actor-specific guarantees therefore require a distinct OS
security principal or a kernel-enforced sandbox.

### macOS

Today's pinned Codex runtime compiles the exact permission profile to Seatbelt,
and Claude strict sandbox uses its supported macOS sandbox primitive. Zeros runs
the real Codex attack matrix and provider host/startup probes on macOS release
CI. The same profile is immutable across permission modes, and Zeros refuses an
unqualified provider executable.

Apple describes App Sandbox as a kernel-enforced containment mechanism for
filesystem, network, and other resources.
[Apple App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox)

The current provider sandboxes are sufficient for the scoped code-agent Design
promise. A signed helper/XPC worker or lightweight VM remains an optional future
direction if Zeros must contain arbitrary third-party executables that cannot be
qualified through their provider runtime. Do not claim that broader boundary
before a signed prototype and attack suite prove it.

Keep two honest guarantee levels:

- **Guarded:** broker checks, worktree isolation, integration validation, and
  ACL defense.
- **Contained:** tested kernel, container, or VM isolation.

### Linux

Today's pinned Codex and Claude provider sandboxes supply the local
code-agent path restriction; Linux CI executes both providers' real sandbox
attack matrices plus Claude's real built-in Write/Edit denial test. The provider
process tree is terminated and verified before authority changes.

For future arbitrary workers and cloud execution, use a non-root execution user
plus:

- A mount namespace with canonical source mounted read-only.
- A per-run writable overlay.
- User, PID, and network namespaces.
- Seccomp.
- Cgroups and resource limits.
- Landlock as an additional filesystem and network restriction.

Landlock can be used by unprivileged processes, stacks with existing controls,
and is inherited by descendants.
[Linux kernel documentation](https://cdn.kernel.org/doc/html/latest/userspace-api/landlock.html)

### Daytona and future cloud providers

Create or fork an isolated sandbox per mutating worker. Daytona supplies
isolated runtime environments plus snapshots and forks suitable for identical
starting points.
[Daytona sandboxes](https://www.daytona.io/docs/sandboxes) and
[persistence/forks](https://www.daytona.io/docs/en/persistence/)

Never mount one canonical read-write volume into multiple workers. Daytona
documents that shared FUSE volumes are non-transactional and concurrent writes
to one path are last-write-wins.
[Daytona volumes](https://www.daytona.io/docs/en/volumes/)

Use shared volumes or object storage for immutable or independently namespaced
artifacts and caches. Use per-run or per-tenant subpaths. Prefer opaque secret
handles and destination-scoped proxy injection over plaintext secrets inside a
sandbox.
[Daytona secrets](https://www.daytona.io/docs/en/secrets/)

## Design exploration and temporary files

**.gitignore is not authorization, isolation, retention, or provenance.**

Model exploration as a first-class **ExplorationSession**:

- Stable exploration and variant IDs.
- Exact source Git object ID and design revision.
- A separate mutable draft repository or namespace per variant.
- Immutable rendered artifacts.
- TTL, byte quota, and pinning.
- A lifecycle of **run-temp**, **workspace-draft**, **review**, or
  **repository**.
- Promotion receipts and provenance.

Locally, an exploration may be materialized under a gitignored directory for
inspection, but that directory is a cache rather than the source of truth.
Authoritative metadata belongs in SQLite and artifact content in a
content-addressed store. In cloud execution, use object storage or a run-specific
volume subpath.

Promotion is explicit:

```text
Exploration variant
    -> validate candidate transaction
    -> compare exact current design revision
    -> apply through Design API
    -> create ChangeSet
    -> integrate through Git broker
```

A stale base causes a conflict and rebase/replan/regeneration. It never silently
overwrites canonical work.

## Visual-first artifact model

Agents return artifact references rather than local paths or large image bytes
copied into conversation history.

An **ArtifactRef** includes:

- Content digest.
- Media type and dimensions.
- Artifact role: preview, thumbnail, design option, diff, or report.
- Workspace, run, exploration, and variant IDs.
- Git base and result object IDs.
- Design document revision and transaction IDs.
- Renderer and browser build.
- Viewport, device pixel ratio, theme, locale, and timezone.
- Font bundle.
- Creation time, retention class, and access policy.

This is visual build provenance: verifiable information describing where, when,
and how an artifact was produced.
[SLSA provenance](https://slsa.dev/spec/v1.2/provenance)

Rendering pins browser version, fonts, viewport, device scale, color scheme,
locale, and timezone; freezes time and animation where practical; and disables
undeclared network access. Screenshots then become reproducible review
artifacts, not anonymous PNG files.

## Intended autonomous code-to-design workflow

The code agent remains the conversation manager. It invokes a design specialist
for a bounded task instead of transferring the entire user conversation or
changing a global workspace mode. This corresponds to the manager/agent-as-tool
orchestration pattern.
[OpenAI agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)

The eventual flow is:

1. The user asks the code agent to explore a UI.
2. The code agent invokes **design.explore**.
3. The orchestrator stores a **WorkOrder** with the objective, exact Git base,
   exact design revision, expected artifacts, rubric, and budget.
4. It creates a child **AgentRun** with an attenuated design capability.
5. The execution provider creates an isolated run from the exact snapshot.
6. Variants are created in separate draft namespaces.
7. Each variant changes its draft only through Design API transactions.
8. A deterministic renderer exports images and supporting reports.
9. An evaluator scores the options against the work-order rubric.
10. Artifact references and structured summaries return to the parent.
11. The client may display Design, but that is only a client-local **viewMode**
    change.
12. The user or parent selects an option.
13. Promotion applies the candidate through Design API against the current exact
    revision.
14. The Git broker validates and integrates its ChangeSet.
15. The parent reports the visual result and resulting revisions.

The orchestration remains the same whether the worker runs locally, in Daytona,
or through another provider.

## Durable orchestration

Do not build a distributed workflow engine from scratch.

For local desktop work:

- Use SQLite for commands, runs, events, receipts, grants, outbox records, and
  artifact metadata.
- Recover unfinished work on boot.
- Keep Git objects and artifact blobs outside database rows.

For cloud work:

- Use PostgreSQL for workspace and control-plane state.
- Use object storage for artifact content.
- Put long-running agent workflows behind an internal **WorkflowRuntime** port.
- Evaluate durable runtimes with crash, retry, cancellation, and version-upgrade
  tests before adopting one.

Restate is a strong conceptual candidate because keyed virtual objects provide
one writer per key with concurrent readers, which maps naturally to a
**WorkspaceId**, while workflows map to a **RunId**.
[Restate services](https://docs.restate.dev/foundations/services)

Temporal is the conservative mature alternative; its workflow event history
supports deterministic replay and recovery after infrastructure failure.
[Temporal workflows](https://docs.temporal.io/workflows)

No cloud workflow runtime is needed merely to improve today's local product.
The durable command, event, idempotency, and CAS contracts come first; the cloud
runtime later implements those contracts.

## Scaling efficiently

Do not spawn multiple agents for every task. Use the lowest orchestration
complexity that reliably solves the problem, and avoid concurrent workers that
must contend on mutable shared state.
[Microsoft agent orchestration patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)

Anthropic reports substantially higher token usage for multi-agent research and
notes that tightly dependent shared-state work is a weaker fit. It also
recommends external artifacts with lightweight references back to the
coordinator.
[Anthropic multi-agent engineering](https://www.anthropic.com/engineering/multi-agent-research-system)

Therefore:

- Default to one agent with tools.
- Spawn specialists for real domain, tool, context, or security separation.
- Parallelize independent visual alternatives.
- Bound fan-out, child depth, iterations, time, tokens, compute, and artifact
  bytes.
- Cache immutable repository snapshots, dependency layers, and deterministic
  renders by digest.
- Apply user, organization, workspace, and provider quotas.
- Record latency, cost, retries, conflicts, containment violations, and
  acceptance rate per workflow.
- Evaluate final environment state, not only the agent's final message.
  [Anthropic agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

## How the roadmap works with today's product

The roadmap contains Phase 0 plus eight delivery phases. They are all part of
the foundational architecture, but they are not a command to build every future
system now.

The engineering rule is:

> Establish today's necessary semantic boundary, implement it behind the
> current local/GitHub path, and activate additional implementations only when a
> real feature consumes them.

| Stage   | What ships for today's local/GitHub product                                                                                           | What remains dormant until needed                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Phase 0 | Implemented for today's qualified promise: honest threat model, fail-closed admission, real filesystem attacks, Linux/macOS gates     | Add each future provider/account boundary only when supported                                                              |
| Phase 1 | Partially implemented: canonical **viewMode**, legacy `kind` mirror, explicit code role/write territory, trusted human Design context | Design-agent ActorContext/grants, attenuation, and delegation wait for the agent                                           |
| Phase 2 | Existing SQLite/Git/Design mutation lanes and revisions are used by concrete paths; speculative coordinator modules were removed      | Durable WorkOrder journal, outbox, epochs, and distributed leases wait for a multi-engine consumer                         |
| Phase 3 | Implemented minimum: provider-enforced canonical subtree carve-out, process-tree retirement, Git metadata read-only                   | Private overlays, general `ExecutionProvider`, ChangeSets, and brokered autonomous Git wait for local/cloud execution work |
| Phase 4 | Existing human Design rendering/export and deterministic protocol checks remain active                                                | Exploration sessions, content-addressed artifact storage, TTL/promotion wait for design exploration                        |
| Phase 5 | Not implemented by design                                                                                                             | Build the first `design.explore` vertical slice only when a real design agent ships                                        |
| Phase 6 | Not implemented; only stable semantic boundaries are documented                                                                       | Daytona, durable cloud runs, secret broker, reconnect/recovery, PostgreSQL/object storage                                  |
| Phase 7 | Git mechanics are separated from the current GitHub consumer                                                                          | GitLab, Bitbucket, and Origin adapters are added only on demand                                                            |
| Phase 8 | Partially active now: named containment/lifecycle gates on Linux and macOS, including real pinned-provider attacks                    | Daytona, distributed crash/duplicate-delivery, scale, cost, and visual-quality gates activate with those systems           |

### Seamless compatibility during implementation

The user-visible workspace stays one workspace throughout the migration:

- Existing local workspace creation, terminals, code agents, GitHub publishing,
  and human Design editing continue to work.
- Repositories with no recognized Design document retain their ordinary agent
  and Git behavior unless the prospective configured/default Design destination
  already exists, in which case it is conservatively protected. In a
  Design-bearing workspace, code edits remain direct and fast, but a contained
  agent cannot mutate the canonical Git index; Zeros-owned Git commands perform
  integration until private ChangeSets ship.
- **viewMode** changes presentation only; it never waits for an agent, sandbox,
  or network service.
- The existing human Design surface continues using the trusted in-process
  Design API. It does not need a fake agent, cloud transport, or capability
  token round trip.
- New durable commands first wrap existing behavior. They do not introduce a
  second source of truth.
- Event recording may begin in shadow/audit mode, but authority moves one
  mutation family at a time only after parity and crash tests pass.
- Local agent isolation is an implementation detail behind the semantic
  workspace. Today that is a qualified provider profile over the canonical
  checkout; a future worker may receive an overlay while the UI continues to
  display one workspace and one coherent Changes view.
- A contained code session does not accept provider `/add-dir` roots. Future
  cross-workspace context must be exposed as an explicit read-only capability
  or snapshot, with alias validation and lifecycle ownership, rather than as a
  second writable working directory.
- Design-bearing sessions use one canonical physical workspace spelling and
  drop provider launch-path/wrapper overrides and generic startup-injection
  variables. This keeps admission policy and runtime policy keyed to the same
  paths; ordinary code-only sessions retain today's symlink/add-directory/env
  compatibility.
- Future APIs and providers implement the same commands, revisions, ChangeSets,
  artifacts, and receipts; they do not introduce a second workspace model.
- Feature flags hide future design-agent and cloud surfaces until their complete
  end-to-end path meets its exit criteria.

No recursive filesystem scan runs on canvas gestures, rendering, ordinary
source saves, or editor updates. Territory enumeration runs at agent admission
and serialized Design/Git/lifecycle boundaries only. This is how the
architecture stays seamless today while preserving a path to durable,
provider-neutral execution.

## Implementation sequence

### Phase 0 — Guarantees and adversarial tests

- Write ADRs for identity, mutation authority, Git isolation, capabilities,
  artifact lifecycle, failure semantics, and guarantee levels.
- Correct documentation or UI language that implies ACLs provide strong
  containment.
- First add a failing real-process regression test where a code worker creates
  an untracked file inside the design directory.
- Add tracked write, delete, rename, symlink, hardlink, and ACL-removal attacks.

**Exit:** Every advertised containment guarantee has an executable test.

**Checkpoint:** Met for the current local pinned Codex/Claude code-agent
promise on qualified hosts and paths. Claude paths that cannot be represented
literally by its current rule matcher, workspace/cwd aliases, and Claude managed
policy that can weaken or replace the qualified profile fail admission. The gate
must expand before any new provider or cloud environment may inherit the claim.

### Phase 1 — Split identity and authority

- Introduce **viewMode**, **AgentRole**, **ActorContext**, and
  **CapabilityGrant** at the owning app boundary.
- Preserve **kind** compatibility through an explicit migration plan.
- Keep trusted human in-process Design calls explicit.
- Make all future agent-facing Design API adapters fail closed.
- Add capability attenuation, revocation, and view-mode independence tests.

No design agent is required. Today this phase fixes the domain model and removes
the possibility that UI state accidentally becomes authority.

**Exit:** Presentation state has no effect on authorization.

**Checkpoint:** Met for today's human and code actors. Design-agent grants and
delegation remain deferred because no design agent exists.

### Phase 2 — Canonical mutation coordinator

- Add the workspace command envelope, local durable journal, receipts, and
  event/outbox model.
- Route mutation families through the coordinator incrementally, beginning with
  the highest-risk shared boundaries: Design commits and canonical Git-ref
  advancement.
- Add workspace and resource revisions, idempotency keys, leases, and engine
  epochs where their current consumer exists.
- Replace correctness dependence on in-memory queues.

Do not rewrite every filesystem read or ordinary UI action. Reads and local
presentation state do not belong in the mutation lane.

**Exit:** Killing and retrying at every migrated command boundary produces one
valid result.

**Checkpoint:** Not complete. Current single-engine Design and Git mutation
lanes are the precise implementation needed today; durable multi-engine
journaling/outbox work begins with its first real consumer.

### Phase 3 — ExecutionProvider and Git ChangeSets

- Define provider-neutral snapshot, create, inspect, execute, collect, cancel,
  and destroy semantics.
- Implement the local provider first using the safest viable worktree, clone,
  overlay, and OS containment combination.
- Introduce **ChangeSet**, actual-diff verification, and Git CAS integration.
- Keep worker refs under a Zeros-owned run namespace.
- Add Linux and Daytona implementations only with their real execution
  milestones.

The first local slice may harden existing code-agent turns before any design
agent exists. The UI still presents one workspace; isolation occurs below the
product surface.

**Exit:** A migrated worker cannot directly mutate the canonical checkout or
canonical branch.

**Checkpoint:** The narrower current need is complete: a code agent cannot
mutate recognized Design territory or canonical Git metadata. Private overlays,
ChangeSets, and autonomous branch integration remain future work.

### Phase 4 — Exploration and artifact services

- Add content-addressed artifact storage and provenance.
- Add deterministic screenshot/export identities for today's human Design
  workflow.
- Add draft repositories and **ExplorationSession** only when an exploration
  consumer is introduced.
- Add TTL, pin, promote, and delete semantics.
- Build deterministic rendering and visual-diff reports.

**Exit:** An exploration can survive worker termination and be promoted
reproducibly; today's exported visuals have stable provenance.

**Checkpoint:** Future. Do not add a generic artifact service until
`design.explore` or another durable artifact consumer exists.

### Phase 5 — First autonomous vertical slice

Implement one complete local feature:

```text
code parent
-> design.explore
-> isolated design child
-> bounded variants
-> image artifacts
-> structured result to parent
-> selection
-> revision-safe promotion
-> Git integration
```

This phase begins only when the Design API tool surface and design agent become
real product work. Do not create a fake agent endpoint earlier merely to claim
the architecture exists. Build this vertical slice before general multi-agent
fan-out.

**Exit:** The scenario works without an agent writing canonical design files
directly.

**Checkpoint:** Future; no code-agent Design orchestration endpoint is exposed.

### Phase 6 — Durable cloud execution

- Add control-plane records for workspace generations, engine lease/epoch,
  runs, grants, events/outbox, artifacts, provider binding, and forge binding.
- Implement restart, reconnect, cancel, resume, archive, restore, and deletion.
- Evaluate durable workflow runtimes using the real failure model, then adopt
  one behind **WorkflowRuntime**.
- Treat provider snapshots as accelerators, never the sole durable copy.
- Implement Daytona through **ExecutionProvider**, without leaking Daytona
  identifiers into public workspace identity.

**Exit:** A sandbox can be destroyed mid-workflow, recreated, and resumed from
durable state.

**Checkpoint:** Future. Daytona is explicitly unqualified today.

### Phase 7 — Forge adapters

- Keep raw Git transport and integration separate from hosted review APIs.
- Keep GitHub as the only production adapter today.
- Add a forge contract test suite around the internal **ChangeRequest** model.
- Add GitLab and Bitbucket only when supported product work begins.
- Add Origin only after a real published API contract exists.

**Exit:** The same internal change-request workflow passes against every
supported forge without changing workspace or ChangeSet identity.

**Checkpoint:** GitHub only. Forge-neutral seams exist where the current GitHub
consumer needs them; no placeholder GitLab/Bitbucket/Origin clients are built.

### Phase 8 — Scale and release gates

- Run real macOS and Linux containment CI.
- Run private Daytona provider validation.
- Add crash injection and duplicate-delivery tests.
- Add concurrent Git/design integration tests.
- Add multi-client revision-gap and stale-engine tests.
- Enforce cost, time, fan-out, and artifact budgets.
- Add deterministic-render and visual-quality evaluations.
- Test audit redaction and secret-exfiltration resistance.

These gates accumulate throughout Phases 0–7; Phase 8 is where the complete
system must pass them for broad release.

**Checkpoint:** Linux/macOS containment and current lifecycle gates are active.
The Claude gate exercises both the pinned runtime's built-in Write/Edit path
rules and its production command sandbox against a local deterministic model
endpoint. Distributed, Daytona, budget, and design-agent evaluation gates wait
for the systems they must test.

## Required containment and concurrency matrix

At minimum, test:

- Creation of a new untracked file in forbidden territory.
- Replacement through rename.
- Symlink traversal in both directions.
- Directory deletion and recreation.
- File descriptors opened before policy activation.
- Submodule and nested-repository behavior.
- Case-insensitive path collisions on macOS.
- Provider path-rule metacharacters and literal-encoding refusal.
- Workspace/cwd symlink aliases and provider launch-path overrides.
- Managed-provider policy that disables isolation, ignores flag permission
  rules, adds write roots/sockets, or executes helpers/hooks/plugins.
- Concurrent code and design runs from the same base.
- Concurrent changes to the same design document.
- Concurrent changes to different design documents.
- Git staging while a Design transaction commits.
- External branch movement during a design run.
- Duplicate commands and events.
- A stale engine epoch after a network partition.
- Worker death after artifact upload but before its completion event.
- Worker death after Git object import but before ref advancement.
- Provider reconnect, archive, restore, and deletion.
- Shared-volume collision attempts on Daytona.
- Attempts to widen child capabilities or exfiltrate secrets.

For canonical state, one competing integration wins by compare-and-swap. The
loser receives a structured conflict and may rebase or replan. Canonical
last-write-wins behavior is forbidden.

## Repository implementation ownership

Follow [RULES.md](../RULES.md): create shared packages and new deployables only
after a real cross-process or deployment boundary exists.

Likely ownership, introduced only with real callers:

- **apps/desktop/src/engine/orchestration/** — local command journal, runs,
  receipts, events, recovery, and the local workflow-runtime implementation.
- **apps/desktop/src/engine/policy/** — actor contexts and local capability
  enforcement.
- **apps/desktop/src/engine/execution/** — local and remote
  **ExecutionProvider** implementations.
- **apps/desktop/src/engine/git/** — repository adapter, ChangeSets, validation,
  and integration coordinator.
- **apps/desktop/src/engine/design/** — trusted human adapter, future agent
  tools, exploration, and promotion.
- **apps/desktop/src/engine/artifacts/** — local artifact content and metadata.
- **apps/control-plane/** — cloud workspace registry, lifecycle,
  authorization, durable records, audit, provider orchestration, and quotas.
- **packages/protocol/** — only stable schemas that genuinely cross a process or
  deploy boundary.
- **packages/design-core/** and **packages/design-web/** — existing semantic
  Design contracts, independent of Electron, cloud vendors, or agent SDKs.
- **scripts/cloud-workspace-validation/** — real provider containment,
  lifecycle, concurrency, and recovery validation.

Do not create placeholder packages or empty future applications.

## Decisions explicitly deferred

The foundation deliberately does not decide:

- Which model provider powers a future design agent.
- Whether the cloud durable runtime is Restate, Temporal, or another evaluated
  implementation.
- Whether future arbitrary, unqualified macOS-agent containment uses a signed
  helper, XPC topology, or VM; today's qualified provider runtimes use their
  tested OS sandbox paths.
- How an unpublished forge such as Origin authenticates or represents reviews.
- Whether future real-time human collaboration needs a CRDT.

These are implementation decisions behind stable boundaries. Deferring them
prevents vendor assumptions from contaminating workspace, run, transaction,
ChangeSet, and artifact identity.

## Final architectural rules

Build Zeros as a **transaction-and-artifact operating system for autonomous
work**, not as two modes sharing one mutable folder.

- One semantic workspace identity.
- Many disposable isolated execution overlays.
- UI mode has no authority.
- Roles describe behavior; capabilities authorize operations.
- The typed Design Document API is the exclusive design-agent mutation path;
  the future Design Orchestration API only requests work and returns status or
  artifacts.
- Git carries exact change sets; it does not provide security containment.
- One logical coordinator controls canonical integration.
- Revisions, idempotency, receipts, and events make retries safe.
- Images and visual results are first-class provenance-bearing artifacts.
- Temporary exploration is workspace-scoped but outside canonical repository
  state until explicitly promoted.
- Execution providers and Git forges are replaceable adapters.
- ACLs remain useful, honest defense in depth.
- Today's local and GitHub paths remain the active implementations until a real
  feature activates another adapter.

With these contracts, local and cloud execution can feel like one seamless
workspace even while workers are strongly isolated. Without them, autonomous
spawning would amplify filesystem races, stale revisions, ambiguous ownership,
and containment gaps.
