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
Symlink header permission bits are ignored; their type and confined target
remain mandatory. Paths and link targets are at most 4,096 UTF-8 bytes and
reject NUL, backslash, CR and LF. Inventory paths have at most 128 components;
link resolution is bounded to 64 links and checks lexical containment separately.
Verification and staging cleanup are iterative, including cleanup of deeper
partial trees left by an earlier installer. Every listed entrypoint must be a
regular file; `selfTest` may be omitted. Receipt `fileCount` counts regular files.
Extraction creates and fills the final runtime directory directly. Every file
and directory is flushed and fully verified there before the receipt is
published. Before switching `current`, the installer also runs dispatch's
installed-tree and receipt verifier. A cached runtime with a matching receipt
is fully re-hashed; a corrupt receipted inventory fails closed. Missing or
mismatched receipts require deleting the incomplete tree and extracting fresh
bytes, rather than reconstructing a receipt from leftover files.

Publication stops the host and confirms cgroup retirement before journaling the
old/new pointers and switching `current`. `previous` keeps the prior runtime.
Boot and installation retries reconcile interrupted publication to verified bytes; they never grant
permission to start an old engine against a new generation. Dispatch checks all
file stats and hashes `bin/`, `lib/zeros/`, `worker/dist-engine/` and the manifest,
then publishes a fresh boot/session descriptor and execs the supervisor. An
empty base keeps the host alive in `waiting_for_runtime`.

Deterministic dispatch verification failures exit 65 and are excluded from
automatic restarts. Other failures have a five-second delay and a three-start
limit within 60 seconds. The status probe then reports `hostState=failed` in
its existing schema; the closed check is in the unit's final diagnostic and
private failure record. A later verified install explicitly resets the unit's
failed/start-limit state before starting its selected runtime.

Every installer/boot exit emits a closed diagnostic. The status probe is the
contract's exception: exactly one `zeros.base-status/v1` JSON line. A killed
process cannot emit a diagnostic; its transport must classify the signal or
missing diagnostic. For workspace setup, the helper's stdout passes through
unchanged within the existing 256 KiB Boat setup bound. A newline separator is
added if the helper did not end its output with one, then exactly one final
installer diagnostic follows. The helper needs no new diagnostic format.
Its nonzero exit code is mirrored with stage `run_setup` and only `setup_exit`;
nested checks never enter the installer's vocabulary. Before the helper runs,
failures print only the installer diagnostic. Helper stderr is withheld.

Bootstrap failures also record the fixed source/function/line of each assertion
in `/run/zeros/bootstrap-failures.jsonl` (root-only 0600, at most 64 KiB). This
distinguishes assertions with the same public check without putting paths,
inputs, exception messages or URLs in the closed diagnostic.
For an OS error it retains the original allowlisted exception class, numeric
and symbolic errno, and innermost bootstrap function/line from the traceback.
The public diagnostic still uses the same closed stage/check mapping.

## Boat directory persistence

Boat's measured stop/resume behavior (design contracts §§22–23) reverts a
directory rename if the directory existed at the preceding stop, except under
`/home/user`. The old path can return with old contents while the new path is
empty, partial or duplicated. The same failure occurs on forks of stopped
templates. Renamed regular files and symlinks persist. Directory renames under
`/home/user`, including through a bind mount, persist correctly;
`/home/user/.cache` is not persisted at all. V4 never publishes a runtime by
renaming a directory.

After archive validation, the installer durably creates the root-only 0600
sidecar `/opt/zeros-infra/<runtimeId>.incomplete` before creating the fresh final
directory `R`. The sidecar stays outside the manifest inventory. Installation
then extracts into `R`, verifies and flushes it, atomically publishes the receipt
with a regular-file rename, removes/fsyncs the marker, and atomically replaces
the `current` symlink. Dispatch rejects any marked runtime, even if a receipt
has already been written.

Boot and install retries remove marked trees and trees without matching
manifest/receipt metadata through the same iterative no-follow cleanup. They
also remove orphan receipts and dangling current/previous pointers. Cleanup
keeps a marker until deletion finishes so an interrupted cleanup is retryable.
An install retires a host using an affected `current` before deleting it;
boot reconciliation runs before the host starts. Valid previous runtimes are
retained, with no automatic engine restart or download during boot. A later
install downloads and extracts the requested incomplete runtime again. A
complete, verified runtime whose marker was already removed can be reused
after a crash before the pointer switch.

The rename audit covers the v4 bootstrap, kit upload/build path, shared owned
build runner, and v4 build/sanitize/verify templates. Bootstrap renames only
regular metadata files and symlinks; the kit atomically renames regular private
JSON state files. Uploaded/build files are written at their final paths, and
sanitation only deletes. The separate legacy v3 `boat-image/templates/install.sh`
still contains directory moves and is outside this v4 profile's changes; it
requires a separate compatibility fix before reuse with this Boat behavior.

## Mutable storage on every boot and restore

Boat can restore `/home/user` through the temporary `ascii-lazyfs` FUSE mount
while hydrating the real disk in the background. Boot must not pin that mount
in its persistence binds. When `/var/lib/ascii-lazy` exists, boot waits for both
its regular `hydration-done` marker and absence of any FUSE mount at or below
`/home/user`, before opening that directory. It polls once per second for at
most 480 seconds. Fresh builders without this provider state proceed immediately.
The pre-bind check also rejects opened FUSE or detached sources, and every
subsequent verification explicitly rejects FUSE-backed binds.

The same hydration gate runs at the start of `Bootstrap.base()`, before any
compatibility/protected-file read or ownership check. It covers direct base
verification, boot, installation, dispatch and status, including setup invoked
immediately after a wake. The separate pre-bind guard remains. Once hydration
finishes, the existing strict verification runs unchanged; timeout and persistent
corruption still fail closed. The orchestrator's `b31b2348` live run identified
this earlier boundary: a runtime probe reached `app.base()` during lazy restore,
before its unit-readiness wait.

The value-free `persistence_hydration_wait`, `persistence_hydration_ready` and
`persistence_hydration_timeout` journal events report only elapsed seconds.
A stalled restore exits with the closed `timeout` check (124, `timedOut: true`)
and publishes no readiness. Unit-readiness probes allow 540 seconds; cold-base
and live-persistence commands allow 600 seconds, within the existing Boat exec
cap. This leaves time for host startup and verification after hydration.

The base creates `/home/user/.zeros-persist` as root:root 0755 and binds the
following directories before publishing readiness. These are fresh v4 bases;
the backing tree is authoritative, and this layout does not migrate v3 data.
Boat capture can leave directory skeletons or stale copies in the covered
mount-point directories when it stops with binds active. On restore, mounts
are gone but this residue remains. Before each missing bind, boot removes the
uncovered destination's contents with an iterative descriptor-relative walk.
It never follows symlinks or crosses mounts (including same-filesystem binds).
Destination ownership/mode, symlink, wrong-source, stacked and nested-mount
checks still fail closed before accepting work. Backing data is never migrated
from or replaced by residue.

Each cleared destination emits a value-free `persistence_residue_cleared`
event with directory/file/symlink/other counts to stderr (the unit journal).
Stdout retains its single closed diagnostic. The current boot's aggregate
counts are stored root-only (0600) in `/run/zeros/persistence-residue.json`;
boot discards stale evidence before attempting recovery. Re-running boot with
valid mounts performs no deletion and records zero counts.

| Logical host path | Backing path relative to `.zeros-persist` | Owner/group and mode | Contents |
| --- | --- | --- | --- |
| `/srv/zeros/files` | `files` | root:root 0755 | Checkouts, `repos`, attachments, and empty engine mount points. |
| `/srv/zeros/state` | `state` | 10003:10003 0700 | Engine SQLite, native histories, workspace state; `workspaces` retains 10003:10003 0700. |
| `/srv/zeros/home` | `home` | root:root 0755 | Agent home 10001:10001 0755 and capture home 10002:10002 0700. |
| `/srv/zeros/repos` | `files/repos` | root:root 0755 | Alias of `/srv/zeros/files/repos`; preserves C3's `/srv/zeros/repos/<owner>/<name>` build paths. |

Only these four binds exist on the host. `/srv/zeros/setup` remains root:root
0700, and `/srv/zeros/{log,managed-settings}` remain root:10001 0750 at their
existing physical paths. They hold host-owned regular files (settings remain
root:10001 0640) and use file publication only, without directory renames or
user/agent-mutable trees. The engine still receives its existing read-only
managed-settings copy; setup journals are never exposed.
`/srv/zeros/runtime-installs` and `/opt/zeros/sessions` remain root-only metadata
with atomic file publication. Immutable runtime directories stay at their final
`/opt/zeros-infra/r1-*` paths. `/run/zeros`, namespace views and `/tmp` remain
ephemeral. No persistent data is placed in the provider's `.cache`.

V4 clone staging and the seed backup live under
`/srv/zeros/files/.zeros-setup`: a root:10001 0710 parent containing private
10001:10001 0700 operation directories and `seed`. The group execute bit lets
the unprivileged Git process reach its staging checkout/home while root controls
the parent's entries. All clone, backup and recovery directory renames stay
within the files bind and therefore within Boat's persisted home tree. The
legacy staging/seed paths in `runtime-layout.json` retain their v1–v3 meaning.
The template-fork setup path belongs to C5 and must use the already populated
repository without clone/rename publication. Its selected
`/srv/zeros/files/repos/<owner>/<name>` is projected to `/srv/zeros/workspace`
inside the engine's private mount namespace on each start, from the admitted
manifest. There is no host child mount below `files`; boot continues to reject
unexpected host submounts there.

The engine still projects `files` as `/srv/zeros`, so its `repos` directory is the
same physical tree as both host aliases. The v4 launcher admits `repos` and masks
`.zeros-setup` with an empty, inaccessible, read-only tmpfs. Boot recreates the
empty `files/{state,managed-settings,home/agent,home/capture}` overlay targets
after sanitation; it refuses populated or redirected targets. `/home/user`,
setup journals, bootstrap authority and broker sockets remain hidden. B2's
runtime resolver and B9's attester retain their path and mount contracts; neither
needs a schema or implementation change for these data binds.

Directory creation uses component-wise no-follow descriptors, checks owners and
modes, and passes pinned descriptors to the fixed `mount --bind` command. Each
bind must match the kernel mount table (source filesystem/root and exact target)
and the backing directory's device/inode. Read-only, stacked, unexpected nested
or redirected mounts fail closed. A partial failure leaves no readiness record;
the next boot verifies existing binds and creates only missing ones.

Boot publishes `/run/zeros/persistence.json` atomically, root-only 0600, only
after mounts and runtime reconciliation succeed. It includes the kernel boot
ID, a digest of the machine ID and the verified bind identities. Installer,
dispatch and readiness probes compare it with the current kernel/filesystem
state before accepting work; an active host reports `failed` when readiness is invalid.
The existing closed checks (`base_compatibility`, `root_ownership`, `file_mode`,
`timeout`) cover failures. Boot also fills a missing/empty regular
`/etc/machine-id` using a random UUID and atomic file publication, preserving a
valid nonempty ID. Symlinks, hard links, FIFOs and malformed IDs are rejected.

Base sanitation preserves `.zeros-persist` and the bind roots, including the
shared `files/repos` inode; it clears only empty-base private contents. Template
sanitation may remove empty projection/staging directories, which boot recreates.

## Boat restore and early-boot dependencies

The orchestrator's Alpha restore/resume experiment showed that Boat overlays
the saved filesystem onto a VM whose stock image has already completed early
boot, then starts the enabled Zeros units. Files restored under `/etc` arrive
after services such as AppArmor, tmpfiles, sysctl, sysusers, modules-load and
udev have run. Their earlier success does not apply the restored configuration.

Every `zeros-boot.service` invocation verifies the base's protected files,
restores the facade and runtime directories, and runs the fixed command
`/usr/sbin/apparmor_parser -r -W /etc/apparmor.d/zeros-cloud-engine`. Reloading is
idempotent and also happens when the kernel boot ID has not changed. It is
bounded to 30 seconds, suppresses command stdout/stderr, and fails with the
closed bootstrap check `apparmor` if execution, loading or timeout fails.
`zeros-host.service` requires this oneshot to complete successfully.
Sanitation and verification wait for boot `active/exited` and host
`active/running`, an empty delegation parent, enabled CPU/memory/PID controllers,
and all four dispatch-written host limits before probing the policy or facade.
This gate polls for at most 540 seconds, including hydration; systemd's `active` state alone can
precede a `Type=simple` service's initialization.

The base dependency audit is:

| Dependency | Build/persistence | Restore action |
| --- | --- | --- |
| AppArmor policy | `build.sh` installs the protected profile and initially loads it. | `Bootstrap.boot()` reloads the verified profile into the current kernel before publishing boot readiness. |
| `/zeros`, facade links, `/run/zeros` | `zeros.conf` supplies the alias and root-only runtime directory. | `Bootstrap.layout()` recreates and validates them directly, including ownership and modes, without relying on the earlier tmpfiles service. |
| UIDs/groups 10001–10004 and subuid/subgid mappings | `build.sh` writes the account databases with `groupadd`, `useradd` and `usermod`; directory ownership is on disk. | The restored databases/directories are verified; there are no v4 sysusers rules to replay. |
| Cgroup controllers and host limits | The service delegates CPU, memory and PIDs with `DelegateSubgroup=host`. | `SystemHost.cgroup()` checks the actual subtree, enables controllers and writes host limits on each dispatch. |
| Sysctl, kernel modules and udev | The v4 profile installs no sysctl overrides, modules-load/modprobe configuration or udev rules. | No additional replay was identified in this base profile; stock kernel/device capabilities still require live qualification. |
| Mutable data binds and machine ID | Boot creates the §23 backing layout; template sanitation can empty the machine ID. | Boot revalidates/recreates all four binds and fills an empty machine ID before publishing readiness; it does not rely on early-boot mount or machine-ID services. |

## Local checks

```sh
python3 -I -m unittest discover -s scripts/cloud-workspace-validation/runtime-base-v4/tests -v
pnpm exec vitest run scripts/__tests__/cloud-runtime-bootstrap.test.ts scripts/__tests__/cloud-runtime-base-v4.test.ts scripts/__tests__/boat-image-kit.test.ts
pnpm check:actions
```

Tests use an injected temporary root, host adapter, clock and downloader. These
are Python APIs only; production has no test flags or environment overrides.
Tests consume B1's golden fixtures from its merge in PR #280, including the
§16 installer checks and §17 boundary cases. A verbatim pinned snapshot and its source commit are
under `tests/fixtures/`; tests automatically prefer the shared protocol fixture
directory when present and exercise both selection paths. Each manifest uses
its own matching descriptor; shared-schema ABI limits remain distinct from
the base's ABI pin. The fixture README describes the additional lexical escape
case and raw-digest checks for changes to canonical serialization. The live
synthetic generator is exercised through install, a fresh dispatcher, and
boot followed by dispatch, with additional executable-directory symlink cases.
Tests prohibit directory renames during that synthetic installation, exercise
all marker/receipt and pointer-switch crash boundaries with and without an
intervening boot, and reproduce the empty-runtime/retained-receipt restore
failure. They also interrupt cleanup and verify deep-tree removal without
following links outside the incomplete runtime.

## Scripted Alpha verification (operator runbook)

The orchestrator reported an end-to-end Alpha pass at `37b0d8ad`: stock build,
snapshot, cold verification, synthetic install A, persistent stop/resume,
install B with `previous=A`, rejection of corrupted C, and cleanup. Only the
base snapshot named `zeros-v2-test-base-v4-1` was retained. No provider calls,
sandbox starts, snapshots or R2 objects were made from this workspace.
Amazon Linux's local systemd 252 is not PID 1 and cannot qualify
DelegateSubgroup or Ubuntu/AppArmor behavior. The commands below reproduce
the operator's live verification.

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
export ZEROS_BOAT_IMAGE_STATE_DIR="$(mktemp -d /tmp/zeros-v2-test-base-v4-b10.XXXXXX)"
# Example only: use the approved meter ceiling for the Alpha account.
export ZEROS_BASE_MAX_USED_HOURS=12
pnpm tsx scripts/cloud-workspace-validation/boat-image/boat-image.ts runtime-base-v4 live-check \
  --name zeros-v2-test-base-v4-b10-1 --max-used-hours "$ZEROS_BASE_MAX_USED_HOURS"
```

Use a previously unused snapshot name for each attempt. B10 has only local
verification from this workspace. The orchestrator's two runs of `3c886c66`
confirmed hydration, residue clearing, cold boot, install A and the first
restore. A later live-check step failed without enough evidence to identify
it. The private step records below support the next credentialed rerun.

The script performs these steps sequentially (normally four sandbox starts;
the journal refuses more than ten):

1. Create a no-env stock Boat builder without `from`; install OS packages,
   exact UIDs/groups/subids, bootstrap, units, tmpfiles and AppArmor. Fill the
   compatibility protected-file hashes and base provenance. An owned cgroup
   bounds the build to 20 minutes. The kit records create intent before POST.
   Build state is bound to `BOAT_BILLING_ORG`; each adopted builder/verification
   VM and each resume revalidates Boat's `team.id`. `ready`, `idle` and `running`
   are command-ready states. Error, cancellation and unexpected archival fail
   closed. Only `/opt` itself is normalized to root ownership/mode 0755;
   provider-managed children keep their original ownership.
2. Sanitize and verify the builder; save the previously unused snapshot name.
   Capture `systemd`, glibc, kernel, Python, architecture and measured snapshot
   bytes. Cold boot a disposable clone and verify `/zeros`, enabled/active
   units, delegated cgroups, the exact host marker, empty runtime/private state,
   `waiting_for_runtime`, all four persistence binds, repo alias identity and a
   valid machine ID. Cold-boot checks do not start or repair units.
   Sanitation and verification wait for both units to be active, the boot
   oneshot to complete, and dispatch's cgroup limits before reading the facade
   or cleaning session state. The workflow's `build` and `live-check` both use
   the same `buildBase` sanitize → verify → snapshot sequence, with binds
   active; there is no separate live-check snapshot/unmount path.
3. Fetch official Node 22.23.1 and verify its published SHA-256. Build three
   deterministic synthetic archives containing that Node, idle/success
   stubs and a symlink with a 0555 archive header. The setup stub prints the
   legacy result shape. Upload create-only objects under
   `runtime-test/zeros-v2-test-<attempt>/`; mint each GET immediately before
   SSH stdin delivery. Install A with the nested setup stub, verify the receipt
   and active descriptor. As UID 10001, seed two directory trees under
   `/srv/zeros/files/zeros-v2-test-persistence`, then clear `/etc/machine-id` to
   model template sanitation. Stop/resume **with all four binds active**,
   require zeros-boot to complete, zeros-host to become ready, fresh positive
   residue-clearing counts, the restored binds and regenerated ID. Rename one tree in the same parent and the other
   across parents. Write new content after each rename. Stop/resume a second
   time **with the binds still active**, again require fresh positive cleanup
   counts and ready units, both old paths absent and both old/new contents
   intact, and recheck all binds and the repo alias. `live.persistence` records
   `hostReady`, `residueCleared`, `residueEntries` and `residueMounts` for each
   phase; both resume phases must confirm residue was actually cleared.
   Every persistence probe (cold clone and both resumes) also requires
   `bindFilesystem: "ext4"` for all four binds; a remaining FUSE mount fails.
   Each resume must produce a new
   boot/session with the same runtime. Measure a full re-hash after the first resume, dropping the
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
boot/session IDs, re-hash milliseconds, four `live.persistence` phase results
(`cold`, `seed`, `rename`, `verify`) and confirmed cleanup. Each phase records
only the bind count and boolean/count assertions, never machine-ID bytes. The
last phase requires `bindCount=4`, `repoAliases=true`, `machineIdPresent=true`,
`renames=2`, and `oldPathsAbsent=true`. This proves the
installer/base boundary, not agent qualification or the full B3 native closure.
`imageBytes` records Boat's `sizeBytes`, the restored content size of the snapshot.
Do not describe the re-hash as a full production-runtime measurement; report
the synthetic archive's `expandedBytes` and `fileCount` alongside the timing.

The live portion also records each named step under
`$ZEROS_BOAT_IMAGE_STATE_DIR/runtime-base-v4/private/live-check/<step>.json`
(0600, parent directories 0700). A durable `running` record precedes each
operation; it becomes `passed` or `failed`. Failures retain the closed outer
diagnostic, and `private/live-check-failure.json` names the most recent failing
step. Individual records survive subsequent cleanup failures. The stderr event
`live_check_failure` prints only that fixed step name; the stdout diagnostic
schema is unchanged. No operation inputs, helper output, URLs, exception
messages, command stderr or environments are stored in these records.

The step names distinguish `install_a`, `runtime_a`, `persistence_cold`,
`persistence_seed`, each `stop_first`/`resume_first` and `stop_second`/`resume_second`,
`runtime_after_first_resume`, `persistence_rename`, `persistence_verify`,
`runtime_after_second_resume`, `install_b`, `runtime_b`, `install_corrupt_c`
and `runtime_after_corrupt`. Archive creation, the three uploads and object
cleanup have their own records. `<step>-installer.json` retains the validated
installer stage, `ok`, `exitCode`, `timedOut` and `failedChecks` before SSH key
revocation; it is also attached to a failing install step. A rejected corrupted
C with `archive_digest` is the expected result, so that step is marked passed.

Runtime and persistence probes retain only the allowlisted exception class and
innermost line in `runtime_probe.py` or `persistence_probe.py`. This includes
the persistence probe's unprivileged child; errors are not flattened into its
parent's wait assertion. The two scripts are operator payloads, not installed
base assets. A provider timeout or killed probe may have no Python evidence;
the named step still records the closed transport failure.

Both post-resume probes call `app.wait_ready()` before `app.base()` or inspecting
runtime/persistence state. That waits for completed boot, hydration and host cgroup
initialization. Only afterward does the runtime probe start its separate
30-second wait for `active-runtime.json`, followed by full hashing and a
10-second Node version check. The remote command allows 600 seconds total.
A local regression simulates a 400-second hydration wait before the active
descriptor arrives. Another covers each bootstrap entry point while protected
files are incomplete, the marker is absent and FUSE is active; verification starts
only after restoration completes. Timeout bounds remain unchanged. Named evidence
distinguishes a probe assertion, Node timeout and transport timeout.

After interruption or failure, use the **same state directory**:

```sh
pnpm tsx scripts/cloud-workspace-validation/boat-image/boat-image.ts runtime-base-v4 status
pnpm tsx scripts/cloud-workspace-validation/boat-image/boat-image.ts runtime-base-v4 cleanup
```

For an operator debugging a failure, add the bare `--keep-on-failure` flag to
`live-check` (it is unavailable on `build` and is not used by the workflow):

```sh
pnpm tsx scripts/cloud-workspace-validation/boat-image/boat-image.ts runtime-base-v4 live-check \
  --name zeros-v2-test-base-v4-b10-2 --max-used-hours "$ZEROS_BASE_MAX_USED_HOURS" --keep-on-failure
```

On failure the final stdout diagnostic remains closed, private evidence is
captured, and `state.json` records `keptOnFailure.sandboxes`. The builder,
verification VM, candidate snapshot, owned R2 objects and local synthetic
archives remain available for inspection. Temporary SSH keys are still revoked.
Use `status` to see the retained IDs, inspect private evidence locally, then
run the existing `cleanup` command above to delete owned objects/snapshot/VMs
and confirm their absence. The retention marker is cleared after VM/snapshot
cleanup succeeds. Successful runs perform normal cleanup even with the flag.

Cleanup replays only unresolved create identities within the kit's 23-hour
window, never scans/deletes unrelated account resources, and fails closed when
absence cannot be confirmed. A durable `pending-delete.json` retains each VM ID
until GET returns 404, including when the process dies after DELETE acceptance.
Definitively rejected R2 PUTs (including 412) grant no cleanup ownership of the
existing object; successful and ambiguous PUTs remain cleanup-owned. Old state
without a billing-organization binding can be used for deletion, not a new build.
Do not delete the state directory while cleanup
is pending. Once confirmed, retry with a fresh state directory and name
`zeros-v2-test-base-v4-b10-2`; include the previous attempt's starts in the overall
ten-start budget. Send the receipt and closed diagnostics to the orchestrator
for review; neither raw command logs nor URLs/keys belong in the report.

Before deleting a failed builder or verification VM, the kit keeps bounded,
redacted tails of the build log, both units' systemctl status, the last 200
journal lines for `zeros-host.service`/`zeros-boot.service`, and
the bootstrap assertion log under
`$ZEROS_BOAT_IMAGE_STATE_DIR/runtime-base-v4/private/m2-build-<attempt>/<sandboxId>/`.
Directories are 0700; files are 0600 and at most 32 KiB each. `capture.json`
records availability with fixed labels. The build log is captured before
sanitation removes its remote copy. Capture failure never prevents cleanup or
replaces the original failure. These files are not printed or uploaded by the
workflow; inspect them locally and report only the relevant closed checks/sites.
Unexpected kit failures, including wrapped build/provider exceptions, print only an allowlisted error
class/code to stderr (for example `Error (ERR_MODULE_NOT_FOUND)`), with no message
or stack; the final stdout diagnostic remains closed.

For a base-only build (also the manual `Cloud runtime base` workflow), replace
`live-check` with `build`. This requires only Boat credentials and proves the
clean cold boot. Its receipt explicitly reports `synthetic_runtime_pending`.
The workflow is dispatch-only, Alpha-only, independent of runtime release jobs,
and uses the existing Boat secret/organization variable. After build, cold-boot
verification and cleanup succeed, its final step registers the retained named
snapshot at `POST /internal/v1/runtime-bases` using GitHub Actions OIDC. The
receipt's additive `compatibilityRawB64` field preserves the exact public
compatibility contract bytes, checked against the proven `baseCompatibilityId`.
Older receipts without those bytes require a new verified build before registration.

The step uses `vars.VITE_CONTROL_PLANE_URL` and `vars.CLOUD_RUNTIME_OIDC_AUDIENCE`
(default `zeros-control-plane-alpha`), matching Alpha runtime publication.
`vars.CLOUD_WORKSPACE_STORAGE_MIB` overrides the workflow fallback of 70,225 MiB
(Alpha's qualified Boat `default` disk). This value MUST equal the Alpha control
plane's `CLOUD_WORKSPACE_STORAGE_MIB`; Boat rejects workspace creates with a
different capacity. The script requires this environment variable explicitly
and has no storage default. It refuses a source commit different from
`GITHUB_SHA`, unconfirmed cleanup, malformed contract bytes or a digest mismatch.
Exact re-registration succeeds; conflicting identity fails.
Requests and response sizes are bounded, redirects are rejected, and only a
closed diagnostic reaches the registration step's output. No OIDC/shared
publication credential is stored in the receipt.
