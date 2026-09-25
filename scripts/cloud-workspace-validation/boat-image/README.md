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
