# Zeros Sandbox Runtime qualification ledger

**Contract revision:** 2026-08-28 instant-session and exact-failure isolation.

This ledger defines the evidence required to claim that the shipped execution
boundary works. It does not treat historical results from removed shadow-Git,
credential-proxy, egress, service-broker, or cgroup paths as current evidence.
Record command results against the immutable commit and exact platform in the
release artifact or CI run, not by editing old pass counts into this document.

## Audited dependency

| Field                 | Value                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Package               | `@anthropic-ai/sandbox-runtime`                                                          |
| Version               | `0.0.73`                                                                                 |
| Upstream tag / commit | `v0.0.73` / `5feb5269f1c86f49e62224ffb8297b2f01a31806`                                   |
| License               | Apache-2.0                                                                               |
| Patch digest          | Read from `scripts/zsr-qualification/pin.json` and enforced by `pnpm check:runtime-pins` |

The patch is deliberately narrow. It adds host-parity profiles, explicit write
exceptions within a deny, optional removal of SRT's built-in opinionated write
list, exact root-path handling, and trusted Linux worker UID entry. It does not
add credential substitution, network policy, bind projections, port policy, or
resource controls.

## Conscious launch trades

The following are signed-off properties of the current cloud workspace boundary:

| Surface              | Current behavior                                                   | Boundary that remains                  |
| -------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| Egress               | Direct tenant-VM network; no per-agent deny/allow proxy            | Provider/VM network policy             |
| Provider credentials | Raw provider keys in normal process env/files; no sentinel masking | Tenant VM and non-root worker identity |
| Resources            | No per-agent cgroup limits                                         | Provider/VM sizing and limits          |

These rows must not be reported as tests that were skipped. They are absent
features. Qualification instead proves that removing them did not leave stale
proxies, rewritten environments, cgroup preparation, or misleading UI/status.

## Deterministic gates

Every change to the runtime boundary must run the repository-wide gates required
by `AGENTS.md`, plus the focused suites below:

```text
pnpm check:runtime-pins
pnpm check:zsr
pnpm check:design-containment
pnpm check:packaging-paths
pnpm check:protocol
pnpm test:git
pnpm typecheck
pnpm lint
pnpm check:ui
pnpm check:secrets
pnpm check:licenses
```

`pnpm check:zsr` is intentionally composite. It first runs the explicit
source-level contract matrix in `scripts/run-zsr-contract-tests.mjs`, then the
live `--require-secure` kernel/runtime qualification. Repository layout tests
require every `gateway-*` and containment suite to stay in that named matrix,
so adding a ZSR test file cannot silently leave the architecture-specific CI
jobs without it.

The focused containment tests must cover:

- real Linux bwrap code-write success and Design-write denial;
- inverse Design-actor policy and app-wide registered code-owner denial;
- exact path-checkout denial for `git checkout <commit> -- <designfile>`;
- one-argument checkout ref proof, ref-to-path race pinning, and native fallback
  for a Design path;
- successful branch-level integration of tracked Design changes;
- the accepted commit-then-merge materialization residual;
- hard-reset, checkout/switch/pull/merge/rebase/cherry-pick/revert argv
  classification, including pathspec/help/unsafe-global-option rejection;
- exact worktree/metadata identity and physical-cwd validation, including an
  unregistered nested repository;
- raw HOME/TLS/provider environment preservation and absence preservation;
- removal of ambient Docker/Podman selectors and failed direct connection to
  the advertised host-daemon Unix socket;
- on macOS, live effective-policy denial of `appleevent-send` and `lsopen`
  without launching an application during the probe;
- cloud worker non-root UID/GID, empty capability sets, `no_new_privs`, and
  root-owned policy/descriptor state;
- process adoption during retirement, descendant termination, exact-generation
  retry without unrelated-admission poisoning, and stale-process boot recovery;
- interactive cold create/resume returning after kernel-policy installation
  while the behavioral canary and fresh territory revalidation remain pending,
  plus automatic exact-tree stop before either background proof failure is
  reported;
- first-send admission appearing immediately as a live turn with one continuous
  timer and an enabled Stop control; Stop must invalidate the chat-scoped
  create/resume, dispose a late result, and permit an immediate clean retry for
  Codex, Claude, and Cursor without waiting behind the cancelled flight;
- init/prewarm single-flight and cold create/resume ordering contracts that
  prove provider startup is not awaiting background attestation or territory
  revalidation. These are causal/order assertions rather than CI wall-clock
  thresholds, so a slow runner cannot hide a critical-path dependency or make
  the gate flaky;
- blocking attestation for Setup, Run, utilities, and warm-spare preparation;
- speculative warm-session preparation disabled by default, with the explicit
  benchmark switch still requiring a fully attested boundary before adoption;
- last-confirmed provider-auth retention across an isolated utility-boundary
  failure;
- direct port behavior, dedicated container capability, and container teardown;
- app-wide owner add/remove/archive/restore transition ordering.

## Platform matrix

Deterministic tests may run anywhere they support, but a backend graduates only
with live evidence from the exact shipped environment.

| Target               | Required live evidence                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS arm64          | Packaged Seatbelt profile, effective Apple Events/Launch Services denial, ambient container-socket denial, process-domain helper, Git dispatcher, host HOME/network/ports, Design deny, path-checkout denial, whole-tree integration, OrbStack worker if claimed, and proven teardown |
| macOS x64            | Same matrix using the x64 packaged helpers; arm64 results do not substitute                                                                                                                                                                                                           |
| Linux x64            | Packaged bwrap/setpriv profile, ambient container-socket denial, exact worker identity when cloud mode is used, Design deny, Git split, direct network/services/ports, containers if claimed, and proven teardown                                                                     |
| Linux arm64          | Same matrix using arm64 package/runtime bytes; x64 results do not substitute                                                                                                                                                                                                          |
| Cloud provider image | Actual immutable image and deployment marker, tenant/workspace identity, root-owned engine state, non-root workload identity, lifecycle/reconnect/soak/SSH, snapshot deletion, and provider differential                                                                              |

A sandbox that cannot create the required bwrap mounts or namespaces is an
expected fail-closed environment, not a qualified Linux result. Likewise, a
local container with a fake provider does not qualify the production cloud
image.

## Git acceptance matrix

| Operation                                                               | Execution route                                      | Expected Design result                                |
| ----------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| status/diff/log/add/commit/fetch/push                                   | Native actor Git                                     | Filesystem fence remains authoritative                |
| restore/clean/rm/mv/stash                                               | Native actor Git                                     | Design writes fail                                    |
| checkout/reset with `--`, pathspec, or path operand                     | Native actor Git                                     | Design writes fail                                    |
| checkout/switch/pull/merge/rebase/cherry-pick/revert/tree-writing reset | Trusted engine broker after full argv/cwd validation | Tracked Design changes may materialize                |
| commit containing a synthetic Design tree, then brokered merge          | Native commit + trusted integration                  | Materializes; accepted residual and regression-pinned |

The compiled dispatcher is an optimization, not authority. A dispatcher
misclassification must still be corrected by the Node client/broker or fall
back to native Git under the kernel fence.

## Packaging evidence

The packaged application/image must contain exactly the active assets:

- bundled ZSR supervisor;
- container worker and OrbStack host/cloud-init assets;
- macOS process-domain helper where applicable;
- macOS Git integration dispatcher where applicable;
- pinned Sandbox Runtime package and patch;
- the normal provider runtimes and PTY host.

It must not package removed network bridges, credential authorities, port
interposers, cgroup preparation scripts, resource-limit helpers, or shadow-Git
clients/stores. `pnpm check:packaging-paths` and packaged-app smoke own this
assertion.

## Release reporting

A handoff or release note should state:

1. the immutable commit and patch digest;
2. each command actually run and its result;
3. OS, architecture, and provider image for live checks;
4. explicit platform-only checks not run;
5. any parity restriction such as unavailable dedicated containers;
6. that direct egress, raw provider keys, per-VM resources, and the
   commit-then-merge residual are conscious current trades.

Never claim a platform-only check passed on a different platform.
