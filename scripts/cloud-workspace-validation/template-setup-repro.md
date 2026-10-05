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
- `ZEROS_S1_ALPHA_DATABASE_URL`: a direct, verified TLS connection to Alpha;
  the existing `ZEROS_C5_ALPHA_DATABASE_URL` is also accepted when S1 is absent.
- `BOAT_API_KEY`
- `BOAT_BILLING_ORG`: the same wallet recorded for the saved template.

No inherited credential or database URL is used. Do not pass credentials in
arguments. Use the affected workspace UUID and its recorded template sandbox ID:

```sh
pnpm exec tsx scripts/cloud-workspace-validation/template-setup-repro.mjs --run --workspace WORKSPACE_UUID --template TEMPLATE_SANDBOX_ID
```

The fork POST has C5's `type`, `ttlSeconds`, `noEnv: true`, and `env: {}` fields,
without a `from` field. The resource size comes from the accepted generation;
the diagnostic lease is bounded to 1800 seconds. The child is named
`zeros-v2-test-s1-<run UUID>` immediately after allocation. The script waits for
the same `bootstrap.py status` schema, base identity, and host state that the
production Boat setup runner requires.

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

The console and mode-0600 journal contain only resource/run IDs, fixed check
names, booleans, source/function/line sites, and path/uid/gid/mode/realpath/type/link
metadata. Unknown paths and credential-like path components are withheld or
redacted. Runtime digest path components are replaced with `<runtime>`. File
contents, exception messages, provider bodies, process environments and URLs
are never emitted. The first failed check stops subsequent admission probes.

## Cleanup and result

Cleanup always runs in `finally`. A lost fork reply is replayed with the recorded
idempotency key and identical body to recover the child. Only the recorded child
can be deleted; the template ID is explicitly rejected. Cleanup is confirmed
only by a completed deletion-operation receipt for that child. A 404 or a DELETE
acceptance alone is not confirmation.

The journal is `.context/zeros-v2-test-s1/<run UUID>.json`. `cleanup: "verified"`
means the fork was deleted; `not_created` means no fork request was sent.
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
