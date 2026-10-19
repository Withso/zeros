# Cloud Computer template builds

Status: C3 uses the real B7 builder/journal and B5b runtime selection. The Alpha
control-plane entrypoint starts template builds when Boat and runtime artifacts
are configured. Tests cover factory startup and shutdown, C1 and the
B7 database journal, the actual adapter/helper transport, and fake provider and
GitHub boundaries.
This is the supported Alpha build path for active organization owners/admins;
engineering staff membership and the desktop internal flag are not required.
The legacy custom-Computer image producer/service is removed. Historical cancellation and
receipt-verified deletion run in the cleanup-only retirement worker, independent
of setup-worker startup; enrollment can proceed while cleanup is pending.
Historical tables, identities and referenced snapshots remain. No live
qualification is claimed by these tests.


The engine, agents, tools, terminals/SSH/LSP and capture use the [normal VM execution model](security.md#agent-execution-model):
one non-root `zeros-engine` user (10003), the real checkout and normal VM egress, without an agent sandbox.
The approved base's setup recipes and account inventory remain immutable. The root broker adopts
legacy mutable checkout/HOME ownership from 10001/10002 to 10003 only after positive old-engine drain.
Agents can read engine data on their VM: one trust domain per workspace. Conversation directories
separate state, not agents from each other.

Completed builds also require a ready [durable named snapshot](computer-named-snapshots.md)
with an exact saved-tree proof. New workspace allocations use the saved name;
legacy accepted generation pins keep their original fork path.

## Build qualification evidence (dormant)

`cloud_computer_build_qualifications` records one immutable, bounded
`zeros.computer-build-qualification/v1` document per exact organization,
configuration and build. It binds the original builder operation/helper fence,
runtime manifest/archive/installer receipt, registered base and compatibility
bytes, protected and boot-integrity digests, running-kernel fingerprint, policy,
and complete role/retirement results. Canonical UTF-8 JSON and its SHA-256 are
stored together. This record is behavioral evidence, not a credential.

The system-only writer requires a current, uncancelled integrity-stage build
and its exact live builder. An identical acknowledged result may be reread
after a fenced handoff; different bytes cannot replace it. The build deadline
is checked with the current database clock after INSERT and lock waits.
Evidence alone is ineligible. Selection also requires successful build
completion, matching sanitation, a ready named snapshot and its immutable
saved-tree proof, and current runtime/base approval. It holds those rows through
the caller's admission transaction. No provider I/O belongs under those locks.

The organization flag `build_qualification` defaults off and reads off when its
feed is unavailable. Supported readers accept optional private installer
`buildQualification` metadata: `{mode:"full"}` or a closed `{mode:"build", ...}`
selection containing the evidence ID, digest, document and exact snapshot.
The existing encoded 64-KiB installer limit still applies. Producers must not
emit it before both the exact base and runtime support version 1. A legitimately
absent record or unsupported cohort can preselect full qualification; malformed,
revoked or incomplete selected evidence cannot downgrade. A new runtime needs
its own qualification. A pinned attempt retains its original mode when the
rollout flag changes.

Only one-way revocation is mutable. Tenant contexts cannot read or write these
rows. Normal deletion is refused; the existing organization eraser cascades
through the template only under its exact live purge lease. Historical
identities remain available for cleanup until that erasure.

The template worker can produce this evidence only with the organization flag
enabled and a registered base advertising `buildQualificationVersion:1`. The
base producer requires the manifest-bound runtime offer
`lib/zeros/build-qualification-support.json` at version 1. It runs the complete
build self-test, hashes the fixed protected system/Python dependency closure,
and measures the running kernel. Every dependency command and acceptance shares
the original wall and monotonic build deadline. It retains full runtime hashing.
Absent support selects the ordinary full self-test; malformed present support
refuses. The worker reads an already acknowledged checkpoint before checking
flags, so a handoff or rollout change cannot replace recorded evidence with an
absence or repeat the producer.

Sanitation retains the original three root-owned qualification files through
private cleanup and sync. The saved-tree proof requires exactly those bounded
records for the acknowledged build and rejects extra, missing or aliased
records. `integrity.json` is private and bounded at 8 MiB; evidence and report
remain bounded at 64 KiB each. The stable inventory has at most 16,384 entries
and consumes at most 1 GiB of file reads per capture, without truncation. Only
the exact `/usr/local` and `/usr/local/lib` directory ancestors may use the
provider pair from the base's sealed stock policy; deeper selected files and
directories remain root-owned. Fresh ACL, identity and byte checks still apply.

Creates and wakes still run full qualification. The fixed base verifier
transport is installed for a later reader, but this slice emits no boot-reader
offer, selects no build mode for workspace setup, and changes no runtime launch
code. Activation requires fresh per-boot integrity/identity/custody and
single-use proof checks, final admission/revocation wiring, and exact
runtime/base qualification. Local and organization-local workspaces, owner
switching, agent runners and detached turns are unchanged.

## Worker and durable authority

`apps/control-plane/src/cloud-workspaces/computer-template-worker.ts` consumes
the contracts §20 builder API through `computer-template-boat.ts`. It never
implements Boat allocation or SSH. C1's `claimNextBuild(fence, builder)` takes
the existing global and organization locks, selects and stores the base/runtime
pin, and calls `prepareBuilderVmOperation(..., tx)` before inserting the capacity
record. Both journals commit atomically, without provider I/O. Cancellation or
expiry before the first create closes the prepared intent, rejects a late
creator, and frees capacity; a failed preparation rolls back the claim. The accepted repository
manifest is added independently after clones finish. The public C1 request and
response shapes stay unchanged except for the closed `tcb_modified` error.

With `CLOUD_RUNTIME_IMAGES_ENABLED=true`, the claim also selects a ready
[runtime image](runtime-images.md) for that exact runtime/base, channel and
provider scope. Its share lock lasts through recording the immutable
`builder_source_image_id` and builder intent. Missing or disabled images use the
base path. A null source-image pin preserves the original intent digest; a saved
image pin remains authoritative on replay and cleanup even after withdrawal or
flag disablement.

The consumer withdraws an image only after an initial runtime/base identity
mismatch. A TCB failure still fails the build, but the frozen helper also emits
`tcb_modified` for internal timeouts and generic OS errors, so it leaves the
shared image ready. Set `CLOUD_RUNTIME_IMAGES_ENABLED=false` to use the base for
new claims while investigating repeated failures. Automatic TCB withdrawal
requires a future qualified base that distinguishes corruption from transient
errors. See the runtime-image [rollout and rollback guidance](runtime-images.md#rollout-and-rollback)
before enabling images or reverting the control plane.

`CLOUD_COMPUTER_MAX_CONCURRENT_BUILDS` defaults to 2 and accepts 1–32. Pass the
same config value to C1 and the worker. Running builds and terminal builders
without positive stop/delete or journal-confirmed non-allocation evidence count against the global cap. An
organization with unresolved compute cannot claim another build. Verified
archival releases compute capacity while physical deletion can retry.

The pipeline starts with base create and build-purpose runtime install, or a
create from a ready runtime image with the pinned runtime already current and
idle. The image path skips artifact presigning and installation. Both continue
with protected-file baseline → shallow repository clones → root recipe → integrity and runtime
self-test → sanitation → verified archive → named save and saved-tree proof →
C1 completion CAS. The baseline digest and final manifest digest are stored
outside the VM. New source refs are `boat-computer:<name>@sha256:<manifest>`;
legacy accepted `boat-template:<sandboxId>` pins keep their fork path. The final
Computer uses a named saved-tree proof, without an additional verifier VM.
The separate runtime-image producer still owns its shared name and cold probe.
The final evidence includes the sanitation manifest, B7's confirmed stopped
sandbox, and the complete tree of the exact named snapshot. Boat's stop saves
the disk first and reports itself
as an operation: B7 pins the stop it issued or joined (`GET
/sandboxes/{id}/stops/{stopId}`), rechecks it after every poll, and captures
only when that exact stop is `completed` and the sandbox is archived. While the
stop is `pending` or `failing` (Boat retries a refused save itself) it waits
until six minutes before the build's 30-minute deadline, reserving five minutes
for the named save/proof and one minute for completion. Capture then requires the
archived sandbox's `snapshotAvailable` with a `completed` `lastSnapshotStatus`,
the same evidence a template fork checks on its source. A builder that is
already archived, or a stop without an identity, is refused: an archive this
build did not issue proves nothing about its sanitized disk. Every read is
bounded by the remaining deadline, and a success observed after it is a timeout.
A save that is still refused at the bound, or a missing/failed snapshot, is
`template_capture_failed`; any other stop failure, including a resume that
supersedes the stop, is `template_stop_failed`. B7 never sends `force`, which
would keep an older snapshot and discard the sanitized disk.

Running builds have a 30-minute deadline; time in the queue does not count.
Installer, repository and integrity calls also have bounded transport timeouts.
Recipes have the accepted 1–900 second limit. Creation uses a finite 1800-second
TTL and a stable `computer-build:<buildId>` operation key. B7 enforces its
phase deadlines and TTL policy. Provider names use the shared bounded
`computerTemplateBuilderName`: `zeros-v2-cc-<short-build-id>` by default, at most
62 lowercase ASCII characters. Full build IDs remain in the operation key.
A lost allocation reply is reconciled with the original body/key, never a new
allocation key. Cleanup reads B7's operation journal even when `create` rejects
readiness or wallet checks after recording a resource. It binds that resource to
the C3 journal and deletes it without requiring command readiness. An uncertain
dispatched create can be replayed; the journal is then read again even if the
replay rejects an already archived VM. Only B7's atomic `closeUnallocatedCreate`
can prove non-allocation and close future dispatch. A missing journal row or an
unresolved attempt keeps the capacity hold. After 23 hours, unknown allocation
remains a capacity hold requiring B7/operator reconciliation rather than risking
provider idempotency expiry.

Cancellation/deadline reconciliation increments the worker fence and fails
closed. Failed, cancelled and superseded builds delete their VM; if deletion
fails, they attempt verified stop, then retain a cleanup lease/retry record.
Completion checks the deadline independently of the sweep. A lost completion
reply cannot delete an already active template. Ready-template retention (active,
previous, and sources of workspaces whose workspace/data deletion is unfinished)
belongs to the separate retention worker, not this build worker. There is no
additional ready-history hold; retired versions require Rebuild before Activate.

## Graceful build handoff

On SIGTERM the worker stops taking new builds and hands each active build over
at its next acknowledged checkpoint. Migration 0163 adds a handoff marker while
keeping the build `running`, its capacity hold, stage, start time, original
30-minute deadline, configuration, runtime/base pin and builder operation.
This also keeps older workers from claiming it as a fresh queued build, including
after its builder has stopped. A successor consumes the marker under the normal
global and organization locks, advances the control-plane worker fence and
reloads the exact saved runtime through qualification and revocation checks.
It never follows a new release or changes the builder's source, wallet or TTL.

The immutable helper fence stays separate from the advancing control-plane
fence. A running recipe is polled using the same durable helper job; completed
clones, runtime installation and integrity baselines are not repeated. Clone
credentials are revoked before handoff, and a clone in flight must finish and
record its manifest before the worker can yield. Sanitation similarly must
record its digest before handing over to stopping/capture. Final integrity,
runtime self-test, sanitation and exact saved-tree proof remain required.
Cancellation, expiry and actual helper failures still fail closed.

Handoff records contain only bounded install progress: whether start was
acknowledged, the consumed log cursor and stream names with a partial line.
They never contain credentials, redaction literals or unfiltered log prefixes.
The VM keeps its original log filter; a successor discards interrupted line
tails before applying the control-plane filter to new output. Completed log
chunks are not replayed. A lost handoff commit reply cannot fail or delete a
build that the database handed to a successor.

This is cooperative shutdown, not crash recovery. Configure both
`CONTROL_PLANE_DRAIN_SECONDS` (C0: 0–120, default **0**) and Railway's draining
seconds to leave time for the next checkpoint. The process hard exit is
15 seconds plus the configured C0 window; Railway can terminate it sooner.
With the default C0 value, the worker has at most 15 seconds. Runtime install,
clone, sanitation, provider archive or capture may outlast even a configured
window. If SIGKILL or the hard exit precedes the durable checkpoint, the next
worker does **not** adopt or replay the uncertain step. The original running
claim expires at its existing deadline and normal fenced cleanup retires the
same builder; its finite provider TTL is unchanged. A database outage before
the checkpoint has the same bounded outcome. Rolling back to older code leaves
handed-off builds to that deadline/cleanup path. This change requires no new
base contract and does not affect Local or organization-local workspaces.

## Base-owned helpers

The fixed Python helpers belong to the approved base:

- `runtime-base-v4/computer-build.py`: clone, recipe, integrity and sanitation.
- `runtime-base-v4/computer-git-askpass.py`: fixed credential socket client.
- `runtime-base-v4/computer-boot-integrity.py`: bounded protected bytes and
  running-kernel measurement.
- `runtime-base-v4/computer-build-qualification.py`: immutable evidence producer,
  preservation and selected-evidence verification.

B4 must install them root:root, mode 0555 under `/opt/zeros-bootstrap`, and put
their hashes/modes in the canonical `compatibility.json.protectedFiles` list
before registering the base. The verifier requires both original helpers and,
when version 1 is advertised, both qualification helpers.
The base compatibility digest is checked against the registry pin before
importing `bootstrap.py`; the bootstrap verifies the installed manifest/tree
and receipt. A manifest rewritten by a recipe does not become its own authority.
This is the D3 trusted-root-administrator boundary: it catches accidental and
obvious changes and is not an adversarial-root sandbox.

`COMPUTER_TEMPLATE_FIXED_COMMANDS` supplies these literal allowlist entries:

| Command                | Input schema                           | Successful result schema         |
| ---------------------- | -------------------------------------- | -------------------------------- |
| `computer:clone-repos` | `zeros.computer-repositories-input/v1` | `zeros.computer-repositories/v1` |
| `computer:run-install` | `zeros.computer-install-input/v1`      | `zeros.computer-install/v1`      |
| `computer:verify-tcb`  | `zeros.computer-tcb-input/v1`          | `zeros.computer-tcb/v1`          |
| `computer:qualify-build` | `zeros.computer-build-qualification-input/v1` | `zeros.computer-build-producer/v1` |
| `computer:sanitize`    | `zeros.computer-sanitation-input/v1`   | `zeros.computer-sanitation/v1`   |

These commands execute isolated Python as root with a fixed subcommand. JSON
arrives only on pinned SSH stdin (maximum 256 KiB). The runtime installer instead
receives contracts §5 base64url-encoded JSON, with `purpose: "build"`, the exact
descriptor and a presigned GET URL expiring in 900 seconds. Its input is limited
to 64 KiB. Every helper ends with a closed `zeros.diagnostic/v1` line. B7
returns the bounded stdout **and** parsed last diagnostic, with the command
stage and closed failure checks validated. Computer-command stdin is accepted
for a computer-build VM; a runtime-image VM may invoke only the TCB helper for
its cold probe. Poll batches are measured after JSON escaping,
reserving 4096 bytes for the diagnostic and both newlines within the real
64 KiB transport limit. The adapter/helper test executes the actual Python
entrypoint through B7's pinned-SSH channel fixture and drains escaped/multibyte
logs over multiple polls. Raw errors, stdin and URLs are never infrastructure logs.

Cloning mints exactly one immutable repository ID with `contents:read` using
the existing GitHub broker. The worker rechecks the organization's active
installation connection after minting and revokes every minted token in a
`finally` block. A mint/revoke failure fails the build. Tokens reach the clone
helper only on SSH stdin, then Git through a private root-owned Unix socket and
fixed askpass. They never enter a Git URL, argv, environment variable or file.
Each clone fetches depth one at the selected ref, records its exact SHA, removes
credential helpers, disables template hooks, and ends at
`/srv/zeros/files/repos/<owner>/<name>`, owned by UID/GID 10001 under the frozen
base's legacy setup contract. The root broker adopts mutable checkout ownership
to 10003 after positive old-engine drain, before new runtime attestation. The repo root and
owner directories are explicitly set and checked as root:root 0755, including
during sanitation; the helper's umask 077 cannot make them inaccessible.
Private job and credential directories stay 0700. An empty selection does not
create `/srv/zeros/files/repos`. There is no repo cache. Submodules and LFS
placeholders are rejected for Alpha. Escaping or
absolute links, special files, hardlinks and Git alternates are rejected before
ownership traversal.

The recipe runs `bash -euo pipefail` as root in `/srv/zeros/repos`, under a named
systemd unit with a bounded cgroup (512 tasks, 4 GiB, 200% CPU), strict deadline
and process-group drain. Its fixed internal `install-shell` entry runs under
`unshare --mount --propagation private` and binds the clone tree read-write at
`/srv/zeros/repos`. An empty selection gets a bounded transient tmpfs there.
The bind never propagates back to the host. The recipe's mount namespace makes the
base-owned verifier/bootstrap directory and cgroup filesystem read-only. Use `/usr/local/bin` for shared commands;
root's dotfiles are not agent configuration. Builds receive **no organization
environment or secret values**. A durable start marker binds build, fence and
script digest; repeating start after an SSH failure inspects the same execution.
Polls retry up to three consecutive transport failures without rerunning it.

The v4 launcher checks the repository parent/owner directories, names and
checkout roots adopted to 10003 after positive old-engine drain before projecting the files tree. The engine sees
the same `/srv/zeros/repos/<owner>/<name>` paths used by recipes, preserving
absolute dependency paths. It does not expose `/srv/zeros/files/repos`.
Files and managed Git remain rooted at the primary `/srv/zeros/workspace` for
Alpha. Secondary-repository recovery remains outside the Alpha checkpoint.

Stdout and stderr are redacted separately before spooling and again before CP
persistence. Literal prefixes are withheld across chunk boundaries; token/URL
patterns see bounded complete lines. Lines/chunks are limited to 8192 UTF-8
bytes, helper responses to at most eight chunks within the encoded response
budget, and each retained build log to 1 MiB.
C1 supplies monotonic cursor reads and explicit truncation. No raw script output
enters the provider diagnostics. Deliberate encoding by a root administrator
remains outside the known-value redaction guarantee.

Integrity covers protected hashes/modes, ownership/ancestry, runtime inventory,
capabilities, facade links, unit/drop-in search paths, sudoers, AppArmor, UID/GID
and subordinate-ID policy, plus interpreter/launcher dependencies. The approved
v4 AppArmor profile uses `unconfined` to allow nested user namespaces; its loaded
mode must remain unchanged. Namespace/seccomp/cgroup isolation belongs to the
verified launcher. Adding unrelated packages is allowed; replacing a protected
dependency requires a new approved base/runtime.

Before repositories or recipes run, a deterministic base/runtime mismatch or a
confirmed non-timeout `tcb_modified` baseline withdraws an image from selection.
Transport failures, malformed results and later recipe/integrity failures do not
quarantine the shared image. Both source paths still require the complete
baseline and post-install checks.

Sanitation verifies integrity and repository SHAs again, normalizes Git config
and repo ownership, stops the idle host and empties private homes, setup and
admission state, logs/journals, settings, sessions and machine-specific state.
Ordinary private files are truncated in place after descriptor and pathname
validation; directory identities, ownership and modes survive. No cleanup of
these paths depends on unlinking an entry: an incremental saved disk can retain
the ancestor's bytes after a live deletion. Symlinks, hard links and special
files fail sanitation without following or truncating their targets.
It preserves runtime receipts, installed software and selected repo trees.
Epoch contents and session payloads
are explicit generated-metadata exclusions; their parents and facade pointers
remain protected. Provider-managed OS SSH identity stays under Boat's lifecycle,
matching B4. No publication renames a pre-existing directory (contracts §22).

The sanitizer materializes empty `disk-epoch`, `sessions/boot.json`,
`sessions/reconciliation.json`, `active-runtime.json`, `random-seed` and
`timesync/clock` files even if a known name is absent from the live tree.
`computer-build` and the private home trees retain empty directories and files.
Bootstrap recognizes only metadata-validated zero bytes as an absent epoch or
boot intent; malformed nonempty content, including JSON `null`, remains invalid.
Projection directories may retain only ordinary empty descendants. Links,
special files, nested mounts and nonempty descendants still prevent boot.
Empty cached files do not grant runtime, workspace or account admission.

A live walk cannot discover arbitrary filenames deleted before sanitation.
The exact saved-tree proof is therefore still required, independently of the
helper's clean receipt; any inherited private bytes keep the Computer unready.
The fixed runtime qualifier retains its ordinary session bookkeeping for that
walk after proving native retirement. Native launch/recovery records still use
their normal cleanup, and ordinary Local and cloud sessions still remove their
directories. Sanitized zero-byte session stubs remain inert; generic session GC
does not treat malformed or empty metadata as authority to delete a directory.
Repository normalization remains separate from private-state sanitation.
Visible ordinary `.git/hooks` files are emptied in place; aliases and special
files fail sanitation. The normalized local Git config persists
`core.hooksPath=/dev/null`, so ordinary Git in a restored clone cannot execute
an inherited hook that was already absent from the live sanitation tree.
The saved-tree private-state proof deliberately excludes repository content;
this setting prevents hook execution, not recovery or erasure of unknown
inherited repository bytes. An intentional workspace hook installation must
explicitly replace this local setting. Local checkouts outside Computer builds
are unaffected.

When a fixed build command fails, its validated closed diagnostic is appended
to the fenced build log before cleanup. Raw helper output and exceptions are
excluded, and a reporting failure cannot replace the build error or stop cleanup.

For contracts §23, B10 binds `/srv/zeros/{files,state,home}` from
`/home/user/.zeros-persist/*` on every boot/restore. C3 continues to address the
logical paths and never deletes or empties `/home/user/.zeros-persist`; it
cleans its explicit private targets through those binds and retains repository
data. B10 also owns the workspace-time `/srv/zeros/repos` bind outside a build
and regeneration of the empty machine-id after restore. C3 keeps emptying
machine-id during sanitation. `/etc/machine-id` and a regular
`/var/lib/dbus/machine-id` retain their existing atomic empty-file replacement;
the latter's provider-owned symlink is deliberately left intact. These are not
claims that every OS identity or arbitrary private path is scrubbed.

## Qualifying a base with empty-state sanitation

Changing the protected bootstrap or Computer helper changes the generated
`bc1-` compatibility ID. Deploying the control plane cannot update a helper
already pinned in a base, runtime image or Computer. Qualify a newly built base
and its runtime pairing before selecting it for new builds. Existing workspace
pins, Local Personal and organization-local runtimes are unaffected.

The operator qualification requires an approved Alpha budget and disposable
resource names. Local tests do not qualify the provider's incremental capture,
Ubuntu services or real mount lifecycle. Keep the old qualified pins available
through the following gates:

1. Run the retained Python security/recovery suite and the adjacent base,
   Computer-helper, projection and fresh-base tests. Preserve the incremental
   union, pre-truncation race, empty-marker crash-point, malformed-state and
   projection rejection tests. Never loosen the saved-tree proof to pass.
2. Use the base kit's existing `runtime-base-v4 live-check` flow with a fresh
   state directory and unused name. Record source commit, protected-file hashes,
   compatibility ID, builder/cold-clone evidence and snapshot size. Verify that
   both `bootstrap.py` and `computer-build.py` are the newly qualified bytes.
   Re-run the base's sanitize/verify sequence to check idempotence.
3. Qualify a runtime against that exact new base, then produce a new runtime
   image for the same pair. Build one Computer directly from the base and one
   from that runtime image, using an approved synthetic repository and recipe.
   Both paths must reach the same helper and compatibility ID; an old image is
   not evidence for the new base.
4. For each path, record a pre-sanitation saved generation containing synthetic
   marker/private state, then the build's exact completed stop and named saved
   tree. Every visible sanitized file must remain ordinary and zero bytes;
   protected executables, repository content and directory modes must match.
   Exercise nested private home files, projection leftovers, job records and
   the six known markers above. Retained unknown private entries, aliases or
   invalid metadata fail qualification. Inspect the synthetic repositories'
   saved `.git/config` and hook inventory separately: normal origin, disabled
   hooks, no credential helpers, and explicit empty replacements for visible
   pre-sanitation hooks. The private-state proof does not certify these paths.
   Do not read real credential contents.
5. Cold-clone each qualified Computer through workspace creation. Check a fresh
   boot ID, one epoch publication per boot, a freshly published active descriptor
   and valid persistence bindings. Repeat boot and stop/resume; no parser may
   admit an empty file as a credential or descriptor. Run create/send/stop/resume
   with each supported agent and confirm that retained empty HOME/config files
   do not block initial setup. Verify random-seed regeneration and timesync
   service health on the Ubuntu clone. Synthetic tests separately cover death
   after boot intent, epoch and boot-ID publication without double increments.
   Exercise ordinary Git checkout and commit without the helper's `-c` flags,
   with an approved synthetic inherited-hook sentinel: no hook may execute,
   and repository contents/SHA, ownership and normal Git operations must work.
   Explicitly installing a workspace hook must remain possible after replacing
   the template's local `core.hooksPath` setting.
6. Admit new allocations only after both source paths, exact saved proofs and
   cold clones pass. A failed proof retains the save intent and artifact for
   investigation. If rollout fails, stop selecting the new base/runtime images
   for new claims and use previously qualified pins; never relabel a new
   sanitized artifact with an older helper or rewrite an existing workspace pin.

Record only closed results, counts, hashes and approved resource receipts in
private qualification evidence. Disposable resource cleanup is an explicit
operator step after the evidence is retained.

## Integration and remaining enablement

`createComputerTemplateBoatAdapters` constructs the account-scoped
`DatabaseBuilderVmOperationStore`, real `BoatCloudBuilderVms`, and B5b selector.
Pass its `operations`, `vms` and `runtime` together to the worker. Runtime
selection happens inside the claim transaction; completion calls
`loadPinnedCloudRuntime` on the original tuple without selecting a new head.
Construction does not allocate or start a worker. C3's additive migration is
0128; B7 owns 0126 and D2 reserves 0127.

`createComputerTemplateWorker` supplies those adapters, the production GitHub
broker and runtime artifact store, the configured build cap, and a shared C1
service with `sanitizeComputerTemplateLog`. It returns null outside Alpha or
without Boat settings or runtime artifacts. The runtime qualification worker's
enablement flag does not gate template builds; its configured qualification
mode still governs runtime selection and validation.

`index.ts` constructs the worker outside database maintenance and pending
controlled migrations, starts it with the other cloud background workers, and
awaits its stop callback before closing the database pool on shutdown. The
existing background-worker pause switch also pauses template builds. No new
setup-worker flag is required. `CLOUD_RUNTIME_IMAGES_ENABLED` independently
enables the optional image source and defaults to false.

Live qualification remains an operator task:

1. Base payload: install both helpers and add them to the protected-file
   inventory; rebuild/register/qualify the base through the existing operator
   flow. Coordinate that base change with B10; C3 does not edit base boot files.
2. Run the Alpha runbook below against the registered base. No live qualification
   is claimed by the local adapter, bootstrap or database tests.
3. B10: qualify the §23 persistent binds, the workspace-time `/srv/zeros/repos`
   bind and empty-machine-id regeneration through an actual template restore.

The projection suite uses the actual Linux launcher and native namespaces. CI
runs it through `scripts/ci/with-userns.sh`; missing sudo/bubblewrap support is a
failure on Linux CI, not a silent loss of security coverage. The root-owned
fixture remains private; only the elevated helper changes into it.

The [template retention worker](computer-template-retention.md) owns ready-template
retirement and organization erasure checks. Final erasure requires provider
cleanup evidence before removing template/build journals; failed-build cleanup
remains owned by the template build worker.

## Alpha live runbook (not run for this PR)

The executable runbook is
`scripts/cloud-workspace-validation/computer-template-live-check.mts`. Its adapter
factory supplies the Alpha credentials and disposable local fixtures. Use
`createComputerTemplateBoatAdapters` for B7/B5b, never test doubles. Do not run
it before base payload registration and the enablement prerequisites above.

Prepare in the orchestrator's credential-bearing workspace:

1. Run `pnpm agent:check`. Only `.env.agent` supplies provider credentials. Confirm
   its Alpha bucket/database selectors match the repository template. No tokens,
   URLs, private keys or database passwords belong in command arguments.
2. Implement `.context/c3-alpha-adapter.ts`, exporting
   `openComputerTemplateAlphaFixture: ComputerTemplateAlphaFactory` from the
   runbook. It must create/reopen a dedicated **local** PostgreSQL 18 database
   named `zeros_v2_test_c3_<runId_without_dashes>`, apply current migrations, and
   seed one synthetic staff/admin organization named with the supplied
   `zeros-v2-test-` prefix. Seed its registry from read-only approved Alpha
   base/runtime/qualification records; never register/revoke shared Alpha rows.
   Reuse an authorized Alpha test GitHub installation and a small private test
   repository, with that admin's local source proof and organization connection.
   Return `createComputerTemplateBoatAdapters` over the seeded local registry,
   the real GitHub broker and shared artifact store. Set `deps.namePrefix` to the supplied
   bounded prefix (it contains a short run ID; the full run ID stays in the
   report). Include the returned B7 store in `deps.operations`. The
   factory must not allocate VMs, log credentials or start background
   workers. Only this harness may enqueue work in its fresh local database.
3. Factory `close({cleanupConfirmed})` closes connections and drops the local
   database only when true. When false, retain the DB and B7 journal for recovery.
   It must never delete the shared base, bundle, R2 object, GitHub installation or
   any Alpha database fixture. All created provider VMs use the supplied prefix;
   the script itself creates no R2 objects or Alpha DB rows.
4. Execute from the repository root:

   ```sh
   pnpm exec tsx scripts/cloud-workspace-validation/computer-template-live-check.mts --adapter .context/c3-alpha-adapter.ts --report .context/zeros-v2-test-c3-report.json
   ```

   The six sequential cases check successful ready/autoactivation, script
   failure, protected-file modification, mid-install cancellation, forced local
   deadline expiry and superseded completion. Each failure must leave the prior
   active version intact. Recipe logs and helper failure text are not printed.
   Case durations and exact build/sandbox IDs are recorded in the mode-0600
   report, and the factory's local journal retains ambiguous allocation IDs.

5. Cleanup runs in `finally`. It fences local pending builds, reconciles unknown
   allocations through B7, clears **local test** head references and deletes only
   that run's recorded builders/templates with verified B7 deletion evidence.
   Require every report resource to have `deleted: true` and
   `cleanupConfirmed: true`. A closed failure is not cleanup evidence. After an
   interrupted/uncertain run, retry using the original factory and journal:

   ```sh
   pnpm exec tsx scripts/cloud-workspace-validation/computer-template-live-check.mts --adapter .context/c3-alpha-adapter.ts --report .context/zeros-v2-test-c3-report.json --cleanup
   ```

   Cleanup preserves the original check outcome; a failed/interrupted experiment
   still exits nonzero after cleanup. Report both the check result and cleanup
   confirmation to the orchestrator. Do not remove the journal on uncertainty.

The live runbook verifies one run, not a latency SLO. Ordinary forks, subsequent
restore behavior, retention and secondary-repository checkpoint coverage remain
the responsibilities of the workspace/retention tracks.
