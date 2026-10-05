# Template workspace setup reproduction

This operator-only runbook diagnoses the computer-template path of v4 workspace
setup. Run it from the credential-bearing Alpha workspace. It does not deploy,
change a Cloud Computer, redeem workspace setup material, issue a GitHub grant,
run repository hooks, or start the product engine.

The expected manifest comes from the saved generation's source/build/template
rows, using `computerWorkspaceTemplateManifest`, rather than the current active
computer or the fork's own manifest. The SQL transaction is read-only. Generation
one and a `zeros-v2-test-` base are required. The archived template is inspected
but never modified.

## Running

Use Node 22.23.1 or newer with the installed repository dependencies. Run
`pnpm agent:check` in the credential-bearing workspace first. The root
`.env.agent` must be a private regular file, with these entries:

- `ZEROS_PLANETSCALE_ALPHA_DATABASE=zeros-control-plane-alpha`
- `ZEROS_S1_ALPHA_DATABASE_URL`: a direct PlanetScale connection to Alpha with
  `sslmode=verify-full`. `sslmode=require` is rejected as `input_invalid`.
  The existing `ZEROS_C5_ALPHA_DATABASE_URL` is also accepted when S1 is absent.
- `BOAT_API_KEY`
- `BOAT_BILLING_ORG`: the same wallet recorded for the saved template.

No inherited credential or database URL is used. Do not pass credentials in
arguments. Use the affected workspace UUID and its recorded template sandbox ID:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/template-setup-repro.mjs --run --workspace WORKSPACE_UUID --template TEMPLATE_SANDBOX_ID
```

The operator's database role needs read access to the saved source tables
(the TTL `pg_read_all_data` role is sufficient). The script uses `BEGIN READ ONLY`
and transaction-local `app.system=on` for the system RLS policies. It does not
switch to `zeros_app` or require membership in that role.

The fork POST has C5's `type`, `ttlSeconds`, `noEnv: true`, and `env: {}` fields,
without a `from` field. The resource size comes from the accepted generation;
the diagnostic lease is bounded to 1800 seconds. The child is named
`zeros-v2-test-s1-<run UUID>` immediately after allocation. The script waits for
the same `bootstrap.py status` schema, base identity, and host state that the
production Boat setup runner requires.

The probe uses B4's `remote(..., pythonProbe(program, "verify"), 480)` transport:
the Boat commands API executes the bounded program under `sudo python3`. The
request carries only probe source and secret-free expected material, with no
SSH connection or separate stdin stream. Command and stdout sizes are bounded
to 64 KiB. Optional filesystem snapshots, listing tails and qualification check
details are trimmed to fit the stdout budget and marked as truncated. Directory
headers, identity checks, secure/error fields and failure metadata are retained.

The probe loads the **installed** runtime helpers and follows setup's host
profile/directory checks, supervisor prepare, `verifyCloudComputerTemplate`,
computer admission creation and re-read, credential-residue checks, and
`attestImage`. Admission uses fresh synthetic execution/engine IDs and contains
no credentials. The attestation caller receives synthetic unexpired timestamps
only for its expiry guards. It then performs the real v4 installation,
containment, resource, setup-process and image-admission checks. There is no
network repository fetch. A runtime pin mismatch is reported before proceeding;
the script does not hydrate a different runtime from storage.

Filesystem operations are observed without changing their arguments, return
values or predicates. An in-memory Node loading hook observes the installed
attester's existing diagnostic boundary, including its locked child. The same
loading hook exports setup's private preparation/publication functions only
inside this diagnostic process; their bodies remain unchanged. No runtime
file, runtime manifest, template or base is rewritten. Failure-site line numbers
refer to the installed runtime source, which can differ from this checkout.

Before preparation, `directories` records the 14 requested engine/file/runtime
roots. Listings use lstat metadata only, do not follow directory links, and stop
at 64 entries each. They contain entry names, uid/gid/mode/type, never contents.
Missing roots and truncated listings are explicit.

An image failure at `qualify_engine` with `containment_smoke` also reports
`attesterQualification` from that original launcher attempt. `qualification`
then repeats B4's `containment_repro.py` qualifier: a private HOME/TMPDIR, the
same launcher and scope, `unshare --net`, and loopback brought up before exec.
It preserves B4's `summarize()` fields: identity checks/resource limits and
workload/capture/humanServices/actorTools secure/error/check details. Diagnostic
text uses B4's redaction and a maximum of 2000 characters (200 for string checks).
If no report is produced, `qualification.launchDetail` imports the same
`launchCloudEngine({operation: 'qualify'})` and catches the launcher's error name,
allowlisted message and code. It emits no stack or arbitrary stdout/stderr.
These retries share a 400-second probe deadline; timeout capture sends SIGTERM
for scope retirement before SIGKILL. They never launch the product engine.

The console and mode-0600 journal contain only resource/run IDs, fixed check
names, booleans, source/function/line sites, and path/uid/gid/mode/realpath/type/link
metadata. Unknown paths and credential-like path components are withheld or
redacted. Runtime digest path components are replaced with `<runtime>`. File
contents, arbitrary launcher exception messages, provider bodies, process
environments and URLs are never emitted. Selected qualification diagnostic text
is redacted as described above. The first failed check stops subsequent admission
probes; the containment failure alone permits the diagnostic retries above.
Caught phase and top-level failures emit closed diagnostics to stderr: a fixed
phase, allowlisted error name and code/check, and known SQLSTATE when available.
Send both the JSON report and these stderr diagnostics to the orchestrator.

## Cleanup and result

Cleanup always runs in `finally`. A lost fork reply is replayed with the recorded
idempotency key and identical body to recover the child. Only the recorded child
can be deleted; the template ID is explicitly rejected. Cleanup requires a
deletion-operation receipt for that child and a subsequent sandbox 404. The
receipt must be completed, or blocked at one of the documented storage-only
stages: `waiting_for_uploads`, `kept_for_newer_snapshots`, `waiting_for_restore`
(the same compute-release rule as builder cleanup in #315). A 404 or a DELETE
acceptance alone is not confirmation.

The journal is `.context/zeros-v2-test-s1/<run UUID>.json`. `cleanup: "verified"`
means the fork's compute was released, without proving storage erasure.
`cleanupStorageStage` records the storage-only blocked stage, or is null for a
completed receipt. Existing journals without this field remain readable.
`not_created` means no fork request was sent.
`cleanup: "pending"` requires recovery using the saved journal:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/template-setup-repro.mjs --cleanup RUN_UUID
```

The original check result is retained. The script exits nonzero when a check
fails even after successful cleanup, so send its closed JSON report to the
orchestrator. An unknown allocation older than Boat's 23-hour retry margin is
not replayed into a possible new allocation. Keep its journal for reconciliation.
An interrupted process can retain an unconfirmed child; keep its journal and run
the cleanup command before discarding the credential-bearing workspace.

## Confirmed attachment qualification failure (2026-10-05)

The orchestrator's run of `d63e6622` on fork `bx_cmscg8v2` reported
`humanServices.secure=false`, phase `attachment-publication`; identity, workload
and capture passed, and the engine roots were clean. The orchestrator confirmed
the fork's cleanup. A local regression reproduces the failing qualification
operation with real Linux bind mounts: renaming from private attachment staging
to the logical primary root fails with `EXDEV`.

The staging layout already supports computer workspaces. The launcher binds
`/srv/zeros/files` at `/srv/zeros`, exposing both `attachment-staging` and
`repos/<owner>/<name>` on one mount, then binds the primary separately at
`/srv/zeros/workspace` (`sandbox/cloud-engine-view.mjs:83`, `:96`). Its root-owned
admission publishes the matching repository alias (`cloud-engine-launcher.mjs:345`).
The allocator selects staging against that alias
(`apps/desktop/src/engine/files/attachment-temporary-directory.ts:85`), and real
attachment publication already translates its destination
(`apps/desktop/src/engine/files/context-graph.ts:546`, `:571`). The qualification
previously skipped that destination translation. It now uses the same validated
`cloudWorkspacePublicationPath` for its atomic rename
(`sandbox/qualify-cloud-human-services.ts:62`), retaining the worker read-denial
check and the single-rename publication check. Engine-private staging remains
10003:10003 mode 0700; repositories remain owned by 10001:10001.

This is a runtime-only fix; no new base image or template sanitation change is
required. Publish and qualify the corrected runtime on Alpha, rebuild/activate
the org's Cloud Computer using that runtime, then create a new workspace through
Zeros Dev. Rebuilding is necessary for adoption because workspace creation
prefers the template build's still-qualified runtime pin
(`apps/control-plane/src/cloud-workspaces/computer-workspace-source.ts:144`,
`:149`); publishing a newer runtime alone does not replace that pin. Existing
failed generations keep their saved source and runtime. The fix requires no
desktop protocol or application update. Live verification of the corrected
runtime remains for the owner/orchestrator.

## Source trace and candidate mismatches

These are candidates from code inspection, not a live root-cause claim. References
are to the initial main baseline; the probe supplies exact deployed source sites.

| Gate                           | Builder/restore behavior and concrete mismatch candidate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest equality and metadata | `sandbox/cloud-computer-checkout.mjs:119` opens `/srv/zeros/computer-template.json` without following links, requires a root-owned regular single-link file, protected mode, size bound and canonical path, then exact canonical JSON equality at line 126. `runtime-base-v4/computer-build.py:785` publishes it as 0444 outside the B10 files bind. A missing/restored file, changed ownership/link metadata, or disagreement with the saved CP manifest fails here.                                                                                    |
| Files and repo parents         | Checkout lines 58–61, 117–118 and 131 require canonical directories with UID 0 and no group/other write bits. Builder lines 403–416 normalize `repos` and owner parents to root:root 0755. B10 `bootstrap.py:920` binds backing `files` to `/srv/zeros/files` and `files/repos` to `/srv/zeros/repos`. Lost ownership or a restored symlink/covered inode breaks the expected layout.                                                                                                                                                                    |
| Git metadata tree              | Checkout lines 76–108 require UID 10001, regular single-link files or directories, no links, no set-ID bits, and no external-object/worktree authority. Builder `computer-build.py:438` permits relative links resolving within a checkout, including Git metadata; its explicit forbidden list at line 455 differs from checkout's line 82. A retained internal `.git` link or `gitdir`, `config.worktree`, or HTTP alternates can pass the builder and fail setup. Builder lines 472–474 chown the full clone, but restore could change that metadata. |
| Repository whitelist           | Checkout lines 136–138 reject unadmitted owner/repository entries. Builder sanitation lines 738–750 reverify selected clones and preserve the entire `repos` directory; it does not remove unselected entries created by an install recipe.                                                                                                                                                                                                                                                                                                              |
| Nested mounts                  | Checkout line 141 rejects host mounts beneath `/srv/zeros/files`. B10's files bind and external `/srv/zeros/repos` alias are compatible; a retained build/restore mount inside the files tree is not. Builder's install alias is normally confined to its private mount namespace (`computer-build.py:517`).                                                                                                                                                                                                                                             |
| Boot-bound computer admission  | Checkout lines 149–191 bind the private admission to the active runtime, boot/session, base compatibility, execution and engine IDs, then reverify the template. Setup publishes it at `setup-cloud-workspace.mjs:2717` after template verification. Builder sanitation removes the active runtime descriptor and build state; the base republishes a boot/session-bound descriptor on restore. Stale admission or runtime/session disagreement fails closed.                                                                                            |
| V4 image preflight             | `setup-cloud-workspace.mjs:2494` runs the installed attester and checks execution, report shape, profile, qualification, runtime witness, helpers and allocation resources. Attester lines 749–788 verify runtime/receipt/base/boot identity; lines 852–877 verify protected helpers and tree metadata; lines 974–982 perform containment, resource and setup-process qualification. A restored helper/mode, missing primary projection, or incompatible allocation can fail despite successful base bootstrap.                                          |

Control-plane material starts with the saved source in
`apps/control-plane/src/cloud-workspaces/setup-materials.ts:986` and emits the
computer contract at line 1371. The exact manifest mapper is
`computer-workspace-source.ts:30`. C5 dispatches the fork at
`boat-provider.ts:322`; fork acceptance does not prove readiness.

The helper also maps supervisor prepare failures (`setup-cloud-workspace.mjs:2196`),
a non-v4 computer runtime (2713), unsafe host/setup/runtime/settings/journal
operations caught at 2751, and either image preflight (2726) or launch attestation
(2738) to `image_contract_invalid`. A non-v2 material response is rejected at
1391; other computer material/schema failures during redemption become
`settings_invalid` at 1395. Computer checkout rechecks the template at
`cloud-computer-checkout.mjs:261` and requires safe `.git/config` metadata at 245.
Origin/revision/HEAD mismatches instead use `repository_revision_invalid`.
Bare-base clone/staging/image-seed failures are bypassed for a computer workspace
(`setup-cloud-workspace.mjs:2122`). Platform/root entry rejection and unexpected
top-level failures also use `image_contract_invalid` at 2860/2872/2891. The control
plane maps that closed code to `setup_image_contract_invalid` in
`daytona-setup-executor.ts:120`.
