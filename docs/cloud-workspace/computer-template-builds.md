# Cloud Computer template builds

Status: C3 worker and helpers, **pending integration** with B4, B5b, B7 and B10.
The control-plane entrypoint does not start this worker yet. Its database tests
use the real C1 service with injected builder, runtime and GitHub doubles.
This document describes the internal Alpha path; the legacy image worker is
unchanged. No live qualification is claimed by these tests.

## Worker and durable authority

`apps/control-plane/src/cloud-workspaces/computer-template-worker.ts` consumes
the contracts §20 builder API through `computer-template-boat.ts`. It never
implements Boat allocation or SSH. C1's `claimNextBuild(fence, builder)` takes
the existing global and organization locks, selects and stores the base/runtime
pin, and records allocation intent before returning. The accepted repository
manifest is added independently after clones finish. The public C1 request and
response shapes stay unchanged except for the closed `tcb_modified` error.

`CLOUD_COMPUTER_MAX_CONCURRENT_BUILDS` defaults to 2 and accepts 1–32. Pass the
same config value to C1 and the worker. Running builds and terminal builders
without positive stop/delete or journal-confirmed non-allocation evidence count against the global cap. An
organization with unresolved compute cannot claim another build. Verified
archival releases compute capacity while physical deletion can retry.

The pipeline is base create → build-purpose runtime install → protected-file
baseline → shallow repository clones → root recipe → integrity and runtime
self-test → sanitation → verified archive → C1 completion CAS. The baseline
digest and final manifest digest are stored outside the VM. The source ref is
`boat-template:<sandboxId>`; there is no named snapshot or verifier VM.
Per the ACD-11/D8 capture decision, the final evidence is the sanitation manifest
plus the stopped/ARCHIVED sandbox confirmed by B7's provider GET. There is no
separate snapshot operation.

Running builds have a 30-minute deadline; time in the queue does not count.
Installer, repository and integrity calls also have bounded transport timeouts.
Recipes have the accepted 1–900 second limit. Creation uses a finite 1800-second
TTL and a stable `computer-build:<buildId>` operation key. B7 must enforce its
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
previous, referenced generations, newest ten) belongs to the separate retention
worker, not this build worker.

## Base-owned helpers

Both Python helpers belong to the approved base, not the replaceable runtime:

- `runtime-base-v4/computer-build.py`: clone, recipe, integrity and sanitation.
- `runtime-base-v4/computer-git-askpass.py`: fixed credential socket client.

B4 must install them root:root, mode 0555 under `/opt/zeros-bootstrap`, and put
their hashes/modes in the canonical `compatibility.json.protectedFiles` list
before registering the base. The verifier rejects a base missing either helper.
The base compatibility digest is checked against the registry pin before
importing `bootstrap.py`; the bootstrap verifies the installed manifest/tree
and receipt. A manifest rewritten by a recipe does not become its own authority.
This is the D3 trusted-root-administrator boundary: it catches accidental and
obvious changes and is not an adversarial-root sandbox.

`COMPUTER_TEMPLATE_FIXED_COMMANDS` supplies B7's four literal allowlist entries:

| Command                | Input schema                           | Successful result schema         |
| ---------------------- | -------------------------------------- | -------------------------------- |
| `computer:clone-repos` | `zeros.computer-repositories-input/v1` | `zeros.computer-repositories/v1` |
| `computer:run-install` | `zeros.computer-install-input/v1`      | `zeros.computer-install/v1`      |
| `computer:verify-tcb`  | `zeros.computer-tcb-input/v1`          | `zeros.computer-tcb/v1`          |
| `computer:sanitize`    | `zeros.computer-sanitation-input/v1`   | `zeros.computer-sanitation/v1`   |

These commands execute isolated Python as root with a fixed subcommand. JSON
arrives only on pinned SSH stdin (maximum 256 KiB). The runtime installer instead
receives contracts §5 base64url-encoded JSON, with `purpose: "build"`, the exact
descriptor and a presigned GET URL expiring in 900 seconds. Its input is limited
to 64 KiB. Every helper ends with a closed `zeros.diagnostic/v1` line. B7 must
return the bounded stdout **and** parsed last diagnostic. The pending B7
integration must reduce each escaped log batch plus diagnostic to its real
64 KiB output limit, accept computer-command stdin and parse the four command
diagnostics. The current injected adapter does not establish that transport
compatibility. Raw errors, stdin and URLs are never infrastructure logs.

Cloning mints exactly one immutable repository ID with `contents:read` using
the existing GitHub broker. The worker rechecks the organization's active
installation connection after minting and revokes every minted token in a
`finally` block. A mint/revoke failure fails the build. Tokens reach the clone
helper only on SSH stdin, then Git through a private root-owned Unix socket and
fixed askpass. They never enter a Git URL, argv, environment variable or file.
Each clone fetches depth one at the selected ref, records its exact SHA, removes
credential helpers and hooks, and ends at
`/srv/zeros/files/repos/<owner>/<name>`, owned by UID/GID 10001. The repo root and
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
UID/GID-10001 checkout roots before projecting the files tree. The engine sees
the same `/srv/zeros/repos/<owner>/<name>` paths used by recipes, preserving
absolute dependency paths. It does not expose `/srv/zeros/files/repos`.
Files and managed Git remain rooted at the primary `/srv/zeros/workspace` for
Alpha. Secondary-repository recovery remains outside the Alpha checkpoint.

Stdout and stderr are redacted separately before spooling and again before CP
persistence. Literal prefixes are withheld across chunk boundaries; token/URL
patterns see bounded complete lines. Lines/chunks are limited to 8192 UTF-8
bytes, helper responses to eight chunks, and each retained build log to 1 MiB.
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

Sanitation verifies integrity and repository SHAs again, normalizes Git config
and repo ownership, stops the idle host and removes private homes, setup and
admission state, logs/journals, settings, sessions and machine-specific state.
It preserves B4's home/state directory ownership and modes, runtime receipts,
installed software and selected repo trees. Epoch contents and session payloads
are explicit generated-metadata exclusions; their parents and facade pointers
remain protected. Provider-managed OS SSH identity stays under Boat's lifecycle,
matching B4. No publication renames a pre-existing directory (contracts §22).

For contracts §23, B10 binds `/srv/zeros/{files,state,home}` from
`/home/user/.zeros-persist/*` on every boot/restore. C3 continues to address the
logical paths and never deletes or empties `/home/user/.zeros-persist`; it
cleans its explicit private targets through those binds and retains repository
data. B10 also owns the workspace-time `/srv/zeros/repos` bind outside a build
and regeneration of the empty machine-id after restore. C3 keeps emptying
machine-id during sanitation and does not change base boot files.

## Pending integration checklist

1. B4: add both helpers to the base payload, installer loop and protected-file
   inventory; rebuild/register/qualify the base through the existing operator
   flow. The C3 change does not edit the in-flight B4 packaging files.
2. B7: replace the structural types in `computer-template-boat.ts` with imports
   from `cloud-builder-vm.ts`; spread `COMPUTER_TEMPLATE_FIXED_COMMANDS` into the
   same closed allowlist; accept their stdin in `runFixed` and parse their
   diagnostics in `cloud-builder-commands.ts`. Inject the same account-scoped
   `BuilderVmOperationStore` used by the VM adapter (`find` and
   `closeUnallocatedCreate`); use B7's account/wallet checks, pinned-SSH stdin
   and key-revocation path. Bound actual JSON-escaped batches plus diagnostics
   to 64 KiB and add an adapter/helper transport test. Do not add shell
   interpolation. When #290 lands, renumber C3's unmerged migration to 0127.
3. B5b: adapt `selectCloudRuntime(tx, qualificationMode)` to
   `{ baseImageId: selected.pin.baseImageId,
baseCompatibilityId: selected.pin.baseCompatibilityId,
descriptor: selected.descriptor, objectKey: selected.objectKey }`.
   It selects the newest approved base and qualified Alpha channel head under
   the claim transaction. For `validate(tx, runtime)`, call
   `loadPinnedCloudRuntime(tx, { runtimeId, manifestSha256, baseImageId,
baseCompatibilityId, profile: "zeros-cloud-worker-v4", engineProtocolVersion },
qualificationMode)` and return whether the pinned tuple remains eligible.
   Never select a new head at completion. Pass the shared artifact store's
   `presignGet`; do not implement another signer.
4. Entrypoint: give C1 `sanitizeLog: sanitizeComputerTemplateLog`, then construct
   the worker with the real GitHub broker and the adapters above. Start/stop it
   only in the existing Alpha/background-worker role, passing account scope,
   wallet and the configured build cap. Until this connection is made, v2
   requests queue without running; do not enable the new path for users.
5. Rerun DB-backed worker/C1 tests, B4's real bootstrap tests, B7's allowlist/SSH
   tests and the live runbook below before claiming the integrated path works.
6. B10: qualify the §23 persistent binds, the workspace-time `/srv/zeros/repos`
   bind and empty-machine-id regeneration through an actual template restore.

The C6 deletion/retention track must also coordinate final organization erasure
with provider cleanup before this worker is enabled on a shared database. C1's
`deletion-lifecycle.ts` final-erasure loop currently removes v2 template/build
records; C3's allocation journal must survive until VM deletion is confirmed.
That lifecycle integration is outside this worker/helper change.

## Alpha live runbook (not run for this PR)

The executable runbook is
`scripts/cloud-workspace-validation/computer-template-live-check.mts`. Its adapter
factory is deliberately pending B4/B5b/B7, just like the entrypoint. Do not run
it with test doubles or before all six integration steps above are complete.

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
   Return the real B7 builder, GitHub broker and shared artifact store, and B5b's
   selector over the seeded local registry. Set `deps.namePrefix` to the supplied
   bounded prefix (it contains a short run ID; the full run ID stays in the
   report). Include the B7 operation-store adapter in `deps.operations`. The
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
