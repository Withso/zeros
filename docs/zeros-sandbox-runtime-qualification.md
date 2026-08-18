# Zeros Sandbox Runtime qualification ledger

**Evidence date:** 2026-08-18 UTC

**Scope:** local host-parity profile plus retained cloud isolation;
release-wide qualification remains open.

This ledger records what was actually executed for the uniform Zeros Sandbox
Runtime (ZSR), what passed, and what still needs an exact release host or a
production cloud workspace. It deliberately does not convert source code,
nearby CI, or an environment-gated test into live qualification evidence.

## 2026-08-18 host-parity evidence

The default `pnpm check:zsr` now qualifies the profile local desktop production
actually selects. The older low-level isolated matrix remains available with
`--isolated`; root cloud attestation continues to invoke `--cloud-worker`.

| Evidence                                          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused containment matrix                        | 92 tests passed across policy, supervisor, boundary, and OrbStack controller suites. This includes real Linux code and design actors, multiple Design roots, an existing Git index, and a shared-worker reference lifecycle.                                                                                                                                                                                                                  |
| `pnpm typecheck`                                  | Passed after the host-parity and qualification changes.                                                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm check:zsr` on Linux x64                     | Passed with `secure: true`. It proved host reads; code writes; three direct/alias Design denials; real HOME; GH/GitHub/SSH environment; `gh`; native `git -c`, add, commit, reset, push, raw errors, and pre-push hook; direct local services and ports; inverse design writes; code denial; outside-repository cache write; and canonical Git index replacement. Full admissions measured 393 ms for code and 397 ms for design in that run. |
| Retained isolated live canary on this Vercel host | Refused at the outer sandbox's bubblewrap `/proc` mount (`Operation not permitted`). This is the already-recorded host limitation, not a local host-parity failure or a cloud qualification claim.                                                                                                                                                                                                                                            |
| macOS host-parity / Keychain / Seatbelt           | Passed on the synchronized Apple-silicon Mac with `secure: true`. The code actor retained the real HOME, GH/GitHub/SSH environment, Keychain, native Git/hooks/push/errors, direct services, and requested ports while Seatbelt denied every physical and aliased Design root. The inverse design actor retained native Git index replacement while repository code stayed read-only. Full admissions measured 756 ms for code and 202 ms for design. |
| Focused macOS containment matrix                  | 87 tests passed and 10 Linux-only projection tests skipped across policy, supervisor, boundary, process-domain, and OrbStack-controller suites.                                                                                                                                                                                                                                                                                               |
| macOS container and engine lifecycle              | `pnpm check:zsr:orbstack` passed normal and privileged containers, filesystem projection, Design denial, unleased-port denial, and proven teardown. `pnpm smoke:engine` sustained health plus create/archive/restore through the packaged arm64 engine.                                                                                                                                                                                        |

The local canary uses packaged supervisor assets and the real
`ZsrExecutionBoundary`, not a hand-written approximation. It initializes an
ordinary repository and bare remote, installs a real pre-push hook, protects two
physical Design directories plus a symlink alias, and runs both actor profiles.
For Design mode it starts with an existing index, because Git atomically
replaces that file; this caught and fixed a file-bind implementation that could
create a new index but failed to replace an existing one.

### 2026-08-18 post-audit gate additions

Four checks were added after the host-parity audit, each because the existing
matrix could pass while the property it names was broken:

| Check                             | What it proves, and why the old matrix missed it                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host-tls-trust-environment`      | Every one of the 15 TLS-trust variables the supervisor rewrites for the isolated profile arrives in a parity session exactly as the host set it — a configured bundle byte-identical, an unset name still unset. The audit found all 15 being exported as the literal string `undefined`, which breaks `git clone https://…`, `curl`, and `pip install` inside a session that otherwise looks normal. The old `host-network-environment` check covered proxy variables only, and the canary compared just four env names. |
| `design-marker-write-denial`      | A Design folder's `.zeros-canvas.json` marker is unwritable, because it lives inside protected Design territory. It is one half of the recognition split; the other half is the row below. |
| `repo-settings-host-parity-write` | `.zeros/settings.toml` — which carries the `[design] directory` pointer — IS writable under parity. It was denied first, and the measured cost was that any fenced `git checkout`/`pull`/`reset --hard` needing to rewrite that committed file failed on it while the code paths still applied. De-registration is covered in engine state (sticky recognition) instead, so this check exists to stop the pointer being re-denied by accident. |
| `design-git-restore-denial`       | Git ITSELF is refused when it tries to write a protected path, with the Design bytes intact afterwards. Both pre-existing fence tests ran `git reset --hard` against a Design tree that already matched the restore target, so Git never attempted the write and the kernel deny was never exercised through Git. The fixture now diverges a tracked Design file through history and restores from an exact commit.                                                                                                        |

The canary itself gained the matching in-fence assertion
(`environmentUninjected`), so a rewritten TLS-trust variable now fails admission
rather than being discovered later inside a session. Reproduced both ways on this
Linux x64 host: `secure: true` with 31 checks (30 pass, 1 macOS-only
not-required) after the fix, and admission refused with `host-parity injected
TLS-trust variables the engine did not request` when the defect was deliberately
reintroduced.

The two recognition rows are a maintainer decision, not an oversight. Denying the
`.zeros` pointer was implemented, measured, and then reverted: it made a fenced
`git checkout`/`pull`/`reset --hard` fail with `unable to unlink old
'.zeros/settings.toml': Read-only file system` on a file repositories routinely
commit, and engine-side sticky recognition already covers de-registration without
touching the filesystem. The residual it accepts is a Design folder that arrives
mid-session (an agent runs `git pull`) and is de-registered before any admission
has recorded it.

The historical private-HOME/shadow-Git evidence below now describes the
retained isolated/cloud profile unless a paragraph explicitly says local host
parity. In particular, older macOS rows that prove Keychain denial, private Git,
port interposition, or brokered services do not describe the current local
desktop profile.

## Verdict

- ZSR is implemented for Claude, Codex, Cursor, OpenCode-compatible/future CLI
  agents, repository tasks, Git, local services, browser previews, and private
  container workflows through one `ExecutionBoundary` contract.
- On the qualified Apple-silicon Mac, ordinary code-workspace behavior remains
  available while active and prospective Design territory is read-only to the
  entire untrusted process tree. The final synchronized source passed the live
  Seatbelt, browser-preview, private OrbStack, engine-lifecycle, and signed
  packaged-app matrices.
- Linux deterministic tests pass in this workspace. Secure Linux runtime
  qualification is not claimed from the Vercel sandbox because its outer
  sandbox denies the bubblewrap `/proc` mount and root UID map. ZSR refuses
  admission there instead of silently weakening isolation.
- The control plane's database integrations are no longer taken on trust: a
  real PostgreSQL 16 was provisioned on the audit host and the whole suite,
  including the 79 integrations that previously self-skipped, executed and
  passed.
- Session admission is now bounded by what changed rather than by how much
  history a workspace has accumulated. See **Admission cost** below.
- This is not yet a universal release claim. macOS x64, Linux arm64, and an
  actual production cloud-worker image remain unqualified.
- No new production cloud-workspace implementation was added during this
  closure. The existing control-plane and validation foundation is retained;
  its live production work is listed below.

## Executed evidence

### Repository and Linux-hosted gates

| Gate                                                                                  | Result                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                      | Passed for the application, Electron, Design Core, Design Web, protocol, and marketing packages.                                                                                                                                                                                                                                        |
| `pnpm lint`                                                                           | Passed.                                                                                                                                                                                                                                                                                                                                 |
| `pnpm check:ui`                                                                       | Passed.                                                                                                                                                                                                                                                                                                                                 |
| `pnpm check:secrets`                                                                  | Passed across the final working-tree set of 2,952 tracked files.                                                                                                                                                                                                                                                                        |
| `pnpm check:design-containment`                                                       | 20 files passed; 429 tests passed and 3 platform-gated tests skipped.                                                                                                                                                                                                                                                                   |
| `pnpm test:git`                                                                       | 596 files passed; 6,609 tests passed and 3 platform-gated tests skipped.                                                                                                                                                                                                                                                                |
| Focused ZSR containment, engine-startup, chat-title, and admission regressions        | The engine-agent suite passed, including the provider-state change-detection, scoped-history, and storage-sweep cases added for this closure.                                                                                                                                                                                           |
| `pnpm test:ui-smoke`                                                                  | Passed the complete real-browser smoke with no uncaught page errors, including Design authoring, selection, gestures, text editing, and Escape rollback.                                                                                                                                                                                |
| Adjacent Design suites                                                                | 3 files and 65 tests passed after the final Design workspace edit.                                                                                                                                                                                                                                                                      |
| `pnpm build:ui`                                                                       | Passed; 3,430 modules transformed. Only the documented chunk-size and mixed dynamic/static import warnings remain.                                                                                                                                                                                                                      |
| `pnpm check:preload`                                                                  | Passed for 63 exposed commands.                                                                                                                                                                                                                                                                                                         |
| `pnpm check:electron-hardening`                                                       | Passed.                                                                                                                                                                                                                                                                                                                                 |
| `pnpm check:runtime-pins`                                                             | Passed; the exact runtime pins and manifests agree. One Claude SDK-wrapper compatibility warning is recorded below.                                                                                                                                                                                                                     |
| `pnpm check:packaging-paths`                                                          | Passed, including all 19 packaged `extraResources` entries and native/runtime artifacts.                                                                                                                                                                                                                                                |
| `pnpm check:protocol`                                                                 | Passed.                                                                                                                                                                                                                                                                                                                                 |
| `pnpm check:actions`                                                                  | Passed `actionlint`. The workflows have not been dispatched from this branch.                                                                                                                                                                                                                                                           |
| `pnpm check:migrations`                                                               | Passed for 33 desktop migrations.                                                                                                                                                                                                                                                                                                       |
| `pnpm check:control-plane-migrations`                                                 | Passed for 10 retained control-plane migrations.                                                                                                                                                                                                                                                                                        |
| `pnpm check:licenses`                                                                 | Passed; 599 package/version records and 270 license documents were reconciled.                                                                                                                                                                                                                                                          |
| `pnpm check:codex-pin`                                                                | Passed for Codex `0.146.0` and 211 classified protocol methods.                                                                                                                                                                                                                                                                         |
| `pnpm check:vite-env`, `pnpm check:cursor-asar`, `pnpm check:deep-link-schemes`       | Passed.                                                                                                                                                                                                                                                                                                                                 |
| `pnpm check:audit`                                                                    | Passed under the repository's reviewed allowlist; the 12 accepted findings are recorded below.                                                                                                                                                                                                                                          |
| `pnpm check:web-deploy`                                                               | Completed with deployment status unverified because authenticated GitHub API access and `CLOUDFLARE_ACCOUNT_ID` were absent; this is not recorded as live deployment evidence.                                                                                                                                                          |
| `pnpm agents:smoke:offline`                                                           | Passed the pinned Claude, Codex, Cursor Node, and Cursor Electron startup/handshake paths without sending a model turn.                                                                                                                                                                                                                 |
| `pnpm test:adapters`                                                                  | Passed the OpenCode-compatible adapter fixture.                                                                                                                                                                                                                                                                                         |
| `pnpm test:control-plane`                                                             | Passed 15 files and 175 tests against a real PostgreSQL 16 provisioned on this host. The 79 previously skipped database integrations executed, including the tenant-isolation/RLS migration path; CI's skip-guard re-run reported 20 migration tests passed. The sandbox-provider side of the reconciler still drives a `FakeProvider`. |
| `pnpm --dir apps/control-plane typecheck`, `pnpm --dir apps/control-plane audit:prod` | Passed; no known production vulnerabilities in the control plane's own lockfile.                                                                                                                                                                                                                                                        |

`pnpm check:zsr` was also executed on this Linux host. The exact pin
(`@anthropic-ai/sandbox-runtime@0.0.73`), license, native attack helper, and
ambient-capability repair passed; the live canary failed with
`bwrap: Can't mount proc on /newroot/proc: Operation not permitted`. The host's
exact limits were measured rather than assumed: user namespaces are available
(`unshare -Ur` succeeds, `max_user_namespaces` is 66560), but mounting `proc`
inside a private mount namespace is denied, and only `cpu` is delegated through
`cgroup.subtree_control` — the memory and PID controllers ZSR requires are not.
That is expected fail-closed behavior, not a qualified Linux backend.

### macOS arm64 live gates

The attached Mac ran Darwin 25.3.0 on arm64 with the final synchronized source.

| Gate                                      | Result                                                                                                                                                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:zsr`                          | Passed with `secure: true`. The exact `srt` pin/patch, Seatbelt policy, process domain, native attack helper, port interposer, private Git, code writes, Design denials, descendants, services, reverse ports, dynamic ports, resource limits, and both macOS security-service denials passed.       |
| `pnpm check:zsr-preview-browser`          | Passed a real Chrome iframe flow with cookies, assets, WebSocket, HMR, capability redaction, and replay denial.                                                                                                                                                                                      |
| `pnpm check:zsr:orbstack`                 | Passed on OrbStack 2.2.1 for normal and privileged private containers, code projection, Design denial, unleased-port denial, and verified teardown. Cold admission was approximately 65.4 seconds; traffic used the exact-machine signed CLI relay rather than the unstable guest-IP route.          |
| `pnpm build:sidecar && pnpm smoke:engine` | Passed with a fresh arm64 engine binary, including create, archive, and restore lifecycle.                                                                                                                                                                                                           |
| `pnpm claude:smoke`                       | Passed the pinned CLI authentication handshake. The expected HTTP 401 was classified as authentication failure; no model inference ran and token cost remained `$0 / 0`.                                                                                                                             |
| Signed packaged-app smoke                 | The synchronized source produced a Developer-ID-signed directory app. Deep/strict verification, packaged PTY, required ZSR/provider resources, exact relay/supervisor script hashes, compiled startup/title fix markers, staged Claude/Codex versions, and direct packaged-engine health all passed. |
| Live Zeros Dev process/admission check    | Exactly one Electron process was in GUI mode. The expected Cursor host used the same app binary with `ELECTRON_RUN_AS_NODE=1`; it was not a second GUI/Dock app. The engine stayed healthy on port 25133 and completed a real Claude `AGENT_PROMPT` through the staged CLI after source HMR settled. |

The package was not notarized because this was a directory qualification build,
not a distribution release. Notarization and installer verification remain
release evidence.

## Local parity and isolation coverage

| Surface                       | Qualified local behavior                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider runtimes             | Claude, Codex, and Cursor enter through the same gateway and boundary; OpenCode exercises the whole-runtime CLI contract. Provider-native tools do not bypass ZSR.                                                                                                                                              |
| Code territory                | Read, search, create, edit, delete, rename, build, test, package-manager, compiler, watcher, PTY, and task paths remain writable/usable according to normal workspace authority.                                                                                                                                |
| Design territory              | Active and prospective Design roots are readable but kernel-denied for write, truncate, create, unlink, rename, chmod, symlink, hardlink, `openat`, mmap, rename exchange, and directory creation. Descendants inherit the same denial.                                                                         |
| Git                           | Each admitted owner receives private Git metadata with safe status/diff/add/commit/branch/fetch/pull/push/merge/rebase/stash/conflict/LFS/submodule/signing/worktree paths and validated promotion back to canonical Git. Design-changing results cannot be smuggled through Git objects or metadata.           |
| Provider state and extensions | Private provider state, repository instructions, skills/plugins, hooks, subagents, local MCP, OAuth/open-URL, and credential flows stay within the same boundary or a capability-scoped trusted broker.                                                                                                         |
| Local services and ports      | Explicit TCP, reverse-port, dynamic dev-port, common local-service, and Unix-socket capabilities work; unleased engine/control and cross-session access is denied.                                                                                                                                              |
| Browser preview               | Cookies, assets, WebSocket/HMR, navigation, and authorized iframe behavior work through scoped capabilities without exposing bridge credentials.                                                                                                                                                                |
| Container workflows           | Qualified macOS arm64 sessions use a private rootless OrbStack/Podman path for normal and privileged workflows. ZSR never forwards a host Docker/Podman daemon socket. An unavailable safe backend produces a visible `container-workflows-unavailable` restriction while ordinary code work remains available. |
| Tasks and teardown            | Repository-controlled setup/run/test/build/preview processes are contained. PATH-only shell discovery cannot provision local-service/container authority. Capability revocation, descendant termination, proof retention, restart recovery, bounded engine startup, and aggregate shutdown cleanup are covered. |
| Packaged bytes                | The signed app contains and can execute the same engine, supervisor, network bridge, container worker/host, OrbStack cloud-init, process-domain helper, port interposer, and PTY host used by qualification.                                                                                                    |

Human-authority terminals remain intentionally visible as outside the agent
containment guarantee. They are not represented as a ZSR escape or as an
agent-equivalent protected terminal.

## Admission cost

Session admission used to re-copy and re-hash the whole durable provider
projection — including every transcript a workspace had ever accumulated — on
every session, so its cost grew with history rather than with change. Two
changes bound it. Neither adds a source of truth: the same three-way merge
still decides what a session may keep.

- Per-conversation history stores stay durable but are projected only for the
  conversation a session actually resumes. A provider whose history cannot be
  addressed by its opaque resume id keeps the whole store projected.
- Content digests are remembered against exact filesystem identity
  (device, inode, size, mtime, ctime, mode) in a manifest beside the durable
  state, and every file copied from an already-proven source records the
  identity it was written to, so the private HOME's merge baseline is derived
  from work already done. A miss recomputes the real digest; ctime is part of
  the identity because a contained child can move mtime backwards but cannot
  move ctime backwards, so modified content can never present the identity
  recorded for its previous bytes.

Measured on this host against a synthetic workspace holding 6,000 durable
transcripts (~141 MiB), comparing a provider whose history is projected in full
against the scoped/change-detected path:

| Path                      | Admit (cold) | Admit (warm) | Promote |
| ------------------------- | ------------ | ------------ | ------- |
| Whole history projected   | 2,429 ms     | 1,497 ms     | 384 ms  |
| Scoped history + manifest | 1,186 ms     | 193 ms       | 201 ms  |

Four defects found in live logs from the qualified Mac were fixed alongside
this, because each one either cost the user a whole re-admission or lost work:

- A recursive directory digest was used as a three-way merge base, so one file
  a human dropped into a shared provider directory reported a conflict,
  archived and reset the private subtree under it, and could drop the
  session's own writes at promotion. This is the most likely explanation for
  the observed `thread/resume found no rollout … auto-starting a fresh thread`
  — the durable rollout store was being reset out from under the session.
- The macOS process-domain helper and the admission canary both resolved on
  process exit rather than stream close, so their JSON verdict could be read
  truncated and a healthy boundary refused with `returned invalid JSON`.
- A prompt addressed to an execution id from a previous engine process reached
  the adapter instead of being classified. Claude and Codex rebuild quietly;
  Cursor refuses with an unrecoverable error, so the message was lost.
- The prompt-readiness barrier released a waiting prompt when the adapter
  resolved, which is before the gateway registers the execution's route — the
  same lost-prompt window, at session start rather than after a restart.

Durable storage is bounded on the same path. Engine boot now prunes conflict
and recovery archives by age and count, and reclaims a projection holding
nothing but a rebuildable copy of host state — the shape a provider probe left
behind before probes were pinned to one stable scope — once it has also gone
unused. A projection holding any private state, tombstone, host base,
credential marker, or archive is deliberately kept, so the reclamation is
provably lossless rather than merely old-enough.

Those are Linux numbers for one stage. The macOS measurement has since been
taken, and it does not extrapolate from them: 18 real admissions recorded by
the engine's own per-stage report on the qualified Apple-silicon Mac
(Darwin 26.3.1, arm64) ran to a **median 6,592 ms**, minimum 2,417 ms, maximum
16,069 ms. Totals across those 18 admissions:

| Stage            | Median   | Min    | Max      | Share |
| ---------------- | -------- | ------ | -------- | ----- |
| `provider-state` | 2,480 ms | 2 ms   | 8,486 ms | 38%   |
| `private-git`    | 2,645 ms | 1 ms   | 7,912 ms | 35%   |
| `canary`         | 1,952 ms | 549 ms | 2,684 ms | 27%   |
| `policy`         | 39 ms    | 2 ms   | 1,480 ms | ~6%   |
| `discover`       | 122 ms   | 14 ms  | 868 ms   | ~3%   |
| `process-domain` | 6 ms     | 3 ms   | 22 ms    | ~0%   |

Read the shares as a share of summed stage time, not of the median. Three
facts matter. The synthetic bench covered `provider-state` alone, so it
described at most 38% of what a session actually waits for. `canary` never
falls below 549 ms because it spawns a real contained process every time, and
no amount of overlay caching touches it. The burst was 18 admissions inside
four minutes, so lock contention inflates the tail; the one isolated admission
in the sample was 2,417 ms, which is the fairer solo figure.

`provider-state` and `private-git` are now prepared concurrently. They touch
disjoint subtrees of the private HOME — the overlay only ever snapshots the
provider-managed relative paths, while shadow Git stays under
`<home>/git-repositories` — so overlapping them turns a sum into a max and is
expected to remove roughly 2.5 s from the median. That expectation is
arithmetic from the table above, not a measurement: it still needs a
confirming run on the Mac.

## Exact unqualified and deferred items

These are the remaining release qualifications; none is reported as passed:

1. **macOS x64:** run the complete Seatbelt/process-domain, browser-preview,
   private-container, engine, signed-package, and teardown matrix on Intel.
   The harness exists and is wired: `preflight.yml`'s `zsr-macos-intel` job
   runs on `macos-15-intel`, asserts `uname -m` is `x86_64`, then runs
   `check:runtime-pins`, `agents:smoke:offline`, `check:zsr`, `build:sidecar`,
   `smoke:engine`, and `check:design-containment`. It needs a pull request, not
   more code.
2. **Linux arm64:** same shape — `preflight.yml`'s `zsr-linux-arm64` job runs
   on `ubuntu-24.04-arm`, asserts `aarch64`, installs bubblewrap and socat, and
   runs `check:runtime-pins`, `agents:smoke:offline`, and `check:zsr`. Also
   waiting only on a pull request.
3. **Linux x64 secure backend:** rerun outside the current Vercel outer
   sandbox. The exact blockers were measured on this host (above): `proc`
   cannot be mounted in a private mount namespace, and memory/PID controllers
   are not delegated. No configuration of this host removes either, so it can
   only ever prove refusal.
4. **Credentialed provider differential:** compare normal and contained live
   turns for Claude, Codex, and Cursor on every graduated backend. A successful
   user-driven contained Claude turn was observed, but no controlled
   normal-vs-contained differential was run. The cloud form of this harness
   exists (`scripts/cloud-workspace-validation/agent-smoke.ts`, run by the
   manual `zsr-cloud-qualification.yml`); the local macOS form does not, and
   both need live credentials the audit host does not hold.
5. **Production cloud worker:** build and attest an immutable provider image,
   then execute the same attack/parity matrix with real mount, namespace,
   seccomp, cgroup, identity, network, and cleanup evidence. No production cloud
   workspace was available for this audit.
6. **Live sandbox-provider integrations:** the database half of this item is
   now closed — all 79 previously skipped integrations ran against a real
   PostgreSQL 16 on this host and passed, and the same suite runs on every pull
   request behind `preflight.yml`'s `control-plane` job and its skip-guard.
   What remains is the provider half: `reconciler.integration.test.ts` drives a
   `FakeProvider`, so create/bind/observe/delete against a real Daytona account
   is still unqualified.
7. **Distribution release:** notarize the macOS artifact and verify the actual
   installer/update artifacts on each release architecture.
8. **Web deployment:** authenticated GitHub/Cloudflare deployment and live
   verification were not run. This is outside local ZSR behavior but remains a
   release-environment dependency.
9. **Design agent:** add and qualify a real Design-authorized consumer before
   graduating the Design-agent side of the architecture. No protected
   foundation change is implied.

Items 1 and 2 are gated only on opening a pull request; their jobs already
exist and run unattended. Items 3, 4, 5, the provider half of 6, 7, and 8 are
gated on hardware, a paid account, or signing/deployment credentials that no
amount of repository work removes. Item 9 is product work behind an explicit
maintainer approval.

## Production cloud qualification to execute later

The existing cloud control-plane and validation source is a retained
foundation, not a production-qualified cloud workspace. When an actual cloud
workspace exists, complete this sequence without weakening the uniform ZSR
contract:

1. Freeze an immutable application commit, worker image digest, architecture,
   ZSR patch digest, helper hashes, and admission schema.
2. Provision the real worker with root-controlled mounts and supervisor,
   delegated memory/PID/CPU cgroups, private rootless container support, and no
   host daemon socket or ambient engine credential.
3. Bind organization, user, workspace, lease, session, image, and commit
   identities cryptographically; reject stale/replayed grants and any
   attestation mismatch.
4. Run the full native Design attack corpus and the normal-vs-contained
   differential for Claude, Codex, Cursor, OpenCode-compatible CLIs, Git,
   tasks, MCP, browsers, previews, local services, and private containers.
5. Prove bridge/PTY reconnect, cancellation, bounded queues, egress policy,
   zero-drop soak, SSH forwarding, credential refresh, and failure recovery.
6. Exercise suspend/resume/archive/delete, crash recovery, stale-resource
   cleanup, snapshot cleanup, and provider reconciliation; verify sandbox,
   credential, port, container, and snapshot deletion from independent
   inventory evidence.
7. Run the retained tenant-isolation migration and all provider/database tests
   against production-equivalent services, then complete the setup worker and
   user-facing lifecycle only under an approved production architecture.
8. Persist sanitized qualification artifacts keyed to the exact commit/image
   and graduate a backend only when every mandatory gate is green.

Until that sequence is complete, cloud support must remain explicitly
unqualified. Local macOS arm64 evidence must not be used as a substitute.

## Accepted warnings and maintenance items

- The bundled Claude SDK wrapper `0.3.231` is newer than the CLI manifest's
  newest recorded tested wrapper `0.3.227`. Exact CLI/runtime pins agree, but
  the compatibility warning should be removed by the next audited manifest
  update.
- The production dependency audit accepts 12 findings (2 low, 7 moderate,
  3 high) in `@cursor/sdk`'s `@connectrpc/connect-node` to `undici@5.29.0`
  path. The affected compatibility branch activates below Node 18; shipped and
  validation environments use Node 22/24. Keep this explicit allowlist under
  pin review.
- The UI build reports known chunk-size and mixed dynamic/static import
  warnings. They did not block the tested behavior but remain performance
  maintenance work.
- The macOS package reports the existing package-author and redundant rebuild
  dependency warnings. Signing and runtime verification passed; release
  packaging can clean these independently.

## Protected-document and staging record

`docs/autonomous-code-design-foundation.md` was not edited during ZSR closure.
Any future edit still requires explicit per-edit maintainer approval. The active
engine-owned Design directory was absent in this checkout and is excluded from
generic Git staging in all cases.
