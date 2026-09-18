# Engineering documentation

Use this index to find the guide that owns a behavior. These documents explain
how the code works, why a boundary exists, and what must remain compatible.
Code, schemas, migrations, tests, and repository rules remain authoritative.
A roadmap item or local test result is not evidence that a feature is released.

## Start here

| Reference                                                       | Purpose                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Repository architecture](../REPOSITORY-ARCHITECTURE.md)        | App/package ownership, deployment boundaries, persisted compatibility and where new code belongs |
| [Repository rules](../RULES.md)                                 | Required engineering, UI, security and verification standards                                    |
| [Agent guide](../AGENTS.md)                                     | Coding-agent workflow, implementation invariants and checks                                      |
| [Contributing](../CONTRIBUTING.md)                              | Development setup and contribution workflow                                                      |
| [UI interaction and performance](ui-interaction-performance.md) | Shared loading, caching, navigation, gesture and retained-surface rules                          |

## Durable feature guides

Keep these synchronized with implementation after features ship. They are the
references to consult before changing their area, not temporary task plans.

| Area                | Owning guide and scope                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design mode         | [Design architecture, implementation and roadmap](design-mode-roadmap.md): the **single Design reference** for shared modes, native HTML/CSS, source formats, API, canvas, Git, migration, limits, qualification and future phases |
| Navigation          | [State persistence](navigation-state-persistence.md): semantic owners, restoration and cleanup; complements the shared UI rules                                                                                                    |
| Git and review      | [Changes and history](changes-history.md): comparisons, file lists/counts, turn/commit identity and refresh                                                                                                                        |
| Workspace lifecycle | [Archive and recovery](workspace-archive-recovery.md): checkpoints, retained data, visibility and restore                                                                                                                          |
| Terminal            | [Terminal workbench](terminal-workbench.md): placement, navigation, setup and shell ownership                                                                                                                                      |
| Settings            | [Personal settings](personal-settings.md): device/repository/workspace scopes, TOML and customization ownership                                                                                                                    |
| Context files       | [Context storage](context-storage.md): attachment persistence, migration, Git sharing and archive recovery                                                                                                                         |
| Attachments         | [Composer attachments](composer-attachments.md): limits, file delivery, draft recovery and native verification                                                                                                                     |
| Mentions            | [Composer file mentions](composer-mentions.md): search visibility, bounds, cache identity and navigation                                                                                                                           |
| Organizations       | [Organizations and teams](organizations-and-teams.md): Personal/tenant/team identity, roles, billing and placement                                                                                                                 |
| Workspace naming    | [Color names](color-names.md): dictionary synchronized with the engine naming implementation                                                                                                                                       |

## Durable agent and integration guides

| Area                          | Owning guide and scope                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-independent behavior | [Harness capability boundary](agent-harness-capability-boundary.md): platform versus provider responsibilities, capability advertisement and failures |
| Conversation/runtime identity | [Agent identity model](agent-identity-model.md): workspace, conversation, execution and native provider bindings                                      |
| Transcript UI                 | [Tool presentation](agent-tool-presentation.md): native event identity, streaming, replay, approvals, steering and Stop                               |
| Accounting                    | [Turn usage](agent-turn-usage.md): token/cost provenance, context-window snapshots and analytics                                                      |
| Accounts                      | [Provider accounts](provider-accounts.md): sign-in, secret ownership, switching and connection status                                                 |
| Extensions                    | [Extension discovery](extension-discovery.md): MCP, skills, provider inventory, authorization and session lifetime                                    |
| Codex adapter                 | [App-server compatibility](codex-app-server-compatibility.md): pinned protocol, classifications, host requests and packaged runtime                   |
| Claude adapter                | [Event coverage](claude-event-coverage.md): installed SDK event inventory and regression obligations; refresh with provider upgrades                  |
| Browser                       | [Browser service](browser-service.md): provider-native integration, identity, hosting, isolation and artifacts                                        |
| Native computer use           | [Computer and browser use](native-computer-use.md): official plugin ownership, host permissions and transcript behavior                               |

## Operations and active programs

Keep operational contracts. Keep unfinished rollout and roadmap material until
its gates are resolved; then fold lasting decisions into the owning guide and
remove obsolete task lists. Do not delete an active security decision merely
because it is dated or unqualified.

| Reference                                                                               | Retention and purpose                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Development restarts](development-restarts.md)                                         | Durable runbook for dev reloaders, production crash recovery, active-turn protection and synced checkouts                                                               |
| [Deployment environments](deployment-environments.md)                                   | Durable topology, isolation, promotion and release operations; retire one-time rollout sections once completed                                                          |
| [WorkOS architecture and rollout](workos-authentication-migration.md)                   | Active migration/qualification plus lasting identity, session and authentication contracts; retain those contracts when retiring the rollout checklist                  |
| [Cloud workspaces index](cloud-workspace/README.md)                                     | Product, architecture, data/sync, security, operations, enterprise and engineering references; its roadmap and root-coordinator decision have separate completion gates |
| [Agent capability roadmap](agent-capabilities-parity-and-ui-consolidated-2026-07-01.md) | Active provider/product backlog; keep until remaining items are implemented, rejected or moved to an owned plan                                                         |
| [Design future phases](design-mode-roadmap.md#4-phases-and-dependency-gates)            | Phase 2–8 work remains in the canonical Design guide; completing a phase updates its implemented contract in the same document                                          |

The cloud index lists every document in that program and its retention policy.
Its architecture, product, data, security, operations, enterprise and engineering
reference documents remain useful after launch. Its implementation roadmap is
an active delivery checklist, and its root-coordinator threat model records an
unresolved release decision.

## Documentation maintenance

- Give each behavior one owning guide. Other documents summarize only their
  integration boundary and link to that owner.
- Separate implemented behavior, compatibility obligations, planned work and
  host/release qualification. Remove stale “planned” and “uncommitted” claims
  when code changes; preserve meaningful unsupported cases and future gates.
- Preserve schema versions, persistence keys, resource ceilings, recovery rules,
  source anchors and reproducible checks when consolidating documents.
- Move lasting decisions out of completed implementation reports. Git history
  retains historical task diaries; they do not need parallel authoritative docs.
- Keep dated competitive research, incident dumps, credentials, user transcripts,
  private deployment investigations and raw qualification artifacts outside this
  public directory. Link runnable tests/probes and record only useful bounded
  evidence with its platform limitations.
- Check incoming file/heading links and tests that read docs before deleting or
  renaming a guide. Add new guides to this index; keep Design-specific contracts
  in `design-mode-roadmap.md` rather than recreating separate Design plans.
