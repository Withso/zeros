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

## Whole-corpus runs

```sh
node scripts/zstack/eval-corpus.mjs
mkdir -p .context
node scripts/zstack/eval-corpus.mjs --execute --output .context/eval-attempt-01
```

The first command plans every case in deterministic ID order. Execution uses
the same replay engine in sequential batches of at most 32, with a 150-minute
corpus deadline by default. `--batch-size` can lower that bound;
`--timeout-minutes` accepts 1–180. `--revision <full-sha>` pins seeded execution;
otherwise it uses HEAD. Mode, models and dependency-cache options match the
replay tool. Create the output's parent first; each attempt needs a new output
directory. `plan.json`, `batch-NNN.json`, `progress-NNN.json` and `receipt.json`
retain coverage and partial results, including cancellation or malformed batches.
Receipts exclude raw child output. The original failure is never overwritten.

`baseline.json` is a composite observation: B1's original 359-case run found
169 caught, 4 missed and 186 unverified; a separate mainline replay of its four
new cases caught all four. That makes 363 cases, 173 catches (47.6584%), four
misses and 186 verification gaps. It was not one 363-case run. The source groups
record revisions, times and evidence hashes. No missing revision or unsupported
check was replaced to raise the score.

The gate compares every baseline case, not just totals. It refuses missing or
duplicate results, changed kind/fix/check/seed recipes, lost individual catches
and a lower catch rate over the **same baseline case set**, retaining its
unverified cases in the denominator. The receipt's overall summary still counts
every current case. `comparison.covered` reports the baseline cases' current
results, and `comparison.newCases` lists additions with their status and code.
For example, a new unverified scenario is reported without failing unchanged
baseline coverage; a new catch cannot offset a lost baseline catch. A previously
unresolved fix may become resolved when its recipe is unchanged. Once known, a
replay's fixed commit and parent remain pinned. Seed execution advances with the
source revision while retaining its mutation fingerprint. Partial runs always fail;
an exit of 1 from a batch is expected for known misses or gaps only when its
complete, valid receipt agrees with that exit.

The `Zstack Eval Corpus` workflow runs nightly at 03:40 UTC and by manual
dispatch on Ubuntu 24.04, pinned for Playwright's OS dependencies. It checks out
full history and objects, installs both pnpm graphs and Chromium, and uploads the
evidence even on failure. It uses read-only repository
permissions and no live-provider credentials. Its first hosted execution and
native macOS coverage are separate from local runner tests.

Changing the baseline is a reviewed evidence update: retain the prior raw
receipts, state the source revisions and reasons for any recipe change, and
show the before/after per-case comparison. Do not delete an unverified case,
convert an infrastructure failure to a catch, or silently lower the floor.
