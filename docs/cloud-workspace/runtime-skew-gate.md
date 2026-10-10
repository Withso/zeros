# Cloud runtime version-skew gate

Running cloud workspaces keep their generation's runtime pin across restarts.
A new desktop or control plane must preserve core operations on N−1: the
previous **qualified runtime for the same base and credential profile**, rather
than the previous Git commit or protocol integer. Publication of another runtime
does not make an older running cohort disposable.

`pnpm check:runtime-skew` is a required **source-contract first slice**, not
released-engine qualification. CI and Preflight's `test-shard` jobs run it once
(part 1) without `continue-on-error`; the existing `test` aggregate and Preflight
Alpha gate propagate failure. The existing workload-parity test requires the
same four-line step in both workflows.
The trusted selector already selects that lane for control-plane, engine,
renderer and protocol changes; regression tests retain that floor. One ownership
pattern assigns harness/pin edits to the existing cloud-runtime/control-plane
lanes. No jobs are added; merge, deployment and publication workflows are unchanged.

## Pins and execution

[`scripts/runtime-skew/pins.json`](../../scripts/runtime-skew/pins.json) records
full immutable Git commit and tree hashes for the historical directions:

- Current client → Alpha #406 runtime source `c8e60c064ec1e4661254c46dee24bc8cfcc300e5`
  → current control-plane HTTP validators. The supplied runtime identifier is
  only the prefix `r1-7a4e5161`; its full bundle digest, base/profile and
  qualification evidence have **not** been verified by this task.
- Alpha #406 desktop source `c8e60c064ec1e4661254c46dee24bc8cfcc300e5`
  → current engine modules → current control-plane HTTP validators.
  This is operator-supplied Alpha source provenance, not a signed Alpha
  desktop binary.
- Each `retainedRuntimes` pin → the current client and control-plane validators.
  Keep this list for older cohorts which still need support.

Both #406 directions verify immutable source tree
`a3d284577be7d17163a560db8c2b92a0df94f390` from Git objects. Those source pins
do not establish a complete runtime ID, signed artifact or qualified base pair.

The loader reads every historical project import from that commit's Git objects,
including relative imports and `@zeros/protocol`. It verifies the recorded tree
hash, never redirects a missing historical module to current source, and fails
when history is absent. The existing CI checkout already fetches full history.
The gate performs no Git fetch and contacts no providers. It builds only portable
schemas, renderer adapters, command/action pumps and registration clients;
current control-plane Hono routes run in process with injected memory services.
The frozen/current native transport opens ephemeral sockets with a loopback
client for confirmed lease expiry. No database or external provider is used.
Synthetic transport material stays inside the harness; diagnostics never print
requests, credentials or raw errors.

Historical bundles are cached under gitignored `.context/runtime-skew/`, keyed
by full source commit, harness entry digest, compiler version and the current
lockfile digest. Current modules rebuild every time. There is no historical
dependency install; the schemas run with the repository's installed libraries.
No historical checkout, generated source or compiled fixture is committed.

| Contract                    | Evidence in this slice                                                                                                                                                                                                               | Remaining qualification                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Handshake / capabilities    | Both protocol ranges; unsupported native-command versions produce a typed `cloud_runtime_feature_unavailable` refusal before queue mutation, with `update-runtime` for missing/older support or `update-desktop` for newer contracts | Real transport negotiation and capability advertisement from an enrolled released engine |
| Prompt / Stop / queue       | Actual renderer prompt construction, frozen/current strict parsers, engine pump, current HTTP validators, claim, successful settlement and Stop cancellation                                                                         | Durable database ordering, actor/delegation authority, real provider turns and races     |
| Approval                    | Frozen/current action schema and engine pump, current HTTP validation, permission delivery and receipt parsing                                                                                                                       | Native provider approval callback and durable replay/idempotency                         |
| Terminal                    | Actual renderer attach/input adapter, receiving cohort ingress parser, optional reattach snapshot fields                                                                                                                             | Native PTY creation, screen state, input acknowledgements and disconnect survival        |
| Records / events            | Current record-append request validator; frozen/current event append/replay clients and receiving parsers                                                                                                                            | Actual record consumer/recovery and durable ordered replay across reconnects             |
| Services / renewal          | Frozen/current registration and native transport; network/408/429/503 renewal retains only the confirmed deadline, 401/403 refuses; one renewal and actual bounded lease expiry                                                       | Base attestation, real service stream and provider credential refresh/revocation         |
| Failure / terminal / replies | Both directions cover 17 new categories across five stages, 17 actual failure receipts, direct/snapshot terminal projection and opt-in, and correlated permission/question ownership                                                | Native provider callbacks, signed binaries and durable replay                            |
| Files / Git / Design create | Deferred                                                                                                                                                                                                                             | Real receiving engine handlers and stable persisted/source identities                    |

Responses and persistence are memory fixtures. A change solely to database
response construction, provider behavior or omitted handler semantics can escape
this slice. Passing it must never be presented as proof that a released desktop,
control plane and runtime pair is fully qualified. It does not diagnose the
specific reported workspace's provider failure or guarantee that every generic
dispatch error has been removed.

The gate captures each cohort's actual engine handlers and failure formatter,
plus standalone control-plane Zod 3 schemas. Terminal acknowledgement is bound
to the exact CP/org/workspace/generation/engine; lost support restores legacy
projection. Alpha CP refuses all 17 new producer categories even after terminal
stripping, so **deploy the control plane first**. Unsupported cloud contracts
refuse before send/queue mutation. These
source checks and the [cloud compatibility activation gate](qualification-status.md#rollout-order)
do not substitute for a signed-client/released-VM run.

The deliberately incompatible fixture adds `futurePromptFormat` to a real
queued prompt, which the frozen strict parser rejects before a durable mutation:

```sh
pnpm check:runtime-skew
pnpm check:runtime-skew --negative-fixture
pnpm exec vitest run scripts/__tests__/runtime-skew.test.ts
```

The second command must exit 1 with `runtime_skew_incompatible`; the regression
suite verifies that exit, not merely that a schema reports a failed parse.

## Updating pins at release

The publication operator prepares a reviewed pin PR as part of the existing
runtime publication/qualification flow. Automatic advancement from publication
alone is unsafe: `cloud_runtime_bundles.source_commit` is the provenance mapping,
but publication is not qualification, and an older cohort may remain active.

1. From the credentialed Alpha operator workspace, identify the previous
   qualified runtime for the candidate's exact base and credential profile.
   Record its complete runtime identity, `source_commit`, immutable source tree,
   manifest/archive digests and qualification evidence in the review. Replace
   the initial prefix/provenance with that verified identity when available.
   This gate itself never reads provider credentials or the registry.
2. Resolve the preceding **actual Alpha desktop release** to an immutable source
   commit and tree. Replace the operator-supplied #406 source baseline only with
   verified binary/source provenance. Moving `alpha` tags must never
   be used as executable pins.
3. Move a replaced runtime pin into `retainedRuntimes` while any running workspace
   still needs it. Do not overwrite the sole old pin to make a failing release
   pass. Add all qualified base/profile cohorts relevant to the release.
4. Run the gate and its negative control, retain the regression tests, and require
   the `test` aggregate before advancing publication. This first slice adds the
   CI test check; enforcing every publication entrypoint and qualifying binaries
   remain the follow-up below.
5. Remove an old pin/support path only after allocation inventory confirms **no
   running workspace needs that cohort**, and queued or stopped workspaces have a
   qualified migration/admission path. Record the inventory scope and evidence
   in the pin PR. Advancing a protocol integer or channel head is insufficient.
   Revocation remains authoritative; compatibility cannot admit revoked code.

## Released-engine follow-up design

Full building/qualification is deferred because the supplied pin lacks the full
verified bundle/base profile and the preceding signed Alpha desktop artifact.
An ordinary source build alone cannot stand in for the root-protected installed
runtime, attestation, enrollment and native dependencies. The available Git
source is enough for this portable first slice.

Extend the same matrix with verified immutable bundles (or hermetic builds from
their recorded source and lockfile), cached by source plus manifest/archive
digest. Start the old **actual engine** and current engine in their qualified
base environment against an isolated current control-plane database. Drive
current and frozen previous renderer/bridge clients through real transports.
Use synthetic providers for deterministic prompt, Stop, approval and queue
races; cover Files/Git/Design creation, terminal attach/input/snapshot, record
and event replay, service admission and registration/credential renewal.
Refuse any new unsupported operation before durable admission with a typed
update/fallback reason. Keep a binary-level incompatible negative control.

Require that qualification before desktop/control-plane publication at every
entrypoint, in addition to this required CI contract check. Forward and rollback
data-format tests remain separate. Do not enable live updates based on this
source-contract gate.

## Local workspace impact

Local-owner and organization-owned local workspaces continue through their
existing local engine and pathname dispatch. Cloud contract refusals are scoped
to cloud peers; they do not select cloud execution or credentials for a Local
owner. The gate checks both local pathname identities
and selection of an exact `cloud://` key; adjacent workspace-runtime tests cover
delegation to the local client and switching peers.

## Cloud workspace impact

Organization cloud workspaces gain a required source-contract CI check and a
typed actionable refusal for unsupported native conversation operations before
queue mutation. The engine chosen by a running workspace keeps its pin. No
workspace upgrade, provider call, restart, migration or live resource is created.
