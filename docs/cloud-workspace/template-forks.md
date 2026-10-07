# Cloud Computer template workspace creation

Every authorized organization member creates from the Cloud Computer's active,
successful v2 build and ready, stopped template. An active account and current
organization/repository authority are required; owners/admins manage the
computer. Staff status and the desktop internal feature flag do not select a
creation path. A missing ready active template returns
`409 cloud_computer_build_required` before repository lookup or provider
allocation. Creation has no legacy image or bare-base fallback.

The desktop Create composer uses the active build's ordered `activeRepositories`
when the template is ready. State and history reads opt in with
`activeRepositories=true`; responses without that query retain the exact shipped
shape for strict-schema clients. Draft-only additions are excluded. Repository
choice is restored synchronously per user and organization, then pruned against
the active list. Add repository opens Cloud Computer settings; no registered
local project is required. Local and organization-owned local creation retain
their existing paths.

The composer reads the default branch through `create-options`, retaining the
`cloudComputerV2=true` query for compatibility. An active-config repository uses
the organization's existing grant and repository resolver without a personal
GitHub proof or database writes. Requests outside the configured repository set
return empty options. The read rechecks organization access and active build
identity after GitHub returns, and exposes no credentials.

Desktop GitHub branch and open-PR reads are optional, cached by user, organization
and repository grant, and warmed on pointer/focus intent. Branch listing uses the
first 100 GitHub rows with search over that page. These read failures appear inline
and do not block default-branch creation. Branches use `refs/heads/<name>` and
pull requests use `refs/pull/<number>/head`.

Code and Design create requests include the selected repository's installation
record ID and omit the retired `cloudComputerBuild` builder field. Create chooses
the active template at submission: a newer build containing the same repository
is valid. Computer/repository/template admission conflicts show
“Cloud Computer changed — refresh”, revalidate the state and picker selection,
and preserve the composer prompt. Create-options drift uses the same recovery,
bounded to one automatic attempt until a confirmed metadata read succeeds.
Completions are fenced to their current account and repository owner; a hidden
Create surface defers recovery reads until that same owner is visible again.

## Historical retirement

Only saved v2 sources with complete v4 runtime pins and actor protocol 2 can
execute. Historical records remain readable, and stop/archive/delete remain
available. Wake, generation replacement and checkpoint recovery return
`409 cloud_workspace_v2_required` for unsupported generations. Retrying or
restarting does not migrate their immutable runtime pins; create a new workspace.

The old authenticated `/cloud-computer` endpoints return the same typed
retirement error and cannot save, build, publish or activate. V2 enrollment
cancels old builds under the organization lock and proceeds. Background
retirement handles their disposable workspaces and receipt-verified resource
deletion; it has no allocation, install, capture, attestation or publication port.
Unknown dispatched allocations remain unresolved without replaying creation.
An unsettled capture retains its builder. Active/previous selections, all
persisted generations (including stopped/archived), configured bases and
dependent images retain their snapshots. The final reference check locks the
image and marks retirement before provider deletion, blocking new references.
Compute and snapshot admission are released only with their respective cleanup
proofs. Applied migrations and historical identities are preserved.

## Accepted source and runtime

The primary repository must belong to the active build's immutable config.
The control plane uses that config's organization read grant to mint one GitHub
installation token for one immutable repository ID with `contents:read` only.
Repository identity and branch-to-SHA resolution happen outside the transaction;
no personal GitHub proof is required from the creating member. The final
transaction rechecks the active build, returning `409 cloud_computer_changed`
with a refresh hint if activation changed during the lookup.

The final transaction takes the organization's `cloud_computer_v2_heads` row
`FOR UPDATE`, requires the active template to still be `ready`, and retains
that lock until its source reference commits. C6 retirement claims use the same
head lock and recheck references before claiming `retiring`: if acceptance wins,
retirement sees the committed reference; if retirement wins, acceptance returns
`409 cloud_computer_build_required`. Concurrent Postgres regressions cover both
orderings and the exact head-lock strength. A fork cannot pin a retiring template.

That transaction inserts the generation runtime pin and its
`cloud_workspace_computer_sources` build/template/config tuple together. The
template runtime wins while it remains unrevoked, protocol-compatible and
qualified. Otherwise the existing runtime selector chooses the channel head
eligible for the template's **same physical base**. Failure to find one returns
`409 cloud_runtime_unavailable`; it never changes the allocation to a bare base.
Create replays retain the accepted tuple and skip external repository lookup.

`boat-template:<sandboxId>` allocations resolve through this saved generation.
The provider verifies the source's archived snapshot and configured wallet,
then journals a fork with finite `ttlSeconds`, `noEnv: true`, `env: {}`, the
wallet header and the existing idempotency key. A lost reply repeats that key
and reads the recovered child with GET. A known child is read directly. The
child wallet must match, the child cannot be the source, and conflicting source
echoes are rejected. The saved source and journaled request identity remain
authoritative when Boat omits a source echo. Cleanup retains a bound child ID
even when its subsequent verification fails.

## Checkout and namespace boundary

The C3 template marker `/srv/zeros/computer-template.json` must match the source
manifest delivered through fresh private setup admission. The v4 installer
validates or installs the pinned runtime; copied markers or admission state do
not grant setup or engine authority.

The existing primary clone stays physically at
`/srv/zeros/files/repos/<owner>/<name>`. Setup validates protected ancestry,
Git-dir containment, mount boundaries, the origin URL and GitHub repository ID,
then fetches and checks out the accepted SHA. It verifies exact HEAD after the
checkout. An interrupted initial checkout can resume from the build SHA or the
same accepted SHA. A journaled setup preserves subsequent user edits.

The template path does not clone, stage, seed, move or rename checkout
directories. It installs no host bind beneath `/srv/zeros/files`. Host hooks,
checkpoint restore and storage attestation use the selected physical clone.
The read token arrives only through private setup stdin, stays out of Git argv
and remote URLs, and is revoked before repository hooks. It is not installed as
a persistent credential projection.

A root-only, credential-free `/run/zeros/computer-workspace.json` binds the
source to the current runtime, boot, supervisor session, setup execution fence
and engine instance. On every engine start the launcher validates this document
and binds the physical primary at `/srv/zeros/workspace` **inside the engine's
private mount namespace**. The files projection also exposes every clone
read-write at `/srv/zeros/repos/<owner>/<name>`. Secondary clones remain at their
build SHAs. Setup and broker authority are outside that projection. Legacy and
v4-base checkout paths remain unchanged.

The primary also keeps its `/srv/zeros/repos/<owner>/<name>` alias: dependencies,
virtual environments and shebangs may contain this build-time absolute path.
The launcher publishes only the admitted path pair to the read-only
`/etc/zeros/cloud-workspace-paths.json` projection. The engine verifies protected
marker ownership and that the two physical directories identify the same inode.
Attachment staging and atomic publication use the repository alias on the
shared files mount, while authorization and returned paths keep the registered
workspace path. This avoids cross-bind `EXDEV` without a host workspace mount.
Actor policy mirrors every read/write grant, deny and nested exception across
both primary paths; secondary repositories keep their existing access. Linux
regressions exercise actual bind mounts, chunked and inline publication, Design
and additional read-only fences, read denial, writable exceptions, and rejection
of forged or mismatched path metadata.

## Integration seams

- C3 ([PR #293](https://github.com/Withso/zeros/pull/293)) supplies the ready
  stopped template and sanitation marker. The launcher validates its protected
  repository parents and checkout ownership before installing the admitted
  primary bind inside the engine namespace.
- C4 ([PR #300](https://github.com/Withso/zeros/pull/300)) resolves organization
  environment through `resolveCloudComputerExecutionEnvironment` during setup
  redemption, alongside `resolveComputerWorkspaceSetup` for the saved source
  and org read grant. Both use the accepted config, never a later active head.
  The primary repository's pinned setup commands retain C4's journal and
  explicit retry behavior. Both privilege stages of the host setup worker use
  the admitted physical clone as their working directory.
- B8 ([PR #299](https://github.com/Withso/zeros/pull/299)) calls
  `copyComputerWorkspaceSource(tx, input)` immediately after the generation
  INSERT in `generation-pins.ts`'s `copyGenerationPins`. Explicit recovery,
  automatic recovery and runtime upgrades copy the accepted build/template/config
  atomically. Wake and setup retry reuse the existing generation and source.
  Tests exercise all five paths after activation changes, as well as transaction
  rollback and organization isolation.
- B10 ([PR #298](https://github.com/Withso/zeros/pull/298)) owns `/home/user`
  persistence and its single files bind. The launcher validates protected
  `.zeros-setup` staging and masks it with an inaccessible read-only mount in
  the engine view. Base-image setup and interrupted publication use the seed
  inside that directory. Template setup bypasses staging and rejects nested
  host mounts. Setup, managed settings and logs keep B10's host-owned layout.

## Scripted Alpha verification

Run only from the orchestrator workspace with Alpha credentials, after C3 and
this runtime/control-plane change are deployed and a test computer has a ready
active template built with a runtime containing the C5 checkout helpers. The
eligible template runtime is deliberately retained at acceptance. Use a
disposable Alpha organization/repository and a staff
session with compute entitlement. Normal provisioning, setup and deletion
workers must be running. No live verification is implied by local tests.

Add these names to the private, mode-0600 `.env.agent` file using the established
secure credential workflow; do not put their values in command arguments or
reports:

| Name | Purpose |
| --- | --- |
| `ZEROS_PLANETSCALE_ALPHA_DATABASE` | Must be `zeros-control-plane-alpha`. |
| `ZEROS_C5_ALPHA_DATABASE_URL` | Direct Alpha PlanetScale login allowed to `SET ROLE zeros_app`, with `sslmode=verify-full`. Verify the target belongs to Alpha. The script forces read-only transactions. |
| `ZEROS_C5_ALPHA_ACCESS_TOKEN` | Current authenticated Alpha engineering-staff API session. |
| `ZEROS_C5_ALPHA_ORGANIZATION_ID` | Disposable organization UUID with the ready template. |
| `ZEROS_C5_ALPHA_INSTALLATION_ID` | Installation record UUID from that template's primary config. |
| `ZEROS_C5_ALPHA_REPOSITORY_OWNER` | Lowercase primary owner. |
| `ZEROS_C5_ALPHA_REPOSITORY_NAME` | Lowercase primary repository. |
| `ZEROS_C5_ALPHA_REVISION` | Requested branch or exact commit. |
| `ZEROS_C5_ALPHA_EXPECTED_SHA` | Expected full commit SHA; optional when the revision is already that SHA. |

```sh
pnpm agent:check
pnpm exec tsx scripts/cloud-workspace-validation/template-fork-live-check.mjs
```

The script uses the fixed Alpha API origin and first cross-checks the active
build between API and database. It creates one `zeros-v2-test-c5-<UUID>`
workspace, proves identical create replay and saved source/runtime/SHA, waits
up to 15 minutes for readiness, then requests deletion in `finally`. Another
15-minute budget verifies workspace data deletion and every provider journal
resource's deletion. The source template is never deleted or modified.

A secret-free mode-0600 journal is written before create under
`.context/zeros-v2-test-c5/<runId>.json`. It retains workspace and provider IDs,
the accepted source and cleanup state. After interruption, resume cleanup with
the recorded run UUID:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/template-fork-live-check.mjs --cleanup <runId>
```

Cleanup looks up only that create key and verifies exact organization, workspace
UUID and test name before DELETE. It never issues another create. An ambiguous
missing create row or unconfirmed provider deletion remains `cleanup_pending`;
retain the journal and rerun cleanup after resolving the outage. Copy only the
closed result and recorded resource IDs into the verification report. Database
billing tombstones and accepted-source records retain their normal lifecycle;
provider compute and workspace data must have verified deletion.

This runbook proves the normal create/replay/readiness/delete path. Unit and
local Postgres regressions cover missing-template admission, active-version
races, runtime revocation fallback, lost provider replies, wallet mismatch,
Git/path escape refusal and private checkout transport. It does not claim
independent live inspection of provider request bodies or namespace contents,
nor live wake/upgrade coverage. macOS engine/UI smoke requires a Mac.
