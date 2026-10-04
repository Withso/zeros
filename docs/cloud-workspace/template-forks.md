# Cloud Computer template workspace creation

Engineering staff (`developer` and `platform_owner`) creating a workspace in an
organization with a `cloud_computer_v2_heads` row use that computer's active,
successful build and ready, stopped template. A missing ready active template
returns `409 cloud_computer_build_required` before repository lookup or provider
allocation. This path has no shared-base fallback. Non-staff and organizations
without a v2 head retain the existing image and v4-base selection behavior.

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

## Integration seams

- C3 ([PR #293](https://github.com/Withso/zeros/pull/293)) supplies the ready
  stopped template and sanitation marker. Its launcher
  repository projection validation and C5's admitted primary bind must both be
  retained when resolving the shared launcher changes.
- C4 ([PR #300](https://github.com/Withso/zeros/pull/300)) attaches organization
  environment and per-repository setup resolution to
  `resolveComputerWorkspaceSetup` in
  `apps/control-plane/src/cloud-workspaces/computer-workspace-source.ts`.
  It receives the saved config/source, never a later active head. Retain C4's
  `resolveCloudComputerExecutionEnvironment` call in setup-material redemption
  when combining these changes. Host hooks use the physical primary path.
  This change does not implement C4 configuration.
- B8 ([PR #299](https://github.com/Withso/zeros/pull/299)) must import the helper
  below and add `await copyComputerWorkspaceSource(tx, input)` after the
  generation INSERT in `generation-pins.ts`'s `copyGenerationPins`. The API is
  `copyComputerWorkspaceSource(tx, { workspaceId, organizationId,
  sourceGeneration, targetGeneration })` in the generation insertion transaction
  for wake/retry/recovery/upgrade. Tests cover copying the accepted source after
  activation changes, transaction rollback and organization isolation. This
  change does not wire that helper into B8's lifecycle implementation.
- B10 ([PR #298](https://github.com/Withso/zeros/pull/298)) owns `/home/user`
  persistence and its single files bind. Preserve its
  protected `.zeros-setup` staging validation and engine masking together with
  the admitted `repos`/primary projection when merging the shared launcher and
  view files. C5 never uses that staging path for templates and rejects nested
  host mounts. B10 owns non-template staging and host-owned setup/settings/log
  publication; those paths are not moved by this change.

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
nor wake/upgrade coverage owned by B8. macOS engine/UI smoke requires a Mac.
