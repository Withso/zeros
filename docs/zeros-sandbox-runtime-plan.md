# Zeros Sandbox Runtime — host parity and Design authority

**Status:** current implementation contract, 2026-08-23.

Zeros Sandbox Runtime (ZSR) is an actor-scoped filesystem boundary. It preserves
the behavior of the deployment in which the agent runs and subtracts only the
write authority that belongs to the opposite actor, plus a small set of engine
control files. This document is normative for new containment work; older
private-HOME, shadow-Git, credential-proxy, port-broker, and per-agent-cgroup
designs are historical and are not shipped paths.

This plan does not modify `autonomous-code-design-foundation.md`. Changes to
that protected document remain separate maintainer-approved work.

## Runtime contract

| Actor / deployment            | Writable filesystem                                                                                                                                                               | Host-parity behavior                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local code or repository task | Current and explicitly attached roots are writable except recognized Design; unrelated Zeros-managed workspace collections and engine authority/control descriptors are read-only | Real HOME/XDG state, provider credentials, Git configuration, hooks, network, ordinary Unix sockets/local services, processes, devices, ports, and readable filesystem; macOS app-launch authority and ambient container endpoints are subtracted |
| Local Design actor substrate  | Managed workspace collections and every external registered code owner are read-only; recognized Design directories and the current repository's minimal Git metadata islands are writable             | Same local host behavior and subtractions; no production feature selects this actor yet                                                                                                                                                           |
| Cloud code or repository task | Same code/Design subtraction inside the tenant VM; engine state is also unreadable/unwritable                                                                                     | The VM is the tenant boundary. The agent runs as the configured non-root worker UID with the VM's real HOME, provider credentials, network, services, and device/process behavior                                                                 |
| Cloud Design actor substrate  | App-wide inverse code/Design write map inside the tenant VM                                                                                                                       | Same cloud host parity; not product-wired                                                                                                                                                                                                         |

Host parity is explicit in the patched Sandbox Runtime configuration. On macOS
the generated Seatbelt profile begins with ordinary host authority and appends
read/write subtractions. Zeros then intersects it with an immutable nested
profile that explicitly denies Apple Events, Launch Services app opening, and
known/advertised ambient container sockets. On Linux bubblewrap preserves the
deployment's process, network, IPC, and `/dev` behavior while applying
bind-mount filesystem rules, including masks over known/advertised ambient
container sockets. The root cloud supervisor may retain only the capabilities
needed to construct the namespace; `setpriv` then enters the exact non-root
worker UID/GID with locked securebits, empty capability sets, and
`no_new_privs`.

## App-wide actor symmetry

The authority map combines stable collection-level subtraction for
Zeros-managed worktrees with exact canonical subtraction for physical main
checkouts, open project roots, and explicit additional repositories.
Registration is deny-only; it never grants a sibling checkout to the current
actor. A code boundary reopens its current managed workspace and only the
already-existing managed islands covered by an explicit broader `/add-dir`
grant. A future sibling remains read-only because it was covered before its path
existed.

- A code actor may write code across its normal authorized roots but may not
  write any recognized Design directory in any registered owner.
- A Design actor may write recognized Design directories but may not write code
  in any registered owner.
- Adding an external owner, removing an owner, or changing a recognized
  territory closes new admissions, retires every affected code/task/utility
  boundary, proves its process domain empty, and only then publishes the new
  authority. Creating a managed sibling for an already registered repository
  does not retire unrelated actors: their immutable collection deny already
  covers it. Per-owner provisional snapshots preserve the same race guarantee
  for a writable current or explicitly attached managed island.
- Immutable profiles are never patched in place. The next use admits a new
  generation.

Sticky Design recognition is engine state. Once Zeros has admitted a Design
directory, edits to committed `.zeros` settings cannot silently remove it from
the next authority map while the directory still exists. The recognition store,
database and SQLite sidecars, worktree recovery seeds, command descriptors, and
policy files are write-denied to both actors. Cloud workers cannot read engine
state either.

## Git contract

Agents use the canonical repository; there is no shadow repository, private
index, promotion phase, remote broker, hook suppression, or rewritten stderr.

Ordinary and path-naming Git operations run natively inside the actor's OS
fence. This includes status/diff/log, add/commit, fetch/push, clean/rm/mv,
restore, every stash form, and checkout/reset forms that can name a path.
Therefore the following must fail when the target is Design content:

```text
git checkout <commit> -- <designfile>
```

Whole-tree integrations need to retain normal workspace behavior. A compiled
fast-path dispatcher sends only checkout, switch, pull, merge, rebase,
cherry-pick, revert, and write-tree reset candidates to a generation-scoped
engine broker. The broker independently:

1. bounds request and response sizes;
2. authenticates the generation and capability token;
3. re-parses the complete argv and rejects help, unsafe global options, and
   pathspec forms;
4. resolves cwd physically and requires an exact registered worktree plus Git
   metadata identity (not merely a descendant or nested repository), and proves
   an ambiguous one-argument checkout names a commit rather than a path;
   before execution it rewrites that form to an unambiguous full local-branch
   ref or immutable detached commit, so a ref-to-path race fails closed; the
   current-HEAD no-op spellings `HEAD` and `@` stay native so they do not detach
   a symbolic branch;
5. executes hardened engine Git with hooks/filters/ambient repository selectors
   controlled by the engine.

The engine operation may materialize tracked Design changes because it is a
trusted repository integration rather than agent filesystem authority. The
accepted residual is **commit-then-merge laundering**: an agent able to construct
and commit a Design-changing tree without writing the Design worktree can ask a
tree-level integration to materialize it. Closing this requires content-aware
authorization or a different product contract. Regression tests pin both this
trade and the path-checkout denial so neither is accidentally overstated.

## Network, credentials, resources, and services

The deployment boundary is intentionally simple:

- Network access is direct. ZSR does not enforce per-agent egress allow/deny
  rules and does not run an authenticated HTTP/SOCKS proxy.
- Provider keys are presented in their normal raw environment/file form. ZSR
  does not replace them with sentinels or inject them at a proxy. In cloud, the
  tenant VM is the credential boundary.
- ZSR does not create per-agent CPU, memory, PID, or IO cgroups. Cloud resource
  sizing and limits belong to the tenant VM/provider. Process-domain tracking
  and proven teardown remain mandatory.
- Local TCP/Unix services and custom toolchains use their normal deployment
  paths, except ambient container endpoints described below. There are no no-op
  service leases or read-root projections.
- Requested and discovered development ports are reported directly; host-parity
  ports are not namespace-translated.
- macOS Apple Events and Launch Services app opening are deliberately absent.
  URL/application opening remains a trusted renderer action; agent code cannot
  use `open` or `osascript` to launch an unrestricted process outside ZSR.

These are conscious launch trades, not missing enforcement claims. They may be
reintroduced after cloud workspaces ship only with a new explicit contract and
qualification matrix.

## Containers

Container workflows are retained because forwarding a host Docker/Podman daemon
would delegate host filesystem authority outside the actor fence.

- Linux can launch the embedded rootless Podman worker with generation-owned
  state and socket.
- macOS uses a qualified, dedicated OrbStack machine shared by canonical
  workspace/actor-policy key and reference-counted across sessions.
- Design actors never receive container workers.
- If a normal workspace advertises container use but no safe worker is
  available, status reports `container-workflows-unavailable`; it never silently
  forwards the ambient daemon socket.
- Every launch removes `DOCKER_HOST`, `DOCKER_CONTEXT`, `CONTAINER_HOST`,
  `CONTAINER_CONNECTION`, and `PODMAN_HOST` before adding only a private-worker
  endpoint. Default and explicitly advertised Unix daemon sockets are masked on
  Linux and denied by path on macOS, so knowing the original socket path does
  not recover the authority.

Arbitrary same-user TCP services and nonstandard endpoints that were never
advertised to Zeros remain part of the scoped local-service trade above. They
must not be reported as isolated container support; a backend is claimed only
when the dedicated worker qualification passes.

The bundled container worker, OrbStack host relay/cloud-init, and process-domain
helper therefore remain shipped assets. Their internal namespaces are container
implementation details, not per-agent ZSR cgroups or egress policy.

## Lifecycle and recovery

Every provider runtime, MCP child, hook, repository task, PTY process group, and
subprocess must be registered in the same boundary generation. Admission writes
root-owned/read-only policy and command descriptors, launches a live canary, and
publishes status only after the exact fence is proven.

Revocation closes the Git broker and container capability, retires all observed
processes, handles processes adopted after retirement began, waits for the
process domain to become empty, and only then removes generation state. Failed
proof is retained as recovery evidence and blocks later admissions. Boot
recovery runs before workspace authority is published.

Legacy serialized names and recovery holds may remain where older installations
can contain them. They are compatibility contracts, not evidence that the old
runtime path is still active.

## Current implementation surface

The active path consists of:

- `policy.ts` — canonical app-wide write subtraction and engine authority;
- `zsr-supervisor.mjs` — immutable descriptor validation, Sandbox Runtime
  wrapping, worker UID entry, and process supervision;
- `zsr-boundary.ts` — admission, canary, direct ports/services, containers,
  process-domain tracking, and teardown proof;
- `git-integration-broker.ts` plus `zsr-git-dispatch.c` — narrow trusted
  whole-tree Git integration;
- `macos-process-domain.ts` and the native helper — same-user descendant proof;
- container worker/OrbStack components — dedicated OCI capability.

Removed paths include admission priority/preflight UX, provider HOME projection,
provider credential masking, shadow Git and promotion, network/port/service
brokers, SRT network bridge, per-agent cgroups/resource limits, and their
packaged artifacts and tests.

## Graduation rule

Implementation tests are not platform qualification. Release evidence must run
the exact packaged bytes on every claimed OS/architecture and, for cloud, the
actual provider image. See
[zeros-sandbox-runtime-qualification.md](zeros-sandbox-runtime-qualification.md).
Never translate a Linux result into a macOS claim or a generic CI container into
a cloud-provider claim.
