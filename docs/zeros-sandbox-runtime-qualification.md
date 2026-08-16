# Zeros Sandbox Runtime qualification ledger

**Evidence date:** 2026-08-16 UTC

**Scope:** local implementation closure; release-wide qualification remains
open.

This ledger records what was actually executed for the uniform Zeros Sandbox
Runtime (ZSR), what passed, and what still needs an exact release host or a
production cloud workspace. It deliberately does not convert source code,
nearby CI, or an environment-gated test into live qualification evidence.

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
- This is not yet a universal release claim. macOS x64, Linux arm64, and an
  actual production cloud-worker image remain unqualified.
- No new production cloud-workspace implementation was added during this
  closure. The existing control-plane and validation foundation is retained;
  its live production work is listed below.

## Executed evidence

### Repository and Linux-hosted gates

| Gate                                                                            | Result                                                                                                                                                   |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                                | Passed for the application, Electron, Design Core, Design Web, protocol, and marketing packages.                                                         |
| `pnpm lint`                                                                     | Passed.                                                                                                                                                  |
| `pnpm check:ui`                                                                 | Passed.                                                                                                                                                  |
| `pnpm check:secrets`                                                            | Passed across the final working-tree set of 2,952 tracked files.                                                                                         |
| `pnpm check:design-containment`                                                 | 20 files passed; 424 tests passed and 3 platform-gated tests skipped.                                                                                    |
| `pnpm test:git`                                                                 | 588 files passed; 6,481 tests passed and 3 platform-gated tests skipped.                                                                                 |
| Focused ZSR containment, engine-startup, chat-title, and admission regressions  | 27 files and 243 tests passed without a failure.                                                                                                        |
| `pnpm test:ui-smoke`                                                            | Passed the complete real-browser smoke with no uncaught page errors, including Design authoring, selection, gestures, text editing, and Escape rollback. |
| Adjacent Design suites                                                          | 3 files and 65 tests passed after the final Design workspace edit.                                                                                       |
| `pnpm build:ui`                                                                 | Passed; 3,430 modules transformed. Only the documented chunk-size and mixed dynamic/static import warnings remain.                                       |
| `pnpm check:preload`                                                            | Passed for 63 exposed commands.                                                                                                                          |
| `pnpm check:electron-hardening`                                                 | Passed.                                                                                                                                                  |
| `pnpm check:runtime-pins`                                                       | Passed; the exact runtime pins and manifests agree. One Claude SDK-wrapper compatibility warning is recorded below.                                      |
| `pnpm check:packaging-paths`                                                    | Passed, including all 19 packaged `extraResources` entries and native/runtime artifacts.                                                                 |
| `pnpm check:protocol`                                                           | Passed.                                                                                                                                                  |
| `pnpm check:actions`                                                            | Passed `actionlint`. The workflows have not been dispatched from this branch.                                                                            |
| `pnpm check:migrations`                                                         | Passed for 33 desktop migrations.                                                                                                                        |
| `pnpm check:control-plane-migrations`                                           | Passed for 10 retained control-plane migrations.                                                                                                         |
| `pnpm check:licenses`                                                           | Passed; 599 package/version records and 270 license documents were reconciled.                                                                           |
| `pnpm check:codex-pin`                                                          | Passed for Codex `0.146.0` and 211 classified protocol methods.                                                                                          |
| `pnpm check:vite-env`, `pnpm check:cursor-asar`, `pnpm check:deep-link-schemes` | Passed.                                                                                                                                                  |
| `pnpm check:audit`                                                              | Passed under the repository's reviewed allowlist; the 12 accepted findings are recorded below.                                                           |
| `pnpm check:web-deploy`                                                         | Completed with deployment status unverified because authenticated GitHub API access and `CLOUDFLARE_ACCOUNT_ID` were absent; this is not recorded as live deployment evidence. |
| `pnpm agents:smoke:offline`                                                     | Passed the pinned Claude, Codex, Cursor Node, and Cursor Electron startup/handshake paths without sending a model turn.                                  |
| `pnpm test:adapters`                                                            | Passed the OpenCode-compatible adapter fixture.                                                                                                          |
| `pnpm test:control-plane`                                                       | The retained cloud foundation passed 96 tests; 79 provider/database integration tests were skipped because their external environment was absent.        |
| `pnpm --dir apps/control-plane typecheck`                                       | Passed.                                                                                                                                                  |

`pnpm check:zsr` was also executed on this Linux host. Pin, license, policy,
and helper validation passed, but live bubblewrap admission failed at the
required `/proc` mount because of the outer Vercel sandbox. That is expected
fail-closed behavior, not a qualified Linux backend.

### macOS arm64 live gates

The attached Mac ran Darwin 25.3.0 on arm64 with the final synchronized source.

| Gate                                      | Result                                                                                                                                                                                                                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check:zsr`                          | Passed with `secure: true`. The exact `srt` pin/patch, Seatbelt policy, process domain, native attack helper, port interposer, private Git, code writes, Design denials, descendants, services, reverse ports, dynamic ports, resource limits, and both macOS security-service denials passed. |
| `pnpm check:zsr-preview-browser`          | Passed a real Chrome iframe flow with cookies, assets, WebSocket, HMR, capability redaction, and replay denial.                                                                                                                                                                                |
| `pnpm check:zsr:orbstack`                 | Passed on OrbStack 2.2.1 for normal and privileged private containers, code projection, Design denial, unleased-port denial, and verified teardown. Cold admission was approximately 65.4 seconds; traffic used the exact-machine signed CLI relay rather than the unstable guest-IP route. |
| `pnpm build:sidecar && pnpm smoke:engine` | Passed with a fresh arm64 engine binary, including create, archive, and restore lifecycle.                                                                                                                                                                                                     |
| `pnpm claude:smoke`                       | Passed the pinned CLI authentication handshake. The expected HTTP 401 was classified as authentication failure; no model inference ran and token cost remained `$0 / 0`.                                                                                                                       |
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

## Exact unqualified and deferred items

These are the remaining release qualifications; none is reported as passed:

1. **macOS x64:** run the complete Seatbelt/process-domain, browser-preview,
   private-container, engine, signed-package, and teardown matrix on Intel.
2. **Linux arm64:** run the complete bubblewrap/native-helper, Git, service,
   browser-preview, cgroup, engine, packaged-runtime, and teardown matrix in the
   release CI/image. No PR was opened, so the PR-only preflight jobs did not run.
3. **Linux x64 secure backend:** rerun outside the current Vercel outer sandbox
   with the required user namespace, `/proc` mount, and memory/PID controller
   delegation. The current host proves refusal, not secure admission.
4. **Credentialed provider differential:** compare normal and contained live
   turns for Claude, Codex, and Cursor on every graduated backend. A successful
   user-driven contained Claude turn was observed, but no controlled
   normal-vs-contained differential was run.
5. **Production cloud worker:** build and attest an immutable provider image,
   then execute the same attack/parity matrix with real mount, namespace,
   seccomp, cgroup, identity, network, and cleanup evidence. No production cloud
   workspace was available for this audit.
6. **Cloud integrations:** run the 79 retained provider/database integration
   tests against their real services and database. Passing unit tests do not
   qualify those integrations.
7. **Distribution release:** notarize the macOS artifact and verify the actual
   installer/update artifacts on each release architecture.
8. **Web deployment:** authenticated GitHub/Cloudflare deployment and live
   verification were not run. This is outside local ZSR behavior but remains a
   release-environment dependency.
9. **Design agent:** add and qualify a real Design-authorized consumer before
   graduating the Design-agent side of the architecture. No protected
   foundation change is implied.

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
