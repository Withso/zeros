# Cloud workspace root coordinator exception review

## Decision status

**Not approved for production.** The legacy version 1 image deliberately runs
the PID 1 supervisor, image attester, fixed engine launcher, and Zeros engine as
root. Repository Git operations, declared setup commands, terminals, and agent
processes run as UID/GID 10001. This is a bounded qualification architecture,
not satisfaction of the non-root requirement. The version 2 candidate described
below is the elimination path; its full live release qualification is incomplete.

Phase 2 must remain release-blocked until either:

1. the engine is moved behind a minimal privileged broker and runs as a distinct
   non-root identity; or
2. the exception is approved by the accountable security owner for an explicit
   image digest, provider configuration, expiry date, and set of compensating
   controls after a green live Daytona qualification.

Code review, unit tests, and PostgreSQL integration tests do not constitute that
approval or the required provider evidence.

## Scope and necessity

The exception applies only to the image profile identified by
`/etc/zeros/cloud-worker.json` and its immutable snapshot digest. The current
engine remains root because the cloud-worker containment backend validates
root-controlled tools and uses a privileged supervisor to create namespaces,
mount the admitted filesystem view, and drop an agent command to UID/GID 10001.
The root engine also reads short-lived root-owned credential projections without
making their bearer values readable by the workspace user.

The Daytona provisioning credential, control-plane database credential, signing
keys, refresh credentials, and client account JWT are outside the sandbox. Their
absence does not make root engine compromise harmless: a compromised engine can
still read current agent/provider working credentials, workspace data, engine
registration material, and every root-readable file in that tenant sandbox.

## Trust boundaries and controls

| Threat                                                                          | Current controls                                                                                                                                                                                                                                                                                     | Residual risk                                                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Repository or agent code executes outside its admitted view                     | Fixed root-owned engine/toolchain; cloud-worker ZSR qualification; commands drop to UID/GID 10001; exact filesystem and socket policy                                                                                                                                                                | An engine/parser/runtime compromise occurs before or outside the child boundary and gains sandbox root                                   |
| A writable checkout replaces bootstrap code                                     | Engine, launcher, helpers, marker, and build metadata are physically separate, root-owned, non-group-writable, attested immediately before launch, and tied to one snapshot/source contract                                                                                                          | Sandbox root can still modify these files after compromise unless the provider mount is immutable                                        |
| A workspace process invokes the root supervisor                                 | `/run/zeros` is root-owned `0700`; its Unix socket is root-owned `0600`; the protocol has exact keys, bounded input, a fixed launcher, and a one-use random prepare session                                                                                                                          | Any root compromise can use the same socket and is already inside the trusted computing base                                             |
| A stale setup proof launches another engine                                     | Attestation and launch share a non-blocking root lock; the proof is one-use and bound to boot/container namespace identity, image/build hashes, setup run, generation, and execution fence                                                                                                           | Provider suspend/resume and PID 1 behavior still require live verification for the exact image                                           |
| Secrets leak through arguments, URLs, logs, database rows, or child environment | Provider authority stays external; GitHub and engine capabilities are short-lived; database rows retain verifiers; fixed helpers use bounded documents/askpass; sanitized logs and exact child-environment construction are tested                                                                   | Root process memory and its initial environment remain sensitive for the lifetime of the process                                         |
| A replacement engine overlaps an older engine                                   | The supervisor serializes operations, stops the old process group with TERM/KILL bounds, consumes one launch session, and the launcher takes the shared engine lock                                                                                                                                  | A provider/runtime failure that violates process-group or PID 1 assumptions needs live qualification                                     |
| A tenant exhausts host resources                                                | Attestation requires finite CPU, memory, and PID cgroup limits; setup commands and provider calls have deadlines and bounded output                                                                                                                                                                  | No per-agent network egress policy is claimed; initial egress is direct tenant-VM traffic                                                |
| Preview, SSH, or tunnel authority survives lifecycle change                     | Access grants are generation/account-bound; only verifiers persist; lifecycle and membership changes schedule provider-wide SSH revocation; generation replacement drains the source before candidate provisioning; Electron main stops local tunnels and invalidates same-generation sibling leases | Correct Daytona token invalidation and stop/wake behavior must be proven against the live provider                                       |
| Desktop renderer or preview content obtains a provider access bearer            | Raw grant material stays in Electron main; preview header injection requires an exact origin plus authorized frame ancestry; Terminal/tunnel and IDE launch use private SSH files; IDE argv contains only a fixed alias; IPC returns bearer-free receipts                                            | The exact signed macOS clients, Remote-SSH behavior, expiry cleanup, and live-provider revocation still require end-to-end qualification |

## Required elimination design

The preferred production design keeps a minimal root PID 1 broker but removes
the general engine from root:

- run the engine under a dedicated non-root engine identity, distinct from the
  UID/GID 10001 workspace/agent identity;
- give the engine identity only the repository, data, and credential-broker
  access it needs; never make a bearer file readable by the workspace identity;
- move namespace/mount/setpriv construction into a small root broker with a
  versioned, exact-schema, record-before-dispatch protocol and no arbitrary
  command, path, environment, or network inputs;
- pass capabilities through one-use descriptors or broker responses rather than
  ambient root-readable files or long-lived process environment;
- make the engine installation and broker filesystem read-only at the provider
  or VM boundary where supported;
- attest both identities, supplementary groups, capabilities, seccomp,
  `NoNewPrivs`, mount flags, cgroup limits, and denial of engine/agent reads of
  root broker state;
- rerun the complete live image, bridge, PTY, agent, stop/wake, generation
  replacement/rollback, preview, SSH/tunnel, soak, and deletion qualification.

## Version 2 elimination candidate

The common Linux image now launches the engine in a user namespace with exactly
these mappings:

```text
namespace UID/GID 0          -> VM UID/GID 10003
namespace UID/GID 10001–10002 -> VM UID/GID 10001–10002
```

VM root and the provider's login user are not mapped. The engine is namespace
root, not VM root: its ownership and sandbox-construction capabilities apply
only to the three mapped identities. Agent and capture identities remain
distinct. Immutable deployment files appear as unmapped owners in the engine
view; acceptance requires the exact kernel identity maps and a read-only mount,
after the host broker attests physical root ownership.

The host launcher provides a fixed mount and environment view. Setup journals,
broker sockets, provider login homes and host root credentials are absent.
Engine credentials use host `/run/zeros/engine`, projected as `/run/zeros` in the
engine. Managed settings have a root-owned source and a read-only projected
copy. The launcher places its native child in a finite cgroup before bubblewrap
can fork. Retirement kills and drains the entire cgroup, including detached
descendants, before another setup session can be admitted.

Process-local `/proc` entries permit child identity mapping for rootless
containers and browser sandboxes. Procfs remains fully visible: locked child
mounts make Linux reject a new procfs mount in a nested container PID namespace.
Global controls retain VM-root ownership, which is unmapped in the engine; its
namespace capabilities cannot authorize writes to those controls. The native
launcher checks procfs type and control ownership before entry. Qualification
checks write denial without changing kernel values, alongside host process
memory/root-link denial, ancestor namespace denial, locked deployment mounts,
worker child-namespace creation, and actual private container execution. This
depends on the exact kernel/user-namespace behavior and must pass on each image;
it is not permission to disable provider security controls. See the
[Linux user namespace permission rules](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)
and [mount visibility checks](https://github.com/torvalds/linux/blob/master/fs/namespace.c).

On kernels with AppArmor's unprivileged-user-namespace restriction, a launcher
in the initial host user namespace loads the image-owned `zeros-cloud-engine` application profile. It
grants nested user namespaces only to the fixed, root-executable namespace
helper and its descendants. The global restriction is never disabled. Hosts
that require but cannot load this profile fail admission. Inside a provider's
existing user namespace, outer policy belongs to the provider: the launcher
does not attempt to replace host policy, and admission still requires the full
nested engine, worker, and browser qualification. Fixed kernel sysctls may be
read from root-owned provider FUSE projections with bounded reads; process UID
maps require real procfs. Only the exact `/sys` and `/sys/fs` sysfs ancestors
may have an unmapped owner. Writable cgroup controls still require UID 0 and
cgroup-v2 filesystem identity. Private shared memory
is a bounded 512 MiB tmpfs inside the engine's memory cgroup.

The one-use image admission and fixed root supervisor remain required. A
successful identity probe alone does not qualify the engine, agent sandbox,
container workflow, capture, lifecycle or recovery behavior. Both provider
artifacts must pass the complete applicable suite before the setup-worker gate
can open. No root exception has been granted.

## Exception approval record

An approval, if chosen instead of elimination, must be retained outside the
repository with all of the following:

- security owner and approving authority;
- exact source commit, image/snapshot digest, Daytona target, and worker profile;
- dated live qualification run and cleanup evidence;
- accepted residual risks and compensating controls;
- expiry/review date and rollback owner;
- confirmation that `CLOUD_WORKSPACE_SETUP_WORKER_ENABLED` remains `false` until
  the approved artifact is deployed.

No approval record is present as of this review. The exception therefore remains
open and the setup worker gate must remain disabled.
