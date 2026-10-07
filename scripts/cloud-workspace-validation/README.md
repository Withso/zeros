# Cloud workspace runtime tooling

Boat is the supported cloud compute provider. This directory owns the portable
OCI engine image recipe, image publication, Boat image tooling, runtime bundles
and operator qualification probes. Local workspaces continue to use their local
engine and do not allocate cloud resources.

## Runtime and release paths

- [Boat image kit](boat-image/README.md): build, attest, sanitize and snapshot a
  pinned Linux runtime image. Its fixed commands are also used by
  `scripts/release/worker-adapters.ts` and the control-plane image worker.
- `runtime-base-v4/` and `runtime-bundle/`: the current base/runtime publication
  contracts. Runtime pins belong to accepted generations; changing a deployment
  default does not update a running workspace.
- `image.ts` emits the portable Dockerfile and bounded build-context entries.
  `config.ts` owns source pins, runtime paths and the image contract digest.
  `Dockerfile` documents the equivalent checked-in runtime recipe.
- `publish-vm-image.ts` builds and publishes the portable OCI image using Docker
  registry authentication. Its private receipt binds the immutable registry
  digest to the exact source commit, image contract and build recipe.
- `lib/bridge-client.ts` is the account/capability-gated headless bridge client.
  Shared native qualification and setup tools remain under `lib/` and `sandbox/`.

An OCI publication receipt and GitHub provenance do not qualify a Boat worker.
Boat promotion still requires native machine attestation, scoped agent canaries,
finite lease/credit admission and verified cleanup. The protected
`cloud-worker-promotion` workflow and `scripts/release/` own these gates.

## Portable OCI publication

Run from the repository root after preparing Docker registry authentication.
The publisher requires:

| Variable | Purpose |
| --- | --- |
| `ZEROS_REPO_COMMIT` | Exact source commit |
| `ZEROS_CLOUD_VM_REGISTRY_REPOSITORY` | Registry/repository without a tag or digest |
| `ZEROS_CLOUD_VM_IMAGE_RECEIPT` | Absolute path for the owner-private receipt |
| `ZEROS_CLOUD_VM_REGISTRY_TAG` | Optional validated tag; defaults to source commit |
| `ZEROS_CLOUD_VM_MIN_FREE_DISK_BYTES` | Optional disk floor for a guarded build |
| `ZEROS_CLOUD_VM_DOCKER_ROOT` | Absolute Docker storage root when the disk floor is enabled |

```bash
pnpm exec tsx scripts/cloud-workspace-validation/publish-vm-image.ts
```

The recipe copies only allowlisted local runtime sources. Context creation
rejects symlinks, traversal, duplicate archive paths, oversized files and source
changes while reading. Receipt reads require an owner-private regular file and
matching source, image contract and recipe hashes. Registry credentials remain
outside authored source and published artifacts.

## Qualification and diagnostics

See [qualification status](../../docs/cloud-workspace/qualification-status.md),
[provider contract](../../docs/cloud-workspace/provider-contract.md) and
[release worker qualification](../../docs/cloud-workspace/release-worker-qualification.md)
for the required evidence and exact current limitations. The presence of a probe
or a passing local suite is not live deployment qualification.

[Workspace performance](workspace-perf.md),
[template setup reproduction](template-setup-repro.md) and
[engine connection reproduction](engine-connect-repro.md) describe their scoped
operator probes. Live operations require explicit authorization and the exact
qualified target; never treat a new default image as an existing generation pin.
Historical database constraints and seed rows are retained. Unsupported provider
rows remain readable but cannot authorize setup, access or lifecycle operations.
