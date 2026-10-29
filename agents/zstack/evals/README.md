# Eval ownership

`area` is a closed vocabulary exported as `EVAL_AREAS` by
`scripts/zstack/evals.mjs`. These names follow RULES.md §2's boundaries and the
subsystems exercised by the corpus. Choose the owner of the behavior under
test, including for a cross-boundary regression. New incident descriptions do
not create areas. An actual new subsystem updates this table and the validator
together.

| Area | Owner |
|---|---|
| `desktop-native` | `apps/desktop/electron/`: IPC, preload, OS integration, updater |
| `desktop-engine` | `apps/desktop/src/engine/`: workspace and headless services |
| `desktop-agents` | Engine `agents/`: provider adapters, orchestration, transcripts |
| `desktop-git` | Engine `git/`: local Git and GitHub boundaries |
| `desktop-design` | Engine/renderer Design and shared `packages/design-*` contracts |
| `renderer-state` | Renderer state, platform, shell and feature navigation/lifecycles |
| `renderer-ui` | Renderer shared UI and interaction primitives |
| `renderer-agents` | Renderer agent/conversation features |
| `renderer-settings` | Renderer settings and connection configuration |
| `control-plane` | `apps/control-plane/`: API, authorization and cloud contracts |
| `control-plane-data` | Control-plane database, migrations and transaction semantics |
| `control-plane-workers` | Control-plane queues, reconciliation and background workers |
| `cloud-worker` | `apps/cloud-worker/`: standalone VM worker |
| `web` | `apps/web/`: hub, auth handoff and edge functions |
| `marketing` | `apps/marketing/`: public site |
| `protocol` | `packages/protocol/`: shared transport and validation |
| `logo-particles` | `packages/zeros-logo-particles/`: shared canvas field |
| `catalogs` | `catalogs/`: versioned provider/model data |
| `scripts` | Repository scripts without a narrower owner below |
| `scripts-ci` | CI selection, dependency checks, merge safety and test harnesses |
| `scripts-release` | Release, packaging and runtime publication/qualification |
| `scripts-dev` | Development-environment setup, launch and cleanup |
| `styles` | `styles/`: design tokens, policy and shared CSS |
| `third-party` | `third_party/` and third-party provenance/license contracts |
| `docs` | `docs/`: durable public engineering contracts |
| `zstack` | `agents/zstack/`, `scripts/zstack/`: engineering pack and evidence tools |

Historical cases can exercise retired code at their pinned fix. Their area
describes the owning boundary; it does not claim that the retired runtime is
still used. Cases formerly using free-form cloud labels are assigned to the
actual desktop, control-plane, worker or script boundary exercised by the check.

Add cases under `cases/<id>.json`; do not append to the legacy `cases.json`.
Consolidated lesson references use `git show 7b6eb9e6:agents/zstack/changes/<id>.md`
so the original rule remains reviewable after its fragment is removed.
