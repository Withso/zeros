# Boat image kit

Rebuilds the Zeros cloud runtime as a Boat named snapshot from one exact merged
commit. The control plane selects the result with `BOAT_SNAPSHOT_ID` and
`BOAT_IMAGE_BUILD_SHA256` (see
[provider contract](../../../docs/cloud-workspace/provider-contract.md)).

Rebuild when an image contract input changes (`imageContractSha256()` in
[`../config.ts`](../config.ts)), or when the image should ship a newer engine,
runtime dependency or native binding. A snapshot stays usable for later commits
whose image contract is unchanged.

The build runs natively on a builder sandbox created from the previous
qualified snapshot:

1. install the exported source and build it under an owned process scope;
2. run the runtime's own attestation (`attest-cloud-worker.mjs`);
3. sanitize the builder and prove no private state remains;
4. save the named snapshot `zeros-qualification-<commit12>`.

The scripts in [`templates/`](templates) are derived from the ones that built
and qualified `zeros-qualification-aa11196c97a6`. The kit fills in the commit,
the image contract, a fresh attempt identity and the measured build digest.
Tests pin the filled build script to that qualified build.

## Requirements

- A clean checkout at the merged commit being built. Every step refuses a dirty
  checkout: the archive and the image contract must describe the same commit.
- `BOAT_API_KEY` and `BOAT_BILLING_ORG` in `.env.agent` or the environment. The
  key needs `sandbox.create`, `sandbox.read`, `sandbox.update`, `sandbox.stop`,
  `sandbox.resume`, `sandbox.delete`, `exec`, `file.write`, `snapshot.read`,
  `snapshot.write` and `account.read`. Account admin is not needed.
- Fewer than 10 named snapshots in the account.
- About one hour of builder time on a `default` machine. Every start and lease
  renewal requires `--max-used-hours`, and stops once Boat's organization meter
  (`creditUsedSeconds`) reaches it.

State, receipts and the source archive are written with mode 0600 to
`ZEROS_BOAT_IMAGE_STATE_DIR`, or `~/.zeros/boat-image`. The state directory must
be outside the repository. Each builder command's output is kept under
`commands/`, and every provider action is appended to `ledger.jsonl`.

## Runbook

```sh
KIT="pnpm exec tsx scripts/cloud-workspace-validation/boat-image/boat-image.ts"
STATE="${ZEROS_BOAT_IMAGE_STATE_DIR:-$HOME/.zeros/boat-image}"
C12="$(git rev-parse --short=12 HEAD)"

# 1. Builder from the current qualified snapshot. Repeating a create whose
#    response was lost replays it with the same idempotency key.
$KIT builder create --from zeros-qualification-aa11196c97a6 --max-used-hours 9
$KIT builder status                       # wait for "ready", "idle" or "running"
$KIT builder run scripts/cloud-workspace-validation/boat-image/templates/build-hash.sh
                                          # "commit" is the builder's previous commit

# 2. Export the source and generate the scripts for this attempt.
$KIT export
$KIT generate --previous <previous commit>

# 3. Build. install.sh starts the owned runner and returns immediately.
$KIT builder run "$STATE/$C12/builder-preflight.sh"
$KIT builder upload
$KIT builder run "$STATE/$C12/install.sh" 120
$KIT builder run "$STATE/$C12/build-status.sh"   # repeat until "result" is set
                                                 # and result.passed is true

# 4. Attest the runtime, then bind sanitation to the measured build.
$KIT attestation start
$KIT attestation status                   # repeat until "finished": true
$KIT generate-post
$KIT builder run "$STATE/$C12/private-state.sh"  # read-only inventory

# 5. Save the snapshot, then delete the builder once it is ready.
$KIT snapshot save
$KIT snapshot status                      # repeat until "ready"
$KIT builder delete
```

Renew the builder lease with `builder renew --max-used-hours 9` when a step
runs long. Stop an idle builder with `builder stop` and continue later with
`builder resume --max-used-hours 9`. The build itself times out after 20
minutes.

`snapshot save` refuses unless the saved attestation is qualified and secure
for this commit and build, the name is unused, and a sanitation run within the
last 60 seconds found no credentials, agent history, coordinator state,
admission proof, bootstrap keys, cgroups or supervisor socket. The save is
recorded in `snapshot-ledger.json` before the request is sent. If the response
is lost, run `snapshot status` before retrying.

## After the snapshot is ready

`snapshot status` prints the two Railway values. Set them on one environment
at a time, starting with Alpha. `attestation status` also reports the measured
disk as `measuredStorageMiB`; if it differs from `CLOUD_WORKSPACE_STORAGE_MIB`,
update that variable too. Qualify the environment on the new image before
promoting the values to Beta or Production.

Delete a previous snapshot only after no environment references it and no
workspace needs it for rollback.

## Organization images

Cloud Computer uses the same sanitation and worker-attestation scripts, extracted
into `apps/control-plane/src/cloud-workspaces/computer-image-scripts.ts` so they
ship in the control-plane deployment. The template files remain compatibility
fixtures. No member, GitHub, engine-registration, setup, or agent credential is
provided to the dedicated builder or its verification clone.

Recipes run as uid 10004 in a disposable namespace with a read-only system and
runtime, private temporary home, and one writable installation prefix:
`$PREFIX=/usr/local/zeros-computer`. Install additional tools under `$PREFIX/bin`
and data under that prefix. Sanitized tools are linked into `/usr/local/bin`;
replacing existing tools, root package installation, and escaping links are
rejected. Repository selection is workspace policy; builds do not clone private
repositories. Recipes must not contain secrets. Known credential/history files
are removed, and recognizable credential material elsewhere rejects sanitation.

The build metadata binds the recipe digest, output digest, exact base image and
artifact UUID. Capture is followed by a fresh clone that verifies the output and
runs `attest-cloud-worker.mjs`. Runtime attestation **does not reuse the base's
agent qualification**. Before activation, the operator must qualify the exact
new `boat:<name>@sha256:<build>` through the existing runtime qualification
workflow, for every enabled credential kind and contract on the base. This is
deliberately a separate operator trust boundary: the web service cannot grant
itself permission to use stored agent credentials. A changed base requires a
rebuild; neither activation nor allocation silently falls back to another image.

Admission reserves one of Boat's ten named slots under an account-scoped
database lock, counting provider inventory plus outstanding reservations.
Only managed `zeros-org-<uuid>` artifacts can be retired. The active image,
previous image for rollback, every generation reference (including stopped or
archived generations), all configured deployment bases, and base dependencies
protect an artifact. Configured bases are pinned in
`cloud_computer_image_base_references` at the Boat account scope, before image
admission and worker reconciliation. These pins survive rolling deployments and
rollback indefinitely; runtime workers cannot remove them. Install migration
0117 and its retirement guard before promoting a managed org snapshot as a
deployment base. A promotion that races with retirement fails closed; it must
never proceed using an image that has begun retirement. Every deployment that
shares the Boat account must use this same protection database. The worker
rechecks durable references under the account lock before deleting a snapshot.
Unreferenced
artifacts older than seven days are retired by the worker. External release
builders must still observe the account cap; a concurrent external capture can
cause a safe provider refusal. Never remove release/base snapshots to make room.

Build and cleanup phases are durable. Each create is journaled immediately
before provider dispatch, after local validation. A certified Boat refusal
closes only that attempt, never an earlier uncertain dispatch. Never-dispatched
and wholly rejected creates release their slots without allocating cleanup VMs.
Ambiguous provider outcomes retain their slot and identity for reconciliation;
blocked replays do not prevent receipt-backed deletion of other known VMs.
Legacy workspace-based builds are shown
as legacy and cannot activate an image. New workspace admission pins the image;
activating or rolling back does not modify existing workspace generations.
Both default and explicitly selected hosted Boat connections use the active
organization image. An explicit workspace upgrade selects that image into a
new generation; retries retain the originally accepted image. Delegated
customer connections keep their own provider's
qualified profile and snapshot account.
