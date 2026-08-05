# Engineering documentation

This directory contains durable engineering contracts that remain useful to
contributors after the change that introduced them has shipped.

- [UI interaction and performance](ui-interaction-performance.md) defines the
  renderer's loading, caching, navigation, and retained-surface invariants.
- [Navigation state persistence](navigation-state-persistence.md) documents
  owner-keyed selection and cleanup behavior.
- [Color names](color-names.md) records the stable workspace-name palette used
  by the local engine.

Dated implementation plans, competitive research, incident notes, account
details, and deployment investigations do not belong in the public repository.
Keep that material in the team's private planning system. A durable rule or
decision that affects the code should be written here without private context
and enforced by tests where possible.

Repository ownership, deploy boundaries, and the restructure migration record
live in [REPOSITORY-ARCHITECTURE.md](../REPOSITORY-ARCHITECTURE.md).
