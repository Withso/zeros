# V4 runtime base and installer

The base owns the Python verifier, wrappers, compatibility policy, host marker,
AppArmor policy and systemd units. Runtime bundles own Node and the engine/helper
payload. The installer accepts the single-redemption contract: a descriptor,
short-lived artifact URL, and (for workspace setup) the unchanged nested setup
payload. Runtime installation grants no engine or credential authority.

The fixed transport is:

```sh
/usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock /opt/zeros-bootstrap/install-runtime.sh --stdin
```

Input is at most 64 KiB of base64url JSON on stdin. No input selects a path,
command, policy, host allowlist or environment. The URL is never persisted or
logged. The separate internal install lock serializes direct root invocations
and boot recovery without reacquiring the transport's `setup.lock`.

Archive bytes and SHA-256 are checked before parsing. Raw ustar/PAX headers are
inspected before writing; only per-entry `path` and `linkpath` PAX records are
accepted. Inventory, hashes, modes, ownership, links and extended attributes are
checked through no-follow directory descriptors. Symlinks are created last.
Files/directories are flushed before the runtime directory is renamed. A cached
runtime is fully re-hashed; a missing receipt is reconstructed only from the
fresh descriptor after complete verification. A conflicting cache fails closed.

Publication stops the host and confirms cgroup retirement before journaling the
old/new pointers and switching `current`. `previous` keeps the prior runtime.
Boot reconciles interrupted publication to verified bytes; it never grants
permission to start an old engine against a new generation. Dispatch checks all
file stats and hashes `bin/`, `lib/zeros/`, `worker/dist-engine/` and the manifest,
then publishes a fresh boot/session descriptor and execs the supervisor. An
empty base keeps the host alive in `waiting_for_runtime`.

Every installer/boot exit emits a closed diagnostic. The status probe is the
contract's exception: exactly one `zeros.base-status/v1` JSON line. A killed
process cannot emit a diagnostic; its transport must classify the signal or
missing diagnostic. Setup output is bounded and parsed, never forwarded raw;
the installer preserves known failed checks and mirrors the helper's nonzero
exit code. The helper's successful closed diagnostic is required for success.

## Local checks

```sh
python3 -I -m unittest discover -s scripts/cloud-workspace-validation/runtime-base-v4/tests -v
pnpm exec vitest run scripts/__tests__/cloud-runtime-bootstrap.test.ts scripts/__tests__/cloud-runtime-base-v4.test.ts scripts/__tests__/boat-image-kit.test.ts
pnpm check:actions
```

Tests use an injected temporary root, host adapter, clock and downloader. These
are Python APIs only; production has no test flags or environment overrides.
The local `tests/fixtures/manifest.json` mirrors the approved contract. B1's
golden fixtures were not present on `origin/main` when this implementation was
started; replace the mirror with the shared fixtures when B1 is merged.

## Scripted Alpha verification (operator runbook)

Live verification is pending. This workspace has no Alpha Boat/R2 credentials;
no provider calls, sandbox starts, snapshots or R2 objects were made here.
Amazon Linux's systemd 252 is not PID 1 and cannot qualify DelegateSubgroup or
Ubuntu/AppArmor behavior. The commands below perform that remaining proof.

Use a clean checkout of this PR with `.env.agent` provisioned by the existing
credential setup. It must contain `BOAT_API_KEY`, `BOAT_BILLING_ORG`,
`ZEROS_R2_ALPHA_BUCKET`, `ZEROS_R2_ALPHA_ENDPOINT`,
`ZEROS_R2_ALPHA_ACCESS_KEY_ID` and `ZEROS_R2_ALPHA_SECRET_ACCESS_KEY`. The live
script requires the Alpha bucket `zeros-cloud-workspaces-alpha`. Do not pass
values in arguments, transcripts or PR text. It uses the existing pinned-SSH
channel for installer input and never sends signed URLs in Boat exec commands.

Set `ZEROS_BASE_MAX_USED_HOURS` to an approved **absolute** Boat organization
meter ceiling (the existing kit's budget semantics). Set a new state directory
outside the checkout, and keep it until cleanup is confirmed:

```sh
pnpm agent:check
export ZEROS_BOAT_IMAGE_STATE_DIR="$(mktemp -d /tmp/zeros-v2-test-base.XXXXXX)"
# Example only: use the approved meter ceiling for the Alpha account.
export ZEROS_BASE_MAX_USED_HOURS=12
pnpm tsx scripts/cloud-workspace-validation/boat-image/boat-image.ts runtime-base-v4 live-check \
  --name zeros-v2-test-base-v4-1 --max-used-hours "$ZEROS_BASE_MAX_USED_HOURS"
```

The script performs these steps sequentially (normally three sandbox starts;
the journal refuses more than ten):

1. Create a no-env stock Boat builder without `from`; install OS packages,
   exact UIDs/groups/subids, bootstrap, units, tmpfiles and AppArmor. Fill the
   compatibility protected-file hashes and base provenance. An owned cgroup
   bounds the build to 20 minutes. The kit records create intent before POST.
2. Sanitize and verify the builder; save the previously unused snapshot name.
   Capture `systemd`, glibc, kernel, Python, architecture and measured snapshot
   bytes. Cold boot a disposable clone and verify `/zeros`, enabled/active
   units, delegated cgroups, the exact host marker, empty runtime/private state,
   and `waiting_for_runtime`. Cold-boot checks do not start or repair units.
3. Fetch official Node 22.23.1 and verify its published SHA-256. Build three
   deterministic synthetic archives containing that Node and idle/success
   stubs. Upload create-only objects under
   `runtime-test/zeros-v2-test-<attempt>/`; mint each GET immediately before
   SSH stdin delivery. Install A with the nested setup stub, verify the receipt
   and active descriptor, stop/resume the VM, and verify the new boot/session
   with the same runtime. Measure a full re-hash after resume, dropping the
   page cache when the provider permits it (`coldCache` records the result).
   Install B and require `previous=A`; corrupt C's archive and require the
   closed `archive_digest` failure with B's current pointer/session unchanged.
4. Revoke every temporary SSH key, delete all three R2 objects and confirm each
   with HEAD 404, delete builder/clone and confirm each with GET 404. Keep only
   the final successful base snapshot. Failed builds delete their snapshot.

The last stdout line is `zeros.diagnostic/v1` with `component=base`, `stage=done`,
`ok=true`, `exitCode=0` and empty `failedChecks`. The preceding receipt and
`$ZEROS_BOAT_IMAGE_STATE_DIR/runtime-base-v4/base-receipt.json` contain the
snapshot name/id/size, versions, sandbox-start count, synthetic runtime IDs,
boot/session IDs, re-hash milliseconds and confirmed cleanup. This proves the
installer/base boundary, not agent qualification or the full B3 native closure.
`imageBytes` records Boat's `sizeBytes`, the restored content size of the snapshot.
Do not describe the re-hash as a full production-runtime measurement; report
the synthetic archive's `expandedBytes` and `fileCount` alongside the timing.

After interruption or failure, use the **same state directory**:

```sh
pnpm tsx scripts/cloud-workspace-validation/boat-image/boat-image.ts runtime-base-v4 status
pnpm tsx scripts/cloud-workspace-validation/boat-image/boat-image.ts runtime-base-v4 cleanup
```

Cleanup replays only unresolved create identities within the kit's 23-hour
window, never scans/deletes unrelated account resources, and fails closed when
absence cannot be confirmed. Do not delete the state directory while cleanup
is pending. Once confirmed, retry with a fresh state directory and name
`zeros-v2-test-base-v4-2`; include the previous attempt's starts in the overall
ten-start budget. Send the receipt and closed diagnostics to the orchestrator
for review; neither raw command logs nor URLs/keys belong in the report.

For a base-only build (also the manual `Cloud runtime base` workflow), replace
`live-check` with `build`. This requires only Boat credentials and proves the
clean cold boot. Its receipt explicitly reports `synthetic_runtime_pending`.
The workflow is dispatch-only, Alpha-only, independent of runtime release jobs,
and uses the existing Boat secret/organization variable. B5 owns control-plane
registration; this PR does not dispatch, deploy or register a base.
