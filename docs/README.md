# Engineering documentation

This directory contains durable engineering contracts that remain useful to
contributors after the change that introduced them has shipped.

- [UI interaction and performance](ui-interaction-performance.md) defines the
  renderer's loading, caching, navigation, and retained-surface invariants.
- [Navigation state persistence](navigation-state-persistence.md) documents
  owner-keyed selection and cleanup behavior.
- [Organizations, teams, and workspace ownership](organizations-and-teams.md)
  defines Personal, tenant and child-team identity, roles, placement metadata,
  browser-management boundaries, and compatibility contracts.
- [Hosted deployment environments](deployment-environments.md) defines the
  Alpha → Beta → Production topology, isolation rules, promotion flow, and
  controlled rollout requirements.
- [WorkOS authentication migration](workos-authentication-migration.md) records
  the active clean-slate provider migration, durable identity/session contracts,
  live token gates, and future Railway-template boundary. It is removed after
  the lasting rules are folded into the deployment and architecture guides.
- [Agent identity model](agent-identity-model.md) defines Zeros workspace,
  conversation, execution, and provider-binding ownership and lifecycle.
- [Zeros browser service](browser-service.md) defines the shared browser tool,
  identity, isolation, policy, artifact, and provider-adapter boundaries.
- [Design Foundation 1.0](design-foundation-1.0.md) defines the canonical
  source, identity, transaction, renderer, headless, agent, and performance
  contracts beneath the Design workspace.
- [Autonomous Code and Design Foundation](autonomous-code-design-foundation.md)
  defines the protected target architecture and phased path from today's local
  GitHub product to isolated design agents, visual artifacts, cloud execution,
  and additional Git forges.
- [Color names](color-names.md) records the stable workspace-name palette used
  by the local engine.
- [Agent capability roadmap](agent-capabilities-parity-and-ui-consolidated-2026-07-01.md)
  is the actively maintained parity and product-work checklist for supported
  agent integrations. It remains tracked until every item is resolved or moved
  to another owned roadmap.
- [Zeros sandbox runtime and Git broker plan](zeros-sandbox-runtime-plan.md)
  is the active roadmap for Zeros-owned whole-process-tree agent containment,
  the agent Git broker, provider onboarding, and cloud qualification. It stays
  tracked until every phase is delivered, cancelled, or folded into the
  foundation and design-mode contracts.
- [Zeros sandbox runtime qualification ledger](zeros-sandbox-runtime-qualification.md)
  records the exact local gates that ran, the supported parity and isolation
  evidence they produced, and the release architectures and production-cloud
  work that remain explicitly unqualified.
- [Cloud workspaces](cloud-workspace/README.md) contains the current product,
  architecture, data, security, operations, enterprise, and delivery contracts
  for the pre-production remote-workspace program.

Completed dated plans, competitive research, incident notes, account details,
and deployment investigations do not belong in the public repository. Keep that
material in the team's private planning system. An active public roadmap may
remain when it has an explicit retention rule, current implementation anchors,
and no private operational or competitive material. A durable rule or decision
that affects the code should be written here without private context and
enforced by tests where possible.

Repository ownership, deploy boundaries, and the restructure migration record
live in [REPOSITORY-ARCHITECTURE.md](../REPOSITORY-ARCHITECTURE.md).
