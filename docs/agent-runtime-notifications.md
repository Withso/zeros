# Agent runtime notifications and working upgrade PRs

The runtime radar watches upstream Claude, Codex and Cursor releases, public
advisories, release notes, model listings and delivery evidence. It maintains one
GitHub tracking issue and one working upgrade PR per provider. Notification and
branch-writing workflows ship disabled; repository configuration enables them.

## Maintainer workflow

1. Subscribe to the tracking issue. New digest comments contain changes and
   source links; the issue body retains the current inventory and source health.
2. Open the automatic provider PR and work on **that PR's existing branch**.
   Mechanical commits update the exact runtime pin, lockfile, license inventory
   and, for Codex, generated protocol bindings and the protocol pin.
3. Implement adapter, capability, catalog or test changes on the same branch.
   Review the maintained PR report and the normal required checks. The bot never
   fills in reviewed dispositions, enables capabilities or changes defaults.
4. Later eligible versions append a normal commit to that PR's current head.
   Human commits remain in its history. There is no force push, reset, automatic
   rebase, automatic conflict resolution or automatic merge.
5. For final review, apply `agent-runtime:hold`. Wait for the report to acknowledge
   the **current** frozen SHA; a write already in flight may finish before that
   acknowledgment. Human pushes remain possible while held and require a fresh
   acknowledgment and current-head checks. Removing the label resumes updates.
6. The owner merges when integration and required checks are ready. Root manifest
   and lockfile changes are CI-definition changes under `docs/ci.md`, so
   `pnpm agent:merge` continues to refuse these PRs. A later upstream version
   opens the next PR from the actual main pin.

The four-hour schedule is the normal refresh point. Dispatch **Agent runtime
radar → scan** to refresh sooner. Routine candidates must have been published
for a day; successful advances are limited to one per provider per day. Awareness
alerts do not wait for that age gate. A closed, unmerged candidate is declined
until a newer eligible version appears. The declined version is read from the
immutable closed PR head, including a maintainer update made since the last scan.
If that pin cannot be verified, reconciliation pauses before opening another PR.

An unheld PR with no new human integration commit receives a reminder after
48 hours, then at seven days and at most weekly. A new human commit resets that
clock; mechanical bot updates do not count as integration decisions.

If a maintainer changes the selected pin, lockfile, generated bindings or license
bundle, preparation pauses on the existing PR. Resolve those changes there. After
reviewing the intended regeneration, `agent-runtime:regenerate` explicitly allows
regenerating the managed files against the current head. It does not authorize
other paths, a downgrade, an automatic merge, or bypassing a hold. Three failed
preparations of the same head/candidate require a human change or regeneration
request. Unrelated adapter edits and unrelated manifest fields are retained.
If regeneration verifies that the managed files are already current, the writer
appends an App acknowledgment commit with the identical tree and consumes the
regeneration label. The request must still be present, unheld, on the same owned
PR and head. The signed task commit establishes the new baseline; an unchanged
preparation artifact or a human commit alone cannot do so. Normal CI still runs
on the acknowledgment commit.

## What is observed and what is decided

| Evidence               | Source and interpretation                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime releases       | npm stable versions, publication times, exact native pairing and macOS/Linux package availability; prereleases and platform-tag noise are excluded.                                                                                              |
| SDK/CLI notes          | Official releases/changelogs in `scripts/agent-runtime/config.mjs`; Cursor CLI announcements are advisory because Zeros runs the SDK. Missing notes remain incomplete evidence.                                                                  |
| Capabilities           | Watch terms flag computer use, approvals, streaming shell output, auth/config and model changes. They request integration review, not automatic feature enablement.                                                                              |
| Structural API changes | TypeScript declarations from integrity-verified npm archives and committed Codex JSON schemas. Changes inside an existing declaration are detected; comments/formatting are ignored.                                                             |
| Security               | Public GitHub advisories for the three bundled pins and the separately pinned control-plane Codex auth keeper. Runtime advisories use the working PR; unrelated direct/transitive fixes remain with Renovate.                                    |
| Models                 | The exact installed bundled runtime lists advertised models for a dedicated test-account configuration. Pagination must complete. No model turn, prompt, agent creation or inference is requested.                                               |
| Desktop delivery       | Public Alpha, Beta and Production release ledgers identify published source SHAs; manifests at those SHAs identify the pins. Source ancestry recognizes inclusion by a later release. Beta/Production lag is a maintainer promotion decision.    |
| Cloud delivery         | Standalone worker delivery is currently unobserved. Receipts from the retired runtime-bundle publisher are ignored; desktop release evidence cannot establish v2 worker delivery. |

Catalog entries, names, favorites, aliases and defaults remain curated. A model
disappearance requires complete observations on two distinct UTC dates for the
same account label and runtime version. It means “not listed for this scope,”
not a confirmed retirement. Repeating a probe the same day does not advance the
counter. Provider caches can hide server changes; their age is reported as
unknown. Listing a model does not prove the account can run it.

Claude presence checks use native `resolvedModel` when supplied, then curated
aliases, comparing base IDs without the supported `[1m]` context modifier or a
dated revision. A native resolution overrides an older alias target. Public
identities still require an exact allowance. Native Claude effort/Fast fields
and both Codex Fast tier fields contribute to capability fingerprints; explicit
false or empty responses remain distinct from omitted capabilities.

An ID is public only if it already appears in the curated catalog or in
`scripts/agent-runtime/public-model-ids.json`. Unknown/account-only IDs are
represented by stable hashes. Raw provider replies, account identifiers, emails,
credentials, prompts, local auth files and subprocess logs are not public report
fields. A maintainer must review any new public-ID allowance.

## Reports and independent qualification

`agent-runtime-qualification.yml` runs independently of Vitest. CI selects it with
`job-vitest`; complementary Preflight owns it when that job is unselected. Full
Preflight runs it for main, release and merge-queue commits. Both `test`
aggregates, CI's inventory gate and Preflight's Alpha gate retain this result.
Each gate records its own exit code; one failure does not skip later gates:

- Runtime/native pin proof and Codex pin/coverage checks.
- Strict offline catalog verification and semantic surface review.
- Cursor packaging closure and source/Electron host smoke checks.
- Claude and Codex native startup checks without working inference credentials.
- License inventory, packaging paths and adapter fixtures.

Failed setup produces incomplete gates where the reporter can run. Missing,
cancelled, invalid or skipped evidence never becomes a pass. Reports name both
the PR source SHA and the actual tested merge SHA. Preparation against a scratch
checkout is not qualification of the later App commit. Normal required CI must
run again on the actual pushed commit.

Run `pnpm agent-runtime:surfaces --base <immutable-base>` to write
`.context/agent-runtime/surfaces.json`. For each changed fingerprint, add a
reviewed entry to `scripts/agent-runtime/reviews.json` with `provider`,
`fingerprint`, `disposition`, a concrete `rationale`, and nonempty `evidence`
(test/source paths or public issue links). Allowed dispositions are
`implemented`, `sdk-owned`, `preserved-generically`, `generated-only`,
`intentionally-deferred` and `upstream-blocked`. Unknown changes fail the surface
gate. The full bounded JSON artifact holds the detail; PR comments summarize it.
Schema annotation removal applies only to schema objects. Property/definition
names and literal `const`, `default`, and `enum` data remain part of the contract,
including fields named `description`, `title`, or `examples`.

## Privilege and persistence boundaries

| Job             | Authority                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scan/controller | Trusted immutable main, public reads, repository/Actions reads, issue state writes and PR report comments (`pull-requests: write`). No provider or App secrets.                                                           |
| Preparation     | Isolated candidate checkout and native generators; read-only repository token, no branch/issue writer or provider secrets. Lifecycle scripts are disabled for package installation. No cache is shared with trusted jobs. |
| Branch writer   | Verified bundle built from trusted main before preparation; no dependency installation or candidate execution. A short-lived, repository-restricted App token grants contents/PR writes. Writers run one at a time.       |
| PR publisher    | Default-branch `workflow_run` code, bounded JSON artifact reads and issue/PR comments; no candidate checkout, package installation or content writes.                                                                     |
| Model discovery | Default-branch listing code, dedicated test credentials only for the listing step. A separate job publishes sanitized observations.                                                                                       |
| Watchdog        | Independent hourly state/heartbeat reads and health transition comments. No dependency install, App credentials or branch writes.                                                                                         |

The writer validates task/run/attempt/source identity, current ownership/head,
merge state, file paths/modes, before-blob identities, manifest scope and lockfile
dependency closure. Only the selected root pin, its graph, license bundle and
Codex generated TS/JSON/notices are writable. Control-plane pins, workflows,
catalogs, adapter implementations and review dispositions are outside its path
allowlist. A concurrent human push wins through a non-fast-forward rejection.
An auto-merge request or merge-queue entry also stops writes.

GitHub artifacts are untrusted input. JSON ZIP readers accept one expected regular
entry with compressed/expanded bounds and never extract paths or execute text.
Qualification verifies repository, workflow, run attempt, PR association and
merge parents against GitHub. Stale/fork results cannot update another head's
report. Scanner runs recover missed `workflow_run` deliveries. A writer receipt
alone cannot establish a successful update: finalization verifies the signed
App-authored task commit and the owned PR independently. GitHub signs commits an
App creates through the API with the App as author and `web-flow` as committer;
a push keeps its own committer and a web-UI edit its human author, so neither
counts as an App commit. Interrupted initial PR creation can recover only that
exact signed App commit, never an arbitrary branch. Failures print GitHub's
numeric HTTP status, never a response body.

One bot-owned issue comment contains versioned state. Bot-owned markers delimit
the dashboard while preserving human notes. Stable event IDs, posted digest
reconciliation before publication, read-back after ambiguous POST responses and
bounded checkpoints prevent routine duplicate alerts. Last-good observations
survive partial-source failures. Corrupt/missing state is an incident, never an
instruction to bootstrap a replacement over history.

Catch-up reduction and publication allow bounded temporary state up to 2 MiB and
5,000 events. Saved state retains its strict 48 KiB and 500-event limits; pending
events must be delivered and acknowledged history checkpointed before compaction
can advance it. Release fingerprints cover the full observed shipping-pin window
independently of the eight retained excerpts. Older schema-1 snapshots without
that inventory seed forgotten older fingerprints once without replaying their
announcements; edits to known notes and newer releases still produce alerts.

Every state writer and branch controller shares the non-cancelling
`agent-runtime-state` workflow concurrency group. GitHub can replace a pending
run; scheduled reconciliation and durable task identities recover missed work.
Do not add `cancel-in-progress: true`, competing per-job state writers, or a
second writer for these runtime pins. Human remote pushes remain concurrent and
are checked separately. A hold acknowledgment follows all in-flight writes in
that group; applying the label alone is not the acknowledgment.

## One-time setup and rollout

This implementation does not install an App, add secrets, subscribe users,
create an issue/PR or enable automation merely by existing on a branch. An owner
must review and merge the CI-definition change, then configure Actions:

| Repository variable                  | Meaning                                                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZEROS_AGENT_RUNTIME_MODE`           | Unset/`off`: disabled; `dry-run`: artifact-only scheduled collection; `notify`: issue/report publication; `enabled`: also prepare and append upgrade PR commits. |
| `ZEROS_AGENT_RUNTIME_TRACKING_ISSUE` | Issue number printed by explicit bootstrap.                                                                                                                      |
| `ZEROS_AGENT_RUNTIME_APP_CLIENT_ID`  | Client ID for the runtime updater GitHub App.                                                                                                                    |
| `ZEROS_AGENT_RUNTIME_APP_SLUG`       | Exact App slug; checked against the token action's App identity and PR/commit authors.                                                                           |
| `ZEROS_AGENT_RUNTIME_MODELS`         | `enabled` opts into daily listing; unset disables the credentialed workflow.                                                                                     |
| `ZEROS_AGENT_RUNTIME_MODEL_SCOPE`    | Public non-identifying label such as `dedicated-test`. Change it when changing accounts; never use an email or customer identifier.                              |

The App installation must be limited to this repository with contents and pull
requests write access, without a branch-protection bypass. Store its private key
as `ZEROS_AGENT_RUNTIME_APP_PRIVATE_KEY`. An existing App is suitable only after
its intended use, installation, permissions and Actions secret availability are
confirmed. Workspace-local App credentials are not automatically Actions secrets.
`GITHUB_TOKEN` remains the issue publisher. It is not a substitute for the App
writer because its pushes can suppress normal CI triggers.

Optional dedicated Alpha/test credentials are stored as
`AGENT_RUNTIME_ANTHROPIC_API_KEY` or `AGENT_RUNTIME_CLAUDE_CODE_OAUTH_TOKEN`,
`AGENT_RUNTIME_OPENAI_API_KEY` or `AGENT_RUNTIME_CODEX_AUTH_JSON`, and
`AGENT_RUNTIME_CURSOR_API_KEY`. Never use a customer credential, read an engine
vault, or put Beta/Production credentials in `.env.agent`. Missing credentials
produce unavailable discovery. Listing paths and redaction must be qualified
with those dedicated accounts before enabling the daily workflow.

Rollout steps:

1. Run `pnpm agent-runtime:scan --public-only` locally and dispatch `dry-run` on
   main. Review artifact-only results for 48 hours, including source failures.
2. Set mode `notify` and dispatch `bootstrap`. It creates/reuses the tracking
   issue, initializes durable state, and creates the hold/regeneration labels.
   Set the printed issue number variable and subscribe the responsible maintainers.
3. Reconcile existing Renovate runtime PRs by merging or closing them explicitly;
   retain any human work. The controller blocks competing legacy proposals.
   This change excludes only the three root runtime package/file pairs and the
   independently managed keeper from Renovate, including vulnerability overrides.
   During the disabled rollout interval those runtime updates need manual intake.
4. Configure the App, then enable the controller under owner supervision. Verify
   App-created PRs **and subsequent App/human pushes** automatically receive all
   required current-head CI, without manual workflow approval. The first real
   candidate is not considered operationally qualified before this hosted check.
5. Exercise two advances on the same PR with an intervening human commit,
   hold/resume, managed-file conflicts, close/merge and a stale report. Review
   the first upgrade through main, desktop publication and cloud receipt.
6. Enable dedicated-account discovery only after verifying its listing-only
   behavior. Keep unqualified native/platform/account evidence explicitly unknown.

The current workspace's fixture/public dry-runs do not establish hosted App
behavior, authenticated provider listing or macOS/cloud runtime qualification.
Those require the configured environment and remain rollout acceptance checks.

For Renovate config changes, reproduce the handoff with its actual pinned parser:

```sh
npm install --prefix .context/renovate-validator --ignore-scripts --no-audit --no-fund --package-lock=false renovate@44.151.3
node .context/renovate-validator/node_modules/renovate/dist/config-validator.js --strict renovate.json
node scripts/agent-runtime/check-renovate-handoff.mjs
```

The replay checks routine/advisory overrides, each owned root pin, the keeper,
unrelated direct/transitive names and an unowned manifest. It performs no GitHub
writes and adds no repository runtime dependency. Requalify when changing that
pinned version or Renovate's precedence behavior.

## Cost, health and recovery

The incremental operating target is **$0** with standard GitHub-hosted runners
for this public repository, a GitHub App and public metadata reads. The notifier
does not call a paid inference service, create cloud VMs, wake workspaces or
install a paid monitoring service. Existing account subscriptions, artifact
storage overages, future pricing changes, and separately requested live agent
qualification are outside that target. Artifact retention is two days for
preparation/writer tooling, three for scans/model observations, and seven for
qualification/publication receipts. Routine no-op scans retain a job summary and
the issue heartbeat without uploading another scan artifact or opening a PR.

The watchdog alerts after 12 hours without successful public collection or state
publication and after 48 hours without a complete enabled model source. It
posts one health transition/recovery comment and fails its own run on unhealthy
state. Enable GitHub Actions failure notifications as the fallback when the issue
or its state is unavailable. GitHub outages can delay both schedules; this is
not an external availability guarantee. State/artifacts expose scan/publication
times, source freshness, review age and release source/pins for investigation.

To recover corrupted state, retain the issue and comments, inspect the latest
bot checkpoint/digests and signed App PR history, reconstruct a valid state
comment, and restore its locator only after review. Do not run bootstrap over
an existing state locator. A large checkpoint uses a `base64-json-parts` index:
read its referenced bot-owned comments in order, decode their `data` fields,
verify each byte-part SHA-256 and the reconstructed canonical snapshot digest,
then compact acknowledged history before restoring the bounded state comment.
To roll back, set mode `off` and disable model discovery.
Branches, issues and human commits remain available. Reconcile active proposal
ownership before re-enabling Renovate runtime writes.

## Workspace behavior

Local Personal and organization-local workspaces receive runtime changes only
through the normal reviewed desktop release. Organization cloud workspaces use
the existing bundle publication, qualification and allocation/lifecycle policy;
running allocations retain their pins. Owner or placement switching does not
invoke the radar or model probe. This repository automation has no engine,
customer-vault, cloud wake, restart, workspace migration or session control path.
The control-plane Codex auth keeper keeps its independent pin and qualification.
