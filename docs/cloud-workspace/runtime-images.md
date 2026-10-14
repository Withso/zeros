# Cloud runtime images

A runtime image is a Boat named snapshot of an approved base with one qualified
runtime already installed and current. Cloud Computer builds can start from
that image and skip artifact presigning, download, extraction and installation.
They still verify the complete runtime before cloning repositories or running
the organization's install script. The base, bundle and qualifications remain
the authority; the image is a derived allocation source.

`CLOUD_RUNTIME_IMAGES_ENABLED` defaults to `false`. With Boat and runtime
artifacts configured, enabling it permits new image production and new Computer
claims to choose images. Disabling it restores base selection for new claims;
already pinned creates and cleanup retain their image source. The image worker
continues reconciling and retiring existing resources while the flag is off.
Database maintenance, pending migrations and the shared background-worker pause
still prevent worker startup.

Alpha is the supported rollout. The shared runtime selector still reads the
Alpha release head, and the Computer build worker remains Alpha-only. Image
rows and names record the producing control plane's deployment channel, but
using Beta and Production release heads requires a separate change to runtime
selection. Image creation grants no new runtime qualification or channel
admission.

## Rollout and rollback

Enable images only after every control-plane replica runs image-aware code.
Before reverting to a release without image support, set
`CLOUD_RUNTIME_IMAGES_ENABLED=false` and keep an image-aware worker running
until unknown image creates, building attempts and pending retirements have
drained. Disabling selection preserves saved image intents; older workers cannot
replay them. Any remaining operation requires operator reconciliation before
removing the image-aware worker.

## Production and publication

`runtime-images.ts` owns the producer and named-snapshot lifecycle. Migration
0141 adds the system-only `cloud_runtime_images` registry, the `runtime-image`
builder purpose and the nullable Computer source-image pin. The worker sweeps
at startup and every 150–300 seconds with jitter; registry and Computer-builder
completion notifications wake it sooner. Full retirement pages continue in a
bounded burst (see [wake performance](wake-performance.md)). It admits one
building image per channel, provider account and wallet, and records its builder
intent before provider I/O. It reads and
changes only rows, journals and names of its own provider account and wallet;
a wallet rotation keeps the account scope, so a prior wallet's rows never
block or get touched by the new one. Each attempt has a 60-minute deadline, bounded VM
operations and separate cleanup reconciliation.

1. Select the qualified runtime and approved base with the same selector and
   evidence mode used by Computer builds. Record their immutable identities,
   account scope, billing wallet and a fresh snapshot name.
2. Create a snapshot-enabled `runtime-image` builder from the base. Require the
   expected base compatibility and no current runtime, then install the exact
   selected descriptor with `purpose: "build"` over pinned SSH stdin.
3. Require the expected current runtime and idle host. Stop with confirmed
   capture, then save that disk as a named snapshot. The name is
   `zeros-rtimg-<channel>-<runtime12>-<nonce8>`; it is separate from release-worker
   names and never reused for another attempt.
4. Create a cold probe from the recorded named snapshot. Its journal is prepared
   by the producer for that exact building row; ordinary image resolution admits
   only ready rows. Require the expected runtime, base compatibility and idle
   host, then run `computer:verify-tcb` in baseline mode for a full runtime hash.
5. Confirm deletion of both temporary VMs and revalidate the saved runtime's
   admission before publishing the image as ready. A failed attempt first
   fences publication, then cleans its VMs and any saved name before becoming
   failed. An uncertain publication result is re-read, so only retirement
   deletes a published image's name. Uncertain cleanup keeps its journal and
   is retried.

The producer never clones organization repositories or runs their recipes, and
never runs `computer:sanitize`. Sanitation writes a Computer-template admission
manifest, which does not belong in a shared runtime image. Of the Computer
helpers, a `runtime-image` VM can invoke only `computer:verify-tcb`; normal
Computer builders retain the complete helper allowlist.

Failed production attempts have a ten-minute retry delay and a limit of five
failed attempts for the selected channel/runtime/base tuple. Changing the flag
does not reset that durable history or recreate an in-flight intent.

## Computer consumption and replay

The claim transaction first selects and locks the runtime's admission rows,
then locks a ready image for the exact channel, runtime, base compatibility,
base image, account scope and billing wallet. It prepares the builder journal
and inserts `cloud_computer_templates.builder_source_image_id` in that same
transaction, without provider calls. No matching ready image uses the existing
base-and-install path.

The nullable pin is immutable once the builder operation exists. A non-null
pin reconstructs `{kind: "image", imageId}` and the journal supplies the saved
`/sandboxes` request with `from: <snapshotName>`. A null pin reconstructs the
original `{kind: "base", baseImageId}` source and preserves the legacy intent
digest. Retries and cleanup never select a newer image, switch to a base or
change the original request body/key because a flag or image state changed.

An image-sourced builder requires the pinned base compatibility, the exact
current runtime and an idle host. It skips `install-runtime` and starts with no
artifact URL to redact. The full TCB baseline, repository clones, recipe,
post-install integrity check, runtime self-test, sanitation, capture and final
Computer manifest remain required. Completion revalidates the original runtime
pin as before. See [Computer template builds](computer-template-builds.md).

A deterministic initial runtime/base mismatch withdraws the image from ready
to retiring. This is the consumer's only automatic withdrawal evidence. The
frozen base helper reports internal timeouts and generic OS errors as
`tcb_modified` with `timedOut: false`, so even that diagnostic fails only the
build and leaves the image ready. Transport errors, malformed output and later
recipe or integrity failures also leave the image ready. Setting
`CLOUD_RUNTIME_IMAGES_ENABLED=false` provides a manual base fallback for new
claims while investigating repeated TCB failures. A future qualified base with
distinct corruption and transient-error diagnostics can restore automatic TCB
withdrawal. Identity withdrawal retains publication evidence; later claims can
fall back to the base while the producer prepares a replacement.

## Retention and recovery

The image worker retains up to two newest ready images in its channel and
provider scope. Older, revoked or confirmed-missing images become retiring.
Named snapshots have their own provider billing lifecycle; their existence is
periodically checked. An unavailable provider response is not proof that a name
is missing.

Retirement conflicts with the image share lock used by a claim. After withdrawal
commits, deletion waits until no Computer allocation still references the image
without either `stopped_at` or `cleanup_confirmed_at`:

```sql
NOT EXISTS (
  SELECT 1 FROM cloud_computer_templates template
  WHERE template.builder_source_image_id = image.image_id
    AND template.stopped_at IS NULL
    AND template.cleanup_confirmed_at IS NULL
)
```

This guard includes failed and cancelled builds: an unknown dispatched create
may still need its original name during reconciliation. The worker confirms
named-snapshot absence before recording retired. It does not sweep unrelated
provider inventory or rewrite immutable image identities.

## Workspace impact and validation

Local Personal and organization-local workspaces do not use these control-plane
builder paths. Switching owners or placements does not change their behavior.
New organization cloud workspaces continue to fork their admitted Computer
template, including its repositories and packages. That template already
contains the runtime; workspace setup retains the installer's cached verification
and its existing admission, artifact and receipt contracts. A global runtime
image does not replace the organization template source.

Database and provider-fixture tests cover image/base choice, disabled and
unavailable fallback, legacy digests, withdrawal replay and quarantine evidence.
They do not establish live Boat restore behavior or a build-latency target.
An authorized live rollout must confirm cold restoration, full TCB verification,
Computer capture and temporary-resource cleanup before claiming performance
results.
