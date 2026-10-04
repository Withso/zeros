# Phase B: runtime bundles and the `/zeros` facade

Design only, 2026-10-04. No tracked files, provider resources, credentials, or deployment settings were changed. All live checks below are proposed acceptance work.

## 1. Executive decisions

1. **Accept admission as the internal trust root.** Protected CI registers immutable digests; base-owned code verifies delivery before executing it. Signatures and key rotation are deferred explicitly; hashes alone do not authenticate a compromised publisher or control plane.
2. **Accept one archive, refine to gzip.** Ship one deterministic `.tar.gz`, a canonical manifest, ordinary copied files, and validated internal package symlinks. Keep current, previous, and referenced versions; fail on insufficient space; no automatic GC or hard-link deduplication.
3. **Accept Alpha R2.** Use a separate artifact adapter and `runtime/v1/` namespace. The control plane issues exact-key, expiring PUT capabilities to CI and GET capabilities to the installer. CI and VMs need no general bucket keys.
4. **Accept newest qualified compatible selection.** Derive the effective channel head from publication order and qualifications, then persist its identity with generation creation. Wake and recovery reuse that pin. The existing explicit v4 `upgrade` transition selects a later runtime while retaining the base.
5. **Accept the v4 base, refine its implementation.** Add a small Bash/Python bootstrap, real systemd services, and an explicitly delegated cgroup subtree. Bootstrap must work with no Node or runtime installed and without online admission during boot.
6. **Accept split attestation, retain isolation checks.** A base compatibility identity plus installed manifest replaces v3 source-tree/native-inventory runtime identity. Preserve namespace, ownership, AppArmor, seccomp, resource, workload, and descendant-retirement gates. Separate v4 database fields are mandatory because existing checks allow only v3.
7. **Accept coexistence.** A staff-only Alpha switch selects v4 for new workspaces; historical image/source fields and v1–v3 behavior retain their meanings. Missing runtime pins mean legacy only, never permission to downgrade a v4 base.
8. **Replace legacy qualification orchestration.** A small Alpha-only runner uses a designated staff user's normal authenticated workspace APIs, a narrowly bound candidate exception, real turns, and ordinary workspace deletion. New DB run/evidence rows authorize automatic qualification. Reuse pure test scenarios only; no legacy worker admission ledger, owner-recovery chain, encrypted R2 journal, or repair of the v3 lane.
9. **Accept release separation.** A bounded Linux build/upload/register job may gate Alpha publication; Boat work runs in a separate post-release workflow and holds no release/hosted mutation lock. The old worker lane remains available and disabled.
10. **Refine update semantics.** Phase B uses the existing drain/checkpoint/new-generation mechanism, normally allocating another VM from the same base image. It does not add an in-place generation-pin mutation or silently upgrade on wake.

The Phase A hash fix and release decoupling are prerequisites. Phase C owns first-build-required UX, privileged organization builds, protected-file checks, stopped templates, and provider forks. Phase B keeps existing allowances and accounting. This follows the current scope in `.context/research/FINAL-02-zeros-cloud-v2-plan.md:414–437`; this task explicitly relaxes that plan's signing requirement for internal Alpha.

The latest steering supersedes the earlier canary-reuse proposal: Alpha has no qualification or Cloud Computer/image/build rows; the old worker lane had zero successes in 18 executions, and the test Boat account has no active sandbox (`.context/impl/steer-db-1.md:1–20`; `.context/impl/diag-alpha.md:7–21,125–150`). First qualification must work from that empty state. No v3 approval is a prerequisite, and no Alpha data migration is needed. Every new installer, attester, publication and canary failure has the closed diagnostics specified below.

## 2. Identity, authority, and runtime closure

Evidence prefixes used below: `S/` = `scripts/cloud-workspace-validation/sandbox/`; `B/` = `scripts/cloud-workspace-validation/boat-image/`; `E/` = `apps/desktop/src/engine/`; `C/` = `apps/control-plane/src/cloud-workspaces/`; `P/` = `apps/control-plane/src/`; `R/` = `scripts/release/`. These are repository-relative paths, not new directories.

### Identity contract

- `baseCompatibilityId = bc1-<contractSha256>`: digest of the reviewed bootstrap/isolation compatibility contract, including protected base file digests, architecture, supported installer/manifest versions, and OS ABI requirements. `compatibility.json` is canonical input to this hash and contains neither its own ID/hash nor a hash of itself; separate base-build provenance is not part of that recursive inventory. Issue a new ID when contract inputs change; an Ubuntu version label alone cannot establish compatibility.
- Base provenance separately records exact Boat named-snapshot identity, metadata digest, builder source commit, observed OS/kernel/libc/systemd/tool versions, and measured storage. A mutable snapshot name alone is insufficient (`C/boat-provider.ts:257–284`; `C/computer-image.ts:255–282`).
- `manifestSha256`: SHA-256 of canonical UTF-8 manifest bytes; `runtimeId = r1-<manifestSha256>`. The manifest contains neither its own hash nor `runtimeId`, avoiding a circular digest. It contains source commit, lock/pin identities, Node ABI, protocols, requirements, and the inventory of every payload entry.
- `archiveSha256` and `archiveBytes`: digest and length of the final gzip bytes. They are separate from manifest identity. Registry identity fields are immutable; conflicting re-registration fails. Keep only one accepted archive descriptor per runtime ID.
- Each regular file inventory entry has relative path, type, SHA-256, size, and final mode. Directories and symlinks have explicit typed entries; a symlink records its relative target and target-byte digest/length. The manifest itself is the sole inventory exclusion and is separately hashed.
- Do not invent a v4 source/image `contractSha256` alias. V4 reports `runtimeId`, `manifestSha256`, `baseCompatibilityId`, profile, installer receipt digest, and boot/session identity. Legacy contract semantics remain unchanged.

Authenticated admission protects against damaged/transplanted archives, substitution by storage or the network, a wrong generation pin, and writable-checkout path substitution. It assumes the reviewed base, provider host/SSH host-key response, TLS control-plane endpoint, protected CI, and registry authorization are trustworthy. It does not protect against VM root, a malicious organization administrator with root, compromised CI/control-plane authority, a hostile kernel/provider, or unavailable storage. A presigned URL is bearer material, never identity or attestation. Revocation must be checked online before fresh authority and on renewals; a cached receipt is not continuing authorization.

### Exact initial payload

Let `R=/opt/zeros-infra/r1-<digest>` and `W=R/worker`. This is a conservative production dependency closure with a retained source slice for the current qualification harnesses; Phase B does not attempt dependency trimming.

| Destination in R | Required content and evidence |
| --- | --- |
| `bin/node` | Ordinary Node 22.23.1 Linux x64 executable, its license/provenance, and recorded `process.versions.modules`. Current portable pin is `scripts/cloud-workspace-validation/Dockerfile:14`; root minimum is `package.json:7`. Do not copy Electron's Node/native ABI. |
| `bin/start-engine.sh`, `bin/cloud-engine-namespace`, `bin/cloud-process-supervisor` | Version-aware launcher; namespace C binary (0500); process-supervisor C binary (0555). Build sources remain `S/cloud-engine-namespace.c` and `E/agents/containment/cloud-process-supervisor.c` (`B/templates/build.sh:13–26`). |
| `worker/dist-engine/` | `cli.js`, `design-capture-worker.js`, and their maps from `pnpm build:engine`; cloud capability baked true. CJS output externalizes SQLite, PTY, Playwright, postcss, chokidar, ws, tinyglobby and Octokit (`tsup.config.ts:15–59`). A CLI-only archive is incomplete. |
| `worker/node_modules/` | Full root production dependency graph from the frozen Linux install, all installed Linux optional/peer dependencies, plus locked `tsx` and `typescript` and their transitive dependencies for qualification/LSP. Preserve the pnpm virtual-store/package topology and internal relative links. No install on the VM. |
| Native provider packages | Claude SDK 0.3.288 and its Linux native sibling; Codex wrapper 0.160.0 and `@openai/codex-linux-x64` native package; Cursor SDK 1.0.35 and Linux native package. Preserve vendor binaries, sibling resolution, resources and licenses. No extra standalone Cursor CLI (`package.json:127–143`; `E/agents/adapters/codex/binary-resolver.ts:120–158`). |
| Other native/runtime dependencies | Rebuild and load `better-sqlite3` and `node-pty` for the bundled Node. Include pinned SRT, ripgrep, SSH2, TypeScript language server, Pyright, and every external module reachable through the production graph (`B/templates/build.sh:15–16`; `package.json:171–213`). The control plane's separate Codex auth keeper is not part of the VM payload. |
| `worker/binaries/` | Built `zsr-supervisor.mjs` and `zsr-rg`. Retain source supervisor/helper siblings as well initially. The Linux build does not produce the macOS Git dispatcher or process-domain binary (`scripts/build-zsr-supervisor.mjs:13–65`). |
| `worker/apps/desktop/src/` | Tracked source slice, including all engine MJS/CJS helpers, `pty/pty-host.cjs`, Cursor `host/cursor-host.cjs`, cloud exec/SSH/file helpers and their imports, migrations and runtime assets. Keep source-relative paths stable. TS/renderer source in this conservative slice is inert unless referenced by a verified entrypoint. |
| `worker/packages/{protocol,design-core,design-web}/`, `worker/catalogs/` | Tracked workspace library source/assets and catalogs. These support the existing source qualification harnesses even though engine bundles force-bundle workspace libraries (`tsup.config.ts:46–51`). Workspace package links must resolve inside W. |
| `worker/scripts/cloud-workspace-validation/{sandbox,lib}/`, `worker/scripts/zsr-qualification/` | All current qualification scripts and fixtures, including native agent, capture, actor-tool, human-service and ZSR probes. `S/qualify-cloud-engine.mjs:203–283` spawns source TS via `tsx`; `S/qualify-cloud-agent.ts:11–24` imports engine and harness source. Do not accidentally leave these dependent on the CI checkout. |
| Root metadata in W | `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `tsconfig*.json`, SRT pin (within the script slice), licenses/notices, and generated dependency/provenance inventory. Codex anchors native resolution at `W/package.json`. Omit `.git`, caches, credentials, `.context`, `.env.agent`, and installer state. |
| `worker/design-browsers/` | Chromium assets selected by pinned Playwright 1.59.1, including required runtime resources and notices. Include them in this same archive. The base supplies the compatible OS libraries. Existing image code installs/preserves this cache (`Dockerfile:83`; `B/templates/install.sh:25–31`); omitting it would remove capture capability. |
| `lib/zeros/` | Copy the 19 existing helper files listed below, the version-aware runtime resolver and its imports, plus the runtime's namespace-policy requirements. Base AppArmor policy is independently protected; a runtime cannot broaden it. |
| `manifest.json` | Canonical manifest with the complete finalized inventory. No mutable receipt or deployment-specific secret is embedded. |

The 19 existing helpers are `runtime-layout.json`, `cgroup-resources.mjs`, `cloud-resource-admission.mjs`, `image-build-contract.mjs`, `cloud-runtime-profile.mjs`, `cloud-engine-cgroup.mjs`, `cloud-setup-process.mjs`, `cloud-engine-view.mjs`, `cloud-engine-launcher.mjs`, `write-image-build-metadata.mjs`, `attest-cloud-worker.mjs`, `consume-cloud-admission.mjs`, `install-cloud-preview-links.mjs`, `install-cloud-github-credential.mjs`, `cloud-github-refresh-request.mjs`, `cloud-git-askpass.mjs`, `cloud-worker-supervisor.mjs`, `ensure-cloud-worker-supervisor.mjs`, and `setup-cloud-workspace.mjs` (`B/templates/build.sh:18`). Some remain only for the legacy branch; retaining their verified bytes initially is simpler than partial removal.

Staging algorithm: build once from the exact event commit with pnpm 10.28.0 and the frozen lock; walk dependency edges from all production roots plus the two explicit harness/compiler roots; copy each required virtual-store package and workspace target into W; create internal links after ordinary file copies; reject dangling/external links and unexpected native platforms. Track visited physical package roots to terminate dependency cycles. Files are copied without preserving source hard links. Regenerate necessary `.bin` shims with relocatable in-W paths instead of retaining pnpm wrappers with CI checkout/store paths. A final inventory/readback and runtime resolution test, with the original checkout/store inaccessible, proves the chosen closure. No generic recursive symlink dereference or hand-written “SDK-only” subset.

### ABI and size

Use a digest-pinned Ubuntu 24.04 amd64 build container on GitHub Linux; copy the exact Node 22.23.1 toolchain from the already pinned Node build stage, install pnpm 10.28.0, build engine/ZSR and both C helpers, then rebuild SQLite/PTY under that Node. Do not use the cloud workspace's Amazon Linux binaries or the existing OCI publication workflow's Ubuntu 26.04 host as the compatibility assumption. Record and check Node modules ABI (expected 127, measured by the build), ELF machine, required GLIBC/GLIBCXX symbols, and dynamic library closure against the qualified base. Package Node, not the build compiler/npm installation. Linux optional dependencies must be selected by the build platform. Boat's documented default user toolchain includes Node 24 and pnpm (`.context/research/r3/boat-docs/machines.md:198–205`); it must never select the engine's ABI. Base user tools and the verified engine runtime are separate contracts.

Cached Boat docs establish Ubuntu 24.04 LTS, Linux 6.8, x86_64 and real systemd (`.context/research/r3/boat-docs/machines.md:136–137`) and Python 3 (`:205`). **Inference:** Ubuntu 24.04 normally provides glibc 2.39; neither the cached docs nor this design measured the deployed libc patch. Manual base qualification must record libc/systemd/architecture and run every native binding/provider binary before approving its compatibility ID.

R6 measured approximately 246 MB Claude native, 447 MB Codex native, 38 MB Cursor SDK/native, 27 MB SQLite, 64 MB PTY and 10 MB Playwright locally; these are package footprints, not archive sizes (`.context/research/r6-zeros-runtime-bundle-design.md:327–345`). **Planning estimate:** 0.8–1.2 GiB before browsers; allow roughly 1.2–2 GiB expanded and 0.4–1 GiB gzip including browser/source, pending an actual build. Record actual compressed/expanded bytes, file count, largest entries and verification time in every publication receipt. Reserve current + previous + a staged candidate + its archive (roughly 4–8 GiB planning allowance) in addition to workspace data. Admission uses measured free space, never this estimate as evidence.

## 3. VM layout, boot and containment

```text
/zeros -> /opt/zeros                              recreated by tmpfiles
/opt/zeros-bootstrap/                             root-owned, base protected
  boot.sh, dispatch.sh, install-runtime.sh
  bootstrap.py, compatibility.json                Python stdlib; no candidate Node needed
/etc/zeros/
  cloud-worker.json                              v4 host marker
  base-build.json                                 base provenance, no legacy hash reinterpretation
/etc/systemd/system/zeros-{boot,host}.service
/etc/tmpfiles.d/zeros.conf
/etc/apparmor.d/zeros-cloud-engine                 base-owned policy
/opt/zeros-infra/r1-<digest>/                      immutable R from section 2
/opt/zeros/                                       physical root-owned facade directory
  current -> ../zeros-infra/r1-<digest>
  previous -> ../zeros-infra/r1-<prior>            absent before first switch
  bin -> current/bin
  worker -> current/worker
  manifest.json -> current/manifest.json
  sessions/                                      root-only lifecycle diagnostics; no bearer material
  logs -> /srv/zeros/log
  state -> /srv/zeros/state
  disk-epoch                                     root-owned integer; diagnostic ordering only
/srv/zeros/runtime-installs/                      root-only intents and verified installation receipts
/srv/zeros/{files/workspace,state,home,setup,log}  existing ownership/data contracts
/run/zeros/                                      ephemeral root authority, locks and socket
  active-runtime.json, view/, engine/             fresh per-boot/session projections
```

Keep physical checkout `/srv/zeros/files/workspace` and logical engine cwd `/srv/zeros/workspace` (`S/runtime-layout.json:3–13`). Engine UID 10003, agent 10001, capture 10002 and private provider coordinator 10004 retain their roles. Native histories and SQLite remain under the existing state paths. `sessions/` is not a new authored history store. Facade state/log links do not change target permissions.

This mirrors the stable-entrypoint/versioned-payload split observed in `.context/research/FINAL-01-conductor-cloud-reference.md:21–55`; Zeros retains its own durable state and isolation contracts. Do not copy Conductor's partial hard-link reuse or mutable wrappers into the verified payload.

Tmpfiles contains `L /zeros - - - - /opt/zeros` and root-only `/run/zeros` directory creation. Refuse an unexpected real `/zeros` or malformed facade link; never replace user data opportunistically. Boat captures changes under `/etc`, `/usr`, `/opt`, `/root` and `/srv`; processes and runtime state must be recreated (`.context/research/r3/boat-docs/snapshots.md:50–70`). Installed runtime bytes can be present in snapshots. `/zeros` at filesystem root cannot be assumed to survive, hence tmpfiles.

Unit contracts (final implementation must test these exact semantics on the base):

```ini
# zeros-boot.service
[Unit]
After=systemd-tmpfiles-setup.service
Before=zeros-host.service
[Service]
Type=oneshot
User=root
UMask=0077
ExecStart=/opt/zeros-bootstrap/boot.sh
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target

# zeros-host.service
[Unit]
Requires=zeros-boot.service
After=zeros-boot.service network.target
[Service]
Type=simple
User=root
UMask=0077
ExecStart=/opt/zeros-bootstrap/dispatch.sh
Restart=on-failure
RestartSec=2
KillMode=control-group
TimeoutStopSec=20
SendSIGKILL=yes
Delegate=cpu memory pids
DelegateSubgroup=host
[Install]
WantedBy=multi-user.target
```

Require a base systemd version supporting `DelegateSubgroup` (254+); check it in base qualification. The service parent is the delegated subtree, with `host`, `setup`, and `engine-<instance>` leaves. The root dispatcher starts in `host`; the parent has no processes before enabling CPU/memory/PID controllers. Discover the service's canonical kernel cgroup path from `/proc/self/cgroup`, verify the expected systemd unit and root ownership, and pass that root through the trusted descriptor. Never accept a workload-supplied cgroup pathname. The v3 root-level regex/defaults cannot be reused unchanged (`S/cloud-engine-cgroup.mjs:18–24,159–163`).

The host leaf has bounded broker resources; setup and engine leaves retain the current finite CPU/memory/PID policy, constrained by admitted machine capacity and ancestors. Current engine caps are four CPUs, 7 GiB and 4096 PIDs with group OOM. No writable controller is delegated to engine/provider/agent UIDs. Place the native launcher in its leaf before releasing its existing launch barrier; retirement uses `cgroup.kill`, confirms `populated 0`, and refuses an unexpected nested group (`S/cloud-engine-launcher.mjs:266–350`; `S/cloud-engine-cgroup.mjs:170–214`). Service stop must prove every delegated leaf drained. Do not apply systemd hardening switches that prevent required mount/user-namespace/AppArmor operations and then weaken the attester to compensate.

`boot.sh` validates the base contract, restores links/directories, reconciles interrupted pointer publication, advances `disk-epoch` once for this boot, and initializes fresh boot identity. It never downloads, redeems an admission, or starts an engine. `dispatch.sh` invokes base Python: with no `current`, remain in an observable waiting-for-runtime state; with `current`, verify its receipt and full inventory, resolve R once, and exec R's root supervisor in idle mode. A supervisor restart creates a new random session identity even within the same kernel boot. No persisted registration/launch token is replayed.

The SSH installer is outside this service subtree so that stopping the old host cannot kill publication halfway through. After restart, the root-owned descriptor exposes the new delegated cgroup root to the verified setup helper; its untrusted checkout hooks enter the `setup` leaf through the existing blocked-child barrier, even though their trusted parent is the SSH setup process (`S/cloud-setup-process.mjs:81–100`). Publication cannot run inside a leaf it must drain. Keep the host idle until setup grants fresh engine authority.

Host code uses a root-owned, bounded `/run/zeros/active-runtime.json` descriptor containing R, IDs and cgroup root. The engine receives a read-only projected descriptor and a v4 `cloud-worker.json` with concrete toolchain paths under `/etc/zeros`. That projection is distinct from the base's host marker. Mount only the selected R read-only at its same absolute path, plus a per-launch facade view with `current` fixed to R. Coordinator/agent views receive only their existing allowed mounts; do not expose `/srv/zeros/runtime-installs`, bootstrap authority, root sockets or another actor's state through the facade.

All process launches derive `workerRoot`, `node`, helpers and PATH from this verified descriptor. Environment variables and repository settings cannot select R. The C launcher accepts only a validated runtime-ID argument from the fixed root launcher, constructs its fixed paths, and retains canonical ancestry/file/mount checks; it gains no arbitrary command/path option. V4 uses the v3 UID mapping, so profile version 4 must map explicitly to identity-map version 3, rather than pretend identical kernel maps can distinguish versions (`E/agents/containment/cloud-deployment-authority.mjs:9–18,51–63`; `S/cloud-engine-namespace.c:133`).

## 4. Base-owned installer and current Boat flow

### Transport and inputs

Retain `ZEROS_CLOUD_WORKSPACE_SETUP_B64` as the executor's internal data field and the 48 KiB encoded-input bound. The v4 fixed helper command is `/usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock /opt/zeros-bootstrap/install-runtime.sh`, with `--stdin` appended by the same pinned-SSH timeout wrapper. Its only input is base64url JSON on stdin, never shell-evaluated. The outer flock acquires the setup lock exactly once; neither the installer nor the selected setup helper reacquires it. The shell rejects extra arguments, sets umask 077, clears loader/shell/Python environment, and execs `/usr/bin/python3 -I /opt/zeros-bootstrap/bootstrap.py install --stdin` with an explicit minimal environment. Python stdlib handles HTTPS, JSON, hashing, gzip and safe tar parsing; no new npm/Python dependency and no unverified candidate program parses admission. Do not print stdin or enable shell tracing; the final result/diagnostic is the only bounded output.

V2 input contains the existing workspace/org/generation/setup-run/fence, one-use admission endpoint/ID/token/expiry, expected image/source/repository/settings fields, and `runtime: {runtimeId, manifestSha256, archiveSha256, archiveBytes, expandedBytes, baseCompatibilityId, profile, bootstrapProtocolVersion, setupProtocolVersion, engineProtocolVersion}`. No input chooses an extraction path, command, bucket, shell text or environment. Endpoint origin and artifact host are allowlisted by base compatibility configuration; TLS validation is mandatory and redirects are rejected. Channel-specific origins are base configuration, never taken from a checkout.

### Two-stage redemption

Refine the proposed single admission to avoid expiring repository/engine credentials during a large download. V2's first one-use redemption yields only the pinned runtime descriptor, short-lived artifact GET URL, and a second one-use materials continuation bound to the same setup run/fence. After verification/installation, the verified setup helper consumes that continuation for freshly minted existing setup materials. Both redemptions revalidate actor/lifecycle/lease/pin/revocation. The original token is never consumed twice; legacy v1 redemption is unchanged. Existing setup explicitly requires five minutes of GitHub/registration validity before attestation (`S/setup-cloud-workspace.mjs:2310–2312`).

Store only token hashes and bounded state for each grant. Keep the existing one-use setup admission as the first grant, with an explicit v2 runtime-only redemption branch; add `cloud_workspace_runtime_materials_continuations` for the second stage instead of widening old grant-purpose checks. Its unique token hash, setup-run/generation identity, fence, expiry, consumed/revoked timestamps and installation witness are system-only, with at most one live continuation per attempt. A lost redemption response does not reproduce secret material from a journal: the setup worker revokes that attempt, advances its fence and issues fresh admission. Already verified runtime bytes can be reused by the new attempt. No database transaction spans download or provider I/O.

### Installer state machine

1. **Validate/lock.** Require VM root, Linux amd64, base/bootstrap identity, bounded exact-schema stdin and live admission. Hold `/run/zeros/setup.lock` for the operation and a separate short publication lock around pointer changes; retain existing engine/supervisor lifetime locks. Do not deadlock by taking `engine.lock` before asking the old supervisor to retire it.
2. **Admit runtime.** Redeem the runtime-only grant over TLS. Compare every returned immutable field to stdin and base compatibility; require sufficient ticket lifetime and a current execution fence. Journal an operation ID and non-secret expected identities; keep tokens/URLs in memory or root-only `/run` files excluded from snapshots.
3. **Reserve/check cache.** Check measured free space for archive + expanded staging + a fixed workspace reserve. Inspect an existing R without executing it; exact receipt and complete inventory match allows reuse. If a crash published verified R before writing its receipt, fresh admission plus a full no-follow inventory/hash/ownership recheck may reconstruct that receipt; an untrusted “verified” journal label is insufficient. A same-ID directory with mismatched bytes is quarantined as an error; never overwrite it or silently fall back.
4. **Download.** Stream into a new 0600 file under root-only `/opt/zeros-infra/.staging/<operation>/`, on the same filesystem as R. Bound length by admitted bytes and bootstrap hard caps (initial caps: 2 GiB compressed, 4 GiB expanded, 250,000 entries, 64 MiB manifest; tighten after measurement). Verify exact byte count and archive SHA before parsing/extracting. Reject redirect, non-HTTPS, truncation, timeout or extra bytes; suppress URL-bearing library exceptions.
5. **Validate archive.** Read the bounded first regular member `manifest.json`, verify canonical bytes/digest and all compatibility fields. Reject duplicate/absolute/traversing/NUL paths, hard links, devices, sockets/FIFOs, sparse extensions, special modes, ACL/xattr/capability restoration and unrecognized extended metadata. Use deterministic POSIX tar with only narrowly validated per-entry PAX `path`/`linkpath` extensions for long pnpm paths; reject global PAX records and any other overrides. Validate the resolved header set against inventory and aggregate size before writing payload members. Parse JSON with duplicate-key rejection; the admitted digest authenticates the raw canonical bytes, so Python need not reconstruct JavaScript serialization.
6. **Extract/verify.** Create directories/ordinary files through descriptor-relative no-follow operations in the empty stage; do not use unrestricted tar extraction. Write symlinks last, only with relative, fully resolved in-R targets, no literal link cycles or escaping ancestry. Check every hash, size, type and final mode; files must have `nlink=1`, root ownership, no group/other write. Inventory must account for every file. Flush files and directories; atomically rename the completed stage into R without replacing an existing version.
7. **Record installation.** Atomically persist a root-owned receipt with receipt version, operation ID, runtime/manifest/archive/base identities, bootstrap version, byte counts, installed-at and verified status. No URL, credential, user prompt or secret-bearing setup material. The immutable per-version receipt certifies installation; per-attempt boot/fence binding lives separately and cannot be inferred from that receipt.
8. **Retire/switch.** Recheck live continuation eligibility before mutation using a non-consuming `check` operation on the continuation endpoint; it cannot extend expiry or mint materials. Ask the existing verified supervisor to prepare/drain, or stop the host service and affirmatively inspect all service cgroups when switching versions. Refuse unconfirmed retirement. Write/fsync a switch intent containing old/new IDs and next disk epoch, set `previous` to the old ID, rename a temporary `current` symlink atomically, fsync its parent, and commit epoch/active metadata. Only `current` chooses code; `bin`, `worker` and `manifest.json` never flip independently.
9. **Start idle/setup.** Start/restart `zeros-host.service`, verify its status names the same R/base/boot/session, and invoke R's fixed setup helper using R's Node. Pass the continuation over a private stdin/FD. The helper redeems fresh materials, runs existing supervisor prepare, checkout/settings/setup, Git credential projection and v4 re-attestation, then starts the engine through the one-use proof/lock/barrier path.
10. **Confirm/finish.** Engine registration and durable readiness must agree with the same generation pin and boot/session. Return bounded sanitized readiness on SSH stdout; only then can the control plane mark setup successful. Always remove ephemeral input/materials and incomplete unverified staging. The runner must revoke its SSH key and dispose of its local key before returning success.

Download retries are bounded and only reuse an unexpired GET for the same bytes; URL expiry requires a fresh setup attempt, not broad storage credentials. The initial install budget must fit the existing maximum 1800-second SSH setup timeout, with roughly 10 minutes allocated to delivery and remaining time to setup/attestation; measure before tuning defaults. Lease heartbeats continue while setup is owned. Provider exec is used only for short probes, not the large install: its synchronous cap is 600 seconds and a 502 may have executed (`.context/research/r3/boat-docs/api__reference__agent__execute-sandbox-command.md:5`).

Crash recovery distinguishes downloaded, verified, published and engine-ready. Interrupted extraction never changes current. If a switch intent and current disagree, base boot reconciles only to one fully verified old/new version and records the outcome; ambiguous/missing authority leaves the host idle. A failed candidate may restore the old pointer after proven drain, but must not start an old engine against a new generation's pin. The control plane's explicit generation rollback supplies that authority. `disk-epoch` is diagnostic, not an anti-rollback security counter. Manual GC alone may remove unreferenced installed versions under the same locks.

### Mandatory closed diagnostics

Define one versioned, bounded diagnostic contract with `component`, `stage`, `exitCode` (integer or null if no process started), `timedOut`, and `failedChecks` (a deduplicated array of enumerated check names). Components are `bundle`, `publication`, `base`, `bootstrap`, `installer`, `attester`, `setup`, `qualification`, and `cleanup`. Stage enums include the installer steps above and canary steps below; neither field accepts free text. Check names identify predicates such as `archive_digest`, `manifest_digest`, `archive_paths`, `file_inventory`, `root_ownership`, `base_compatibility`, `uid_map`, `apparmor`, `cgroup_controllers`, `cgroup_retired`, `generation_pin`, `actor_session`, `credential_consent`, `native_turn`, `native_mcp`, `lease_revoked`, `ssh_key_revoked`, and `workspace_deleted`.

Base Python/Bash and the v4 attester emit this record on every exit; subprocess wrappers preserve an inner failed-check list instead of collapsing it to “attestation failed.” The CP setup worker persists it, and CI prints it on failure. Transport timeout, signal, malformed/missing child output and cancellation produce the enclosing stage's own enum (`diagnostic_missing`, `process_signal`, etc.), even when a killed child cannot emit anything. Raw stdout/stderr, exception messages/stacks, prompts, commands, paths, credential values, and signed URLs never become diagnostic fields or CI artifacts. A small bounded private diagnostic file is optional; it is never necessary to identify the failed predicate. Tests inject URL/token-like strings into every failure source and assert that only allowed constants, booleans and exit codes leave the boundary. No new opaque “private diagnostics withheld” outcome.

### Existing sequence and exact insertion points

| Step today | Evidence | V4 insertion/change |
| --- | --- | --- |
| Create locks organization, checks selected computer/quota, persists generation image/source | `C/routes.ts:2042–2047,2103–2108,2211–2229` | Resolve compatible qualified runtime under this transaction; write its immutable pin with the image/base selection. Idempotent replay returns the saved choice. |
| Provider creates from exact saved image and journals the request | `C/boat-provider.ts:257–284,299`; `C/provider-deployment.ts:142–151` | Keep provider resource/account/storage logic. Select v4 base for eligible new workspaces; no runtime download URL in provider create. |
| Wake uses saved resource, observes state and POSTs resume | `C/boat-provider.ts:407–425` | Reuse generation runtime and base pins, then fresh setup admission. Do not select channel head on wake. |
| Provider exec ensures the baked Node supervisor; diagnostic fixed-file probe | `C/boat-setup-runner.ts:18–20,450–479` | V4 probes base bootstrap/systemd readiness without requiring current/Node. Select the fixed transport branch from the saved generation. |
| Read SSH host key/endpoint, atomically install restricted expiring key, execute over pinned SSH stdin | `C/boat-setup-runner.ts:481–539`; `C/daytona-setup-executor.ts:19,233–271` | Preserve all restrictions. Add exactly one allowlisted v4 command and request version; execute the installer before any runtime helper. |
| Helper redeems materials, prepares supervisor, preflights image, clones/applies settings/hooks, installs Git projection, reattests, starts engine and waits | `S/setup-cloud-workspace.mjs:2479–2538`; redemption at `:1272` | Runtime-only redemption precedes install; fresh materials continuation replaces the helper's initial redemption on v4. Existing repository/authority checks remain. |
| Engine registers; worker locks registration grant before engine and publishes exact readiness | `C/internal-routes.ts:113–125`; `C/setup-materials.ts:1324–1336,1401–1416`; `C/setup-worker.ts:181–211,784–805,871–892` | Add v4 identity union, exact pin/boot/receipt comparisons and database enforcement. Keep grant-before-engine lock order. |
| Cleanup result can override otherwise successful setup | `C/boat-setup-runner.ts:551–593` | Preserve this rule through installer failures, timeouts and lost replies. |

There is currently no production Boat-fork lifecycle path in `C/boat-provider.ts`; create uses a named snapshot and wake uses resume. `C/routes.ts:151–161,2323` implements a local-checkpoint import fork, not provider snapshot forking. It has no source cloud runtime pin and selects as a new workspace. Phase C's future template/provider fork must copy template runtime/base pins before allocation and clear inherited ephemeral authority; B provides that interface and tests pin-copy logic, without claiming the provider fork is already implemented.

## 5. Control-plane contracts and persistence

### Additive schema

Do not write v4 into the existing `agent_runtime_profile` or `cloud_agent_runtime_qualifications.profile`: both are constrained to v3 by `apps/control-plane/migrations/0084_cloud_personal_agent_credentials.sql:54–67`. Do not edit that migration, its operator policy, or the old approval audit. New v4 engines leave both legacy agent-runtime fields NULL. The following is a SQL sketch; migrations must add full identifier/length/JSON bounds, indexes, privileges, immutable-row guards and the referenced trigger bodies. Reserve migration numbers with the orchestrator; the inspected head is 0123.

```sql
CREATE TABLE cloud_runtime_base_contracts (
  base_compatibility_id text PRIMARY KEY,
  contract_sha256 text NOT NULL UNIQUE,
  contract jsonb NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE cloud_runtime_base_images (
  base_image_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider = 'boat'),
  image_ref text NOT NULL UNIQUE,
  base_compatibility_id text NOT NULL REFERENCES cloud_runtime_base_contracts,
  source_commit text NOT NULL,
  image_build_sha256 text NOT NULL,
  architecture text NOT NULL CHECK (architecture = 'linux/amd64'),
  storage_mib bigint NOT NULL CHECK (storage_mib > 0),
  approved_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (base_image_id, base_compatibility_id)
);
CREATE TABLE cloud_runtime_bundles (
  runtime_id text PRIMARY KEY,
  manifest_sha256 text NOT NULL,
  archive_sha256 text NOT NULL,
  archive_bytes bigint NOT NULL CHECK (archive_bytes > 0),
  expanded_bytes bigint NOT NULL CHECK (expanded_bytes > 0),
  object_key text NOT NULL UNIQUE,
  source_commit text NOT NULL,
  architecture text NOT NULL CHECK (architecture = 'linux/amd64'),
  node_version text NOT NULL,
  node_modules_abi integer NOT NULL,
  bootstrap_protocol_version integer NOT NULL,
  setup_protocol_version integer NOT NULL,
  engine_protocol_version integer NOT NULL,
  manifest_header jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (runtime_id = 'r1-' || manifest_sha256),
  UNIQUE (runtime_id, manifest_sha256)
);
CREATE TABLE cloud_runtime_channel_releases (
  channel text NOT NULL CHECK (channel IN ('alpha','beta','production')),
  release_order bigint NOT NULL CHECK (release_order > 0),
  runtime_id text NOT NULL REFERENCES cloud_runtime_bundles,
  github_release_run_id bigint NOT NULL,
  github_release_run_attempt integer NOT NULL,
  confirmed_at timestamptz,
  PRIMARY KEY (channel, release_order)
);
CREATE TABLE cloud_runtime_qualifications (
  runtime_id text NOT NULL REFERENCES cloud_runtime_bundles,
  base_compatibility_id text NOT NULL REFERENCES cloud_runtime_base_contracts,
  credential_kind text NOT NULL CHECK (credential_kind IN
    ('claude-api-key','claude-setup-token','codex-api-key','codex-chatgpt','cursor-api-key')),
  profile text NOT NULL CHECK (profile = 'zeros-cloud-worker-v4'),
  enabled boolean NOT NULL DEFAULT false,
  mcp_qualified boolean NOT NULL DEFAULT false,
  native_capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_run_id uuid NOT NULL,
  qualified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (runtime_id, base_compatibility_id, credential_kind, profile)
);
ALTER TABLE cloud_workspace_generations
  ADD COLUMN runtime_id text,
  ADD COLUMN runtime_manifest_sha256 text,
  ADD COLUMN runtime_base_image_id text,
  ADD COLUMN runtime_base_compatibility_id text,
  ADD COLUMN runtime_profile text,
  ADD COLUMN runtime_engine_protocol_version integer,
  ADD CONSTRAINT cloud_generation_runtime_complete CHECK (num_nonnulls(
    runtime_id, runtime_manifest_sha256, runtime_base_image_id,
    runtime_base_compatibility_id, runtime_profile, runtime_engine_protocol_version) IN (0,6)),
  ADD FOREIGN KEY (runtime_id, runtime_manifest_sha256)
    REFERENCES cloud_runtime_bundles (runtime_id, manifest_sha256),
  ADD FOREIGN KEY (runtime_base_image_id, runtime_base_compatibility_id)
    REFERENCES cloud_runtime_base_images (base_image_id, base_compatibility_id);
```

Also add the same nullable six-column identity group to `cloud_workspace_engine_instances` and `cloud_workspace_setup_attestations`, plus `runtime_installer_receipt_sha256`, `runtime_boot_id`, and `runtime_supervisor_session_id`. Add an attempt-bound installation witness to the setup run/materials continuation. Use exact `(workspace_id, org_id, generation)` and `(engine_instance_id, workspace_id, org_id, generation)` references already available; no cross-organization lookup by runtime alone. The qualification run/case tables in §6 supply the composite evidence FK `(evidence_run_id, credential_kind)`.

New BEFORE triggers enforce: generation pins cannot change after INSERT; a registered v4 base `image_ref` requires the entire pin; its saved image/source/storage match that base registry row; the pinned engine protocol matches the immutable bundle; a v4 engine cannot also claim legacy fields; engine identity equals its generation and consumed registration grant; durable setup attestation equals that exact engine, witness, boot/session and current setup fence. Retain the existing live-registration readiness backstop (`migrations/0022_cloud_workspace_setup_materials.sql:112–142`) and add a separate v4 trigger. Validate all new constraints against legacy NULL rows before enabling v4. Never interpret NULL as “latest.” Legacy rows are not backfilled on wake.

Registry/base identity columns and confirmed channel-release identities are immutable. Only documented revocation state is mutable; existing pins keep referencing revoked records for audit/cleanup. RLS is enabled and forced on every new table. Metadata reads use `app_is_system()`; there are no tenant write policies for registry/qualification data. CI has no database role. `zeros_app` must not receive direct INSERT/UPDATE/DELETE on `cloud_runtime_qualifications`; grant EXECUTE only on a narrow `finalize_cloud_runtime_qualification(run_id)` SECURITY DEFINER function, owned by the migration owner, with a fixed safe search path and PUBLIC execution revoked. It derives all approved identities/checks from the locked completed run/cases, cannot accept an arbitrary key or `enabled=true`, and refuses revoked runtime/base/qualification rows. This is a deliberately new, small approval authority; it does not loosen v3's operator-only writes (`0084:108–114`, migration 0090).

Registry publication similarly uses a constrained registration operation behind the publication-only authenticated endpoint. Immutable equality makes retries idempotent; a same-ID descriptor conflict is an error. Run/case writes are private control-plane operations with system RLS and explicit transition predicates. The trust model includes the control-plane application: definer functions constrain normal callers and accidents, not a fully compromised server capable of fabricating its own evidence.

### Selection, pins and explicit transitions

The effective head is a query, not another mutable pointer or a Railway worker tuple. Filter release rows to the current channel and confirmed successful parent release, a non-revoked bundle/base contract, the configured base, manifest/base compatibility, an engine protocol supported by the currently deployed CP, and **all three required kind/profile rows enabled and MCP-qualified**. Order by `release_order DESC`; choose one. Use the parent `Release (alpha)` workflow's run number as release order, not GitHub run ID, commit timestamp, qualification completion time, or rerun attempt. An identity-checked rerun of that parent retains its order. A delayed older canary cannot displace a newer eligible release.

Current engine protocol is 20, minimum accepted by general config is 2 (`C/engine-protocol-version.ts:11–12`; `P/config.ts:500–509`). Those bounds do not prove semantic compatibility for every v4 feature. Initially support v4 only at the deployed, tested protocol (currently 20); expand a supported set/range only with mixed-version tests. Do not weaken legacy exact-registration comparison (`C/setup-materials.ts:1333`). V4 compares against the generation's pin AND the deployed supported protocol contract. Include actor protocol 2, setup v2 and bootstrap v1 in that compatibility contract. Any actual protocol change follows `pnpm check:protocol` and the existing versioning rules.

Also extend the currently v3-only descriptive runtime-profile types in `packages/protocol/src/containment.ts:58–64,125–132` and `packages/protocol/src/cloud-agent-execution.ts:38–49`, and emit the actual verified profile from `E/agents/cloud-provider-execution.ts:67–74`. These are distinct from the installed native execution profile `zeros-cloud-native-v1`, which stays unchanged. Browser diagnostics remain unavailable: shipping Chromium for Design capture does not qualify native provider Browser access. Test old/missing/unknown diagnostics falling back to unavailable, and both v3/v4 reports in a new client. Record any protocol bump required by the final wire change in the bundle instead of assuming the current number is permanent.

During create, compute the candidate at preflight, then select/recheck under the existing organization lock and insert workspace/generation/pin atomically (`C/routes.ts:2042–2047,2103–2108,2211–2229`). Lock referenced qualification/revocation rows consistently with finalization/revocation; no provider/network operation inside that transaction. Idempotency replay returns the saved generation even if head advanced. With v4 selected and no head, fail with a closed `cloud_runtime_unavailable` result. Do not allocate a base and hope a runtime becomes qualified later. Only the designated canary exception in §6 can select an unqualified registered candidate.

| Operation | Runtime/base authority |
| --- | --- |
| New ordinary v4 workspace | Newest complete qualified compatible runtime for the configured registered base. |
| Sleep/wake, setup retry, engine restart | Same generation runtime/base; fresh execution/admission fence and online revocation checks. Never silently switch to head. |
| Automatic or explicit recovery from a v4 source | Copy the saved source runtime/base and retained checkpoint compatibility. `C/automatic-recovery.ts:222–241` currently selects today's profile; add the v4 branch here as well as in routes. Legacy recovery retains its current semantics. |
| Explicit `POST .../generations` with `operation: upgrade` | Resolve a later eligible runtime for the **source generation's same base**, drain/checkpoint, create a new pinned generation and provision from the saved named base. No-op when already current. Do not rebuild an image. |
| Explicit rollback | Copy the selected source generation's pin if still approved and compatible with the restored checkpoint/state schema. Binary pointer rollback alone cannot undo data migrations. |
| Local-checkpoint import | A new cloud workspace selection; local state has no cloud runtime pin. |
| Future provider/template fork | Copy an explicit source runtime/base pin before create and mint fresh ephemeral authority; Phase C implements provider forking. |

An upgrade normally creates another VM from the same base through existing checkpoint export/import, not an in-place rewrite of a live generation. Existing image/source fields remain base provenance; `runtime_id` resolves the engine source commit. Keep the workspace checkout revision distinct from both. Preserve saved historical image dispatch in `C/provider-deployment.ts:142–151`; registry rows needed by a generation cannot be garbage-collected. Re-check qualification/revocation at every fresh setup, credential admission and renewal. A revoked pin fails closed and requires an explicit recovery/upgrade decision; it never silently selects an older/newer runtime. In-flight credential revocation follows existing lease deadlines.

### V4 admission and registration shapes

Keep the current v1 schema and add a discriminated v2 shape; no optional field combination may mean either mode. Contract notation below uses names/types, not live values:

```text
SetupAdmissionV2 = {
  version: 2,
  workspaceId, organizationId, generation, setupRunId, executionFence,
  admission: { id, endpoint, token, expiresAt },
  imageRef, sourceCommit, repository, settingsRevision,
  runtime: { runtimeId, manifestSha256, archiveSha256, archiveBytes, expandedBytes,
             baseImageId, baseCompatibilityId, profile: "zeros-cloud-worker-v4",
             bootstrapProtocolVersion: 1, setupProtocolVersion: 2,
             engineProtocolVersion }
}
RuntimeRedemption = { version: 2, runtime: <same immutable descriptor>,
  artifact: { url, expiresAt }, materialsContinuation: { id, token, expiresAt } }
MaterialsContinuationCheck = { kind: "check", id, token, setupRunId, executionFence }
MaterialsContinuationRequest = { kind: "redeem", id, token, setupRunId, executionFence,
  installed: { runtimeId, manifestSha256, baseCompatibilityId,
               installerReceiptSha256, bootId, supervisorSessionId } }
AgentRuntimeV4 = { profile: "zeros-cloud-worker-v4", runtimeId, manifestSha256,
  baseCompatibilityId, installerReceiptSha256, bootId, supervisorSessionId }
```

These request/response types are internal; the artifact URL and grant fields are never serialized into logs, workspace documents or durable evidence. Store hashed grants with expiry/consumption/fence; repeat or cross-workspace redemption rejects. `baseImageId` is registry metadata, not a VM-supplied image selector. The v4 setup helper presents the base-verified installation witness during continuation redemption, after the new idle supervisor has a boot/session identity; CP binds that witness to the setup attempt before issuing its engine registration grant. This avoids comparing an engine claim to a receipt that has not reached CP yet.

Extend `C/internal-routes.ts:113–125`, `C/setup-materials.ts:1324–1336,1401–1416` and the engine registration payload with the v3/v4 union. All v4 identity fields must match the generation and attempt witness. Durable readiness additionally requires the consumed grant, exact engine instance, existing lease/authority deadlines and current fence; preserve grant-before-engine locking (`C/setup-worker.ts:784–805,871–892`). The engine's read-only descriptor and selected root must independently match before it can report v4. An arbitrary runtime ID in engine environment variables is not attestation.

### Credential gates, image semantics and switches

Use a shared v4 qualification predicate in both grant discovery and execution admission/renewal: `C/agent-credentials.ts:414–437` and `C/agent-executions.ts:97–125`. Join the immutable generation and exact registered engine to `(runtime_id, base_compatibility_id, credential_kind, profile)`; continue all actor, device, consent, model, credential-revision and compute-trust checks. MCP and native feature approval remain independent bits backed by their own evidence. A Claude setup-token result cannot approve a Claude API key; a Codex ChatGPT result cannot approve a Codex API key. v3 continues its provider/image/contract join.

For future organization images, reusable qualification depends on a verified v4 base compatibility ID and unchanged protected bootstrap/runtime boundary, not an image's self-declared label. Phase C must add the protected-file build proof before those images may use this join. Phase B never makes arbitrary root-built organization images qualified. Keep the current builder/activation behavior until C updates `C/computer.ts:404–407` and `C/computer-image.ts:161–207`; the present Alpha Build computer 409 is not fixed by manufacturing legacy approvals.

Phase A owns the existing hash regression: `E/cloud-runtime-attestation.ts:51` reports `imageContractSha256`; `P/dev-agent-qualification.ts:93–105` instead matches/returns `image.source_contract`. The correct field is `cloud_computer_images.image_contract` (`migrations/0117_cloud_computer_images.sql:13–14`). Required failing-first fixture uses deliberately unequal source/image hashes, approves only the actual image hash, and proves lookup/returned contract and credential enablement use it; a source-hash-only row must not enable execution. Depend on A's fix, do not duplicate it in B.

Proposed new per-channel configuration (all names new unless explicitly noted):

- `CLOUD_WORKSPACE_NEW_RUNTIME_PROFILE=legacy|v4` (default legacy), `CLOUD_RUNTIME_V4_BASE_IMAGE_ID`, and `CLOUD_RUNTIME_V4_STAFF_ONLY=true`. Only new creates use this switch; decoding/operating saved v4 generations stays deployed if it is switched back. With Alpha switched to v4, no legacy fallback for new workspaces; other channels retain their configuration.
- `RUNTIME_QUALIFICATION_ENABLED` and exact fixture user/org/team/repository/installation/base IDs. Candidate exception is Alpha-only, independent of the ordinary-new-workspace switch, and expires with its run. An enabled fixture never makes all staff workspaces candidates.
- A dedicated runtime artifact prefix/bucket/endpoint configuration, publication credential hash and qualification-driver credential hash; runtime delivery uses the existing CP-held S3 authority but a separate adapter and authorization surface. Credentials are detailed in §8.
- Existing `ZEROS_WORKER_PROMOTION` stays off. Do not repair, dispatch, or delete the old worker lane. Extend `P/release-identity.ts` with optional non-secret v4 runtime/base/source/qualification metadata; API liveness and desktop publication must not wait for that qualification. Preserve the existing v1 fields and distinguish base source from runtime source.

## 6. Small Alpha qualification lane

### What to reuse, and what to leave alone

`R/worker-canary.ts` and `C/release-canaries.ts` own a separate allocation/admission/retirement protocol with historical audits and worker account machinery; they are unsuitable for this lane. `C/dev-native-canary.ts` uploads and starts a private qualification process on a disposable provider target, and `P/dev-agent-qualification.ts:79–89` already filters by legacy qualification; neither exercises an ordinary live workspace from Alpha's empty state. Keep all three paths unchanged. `P/manage-cloud-agent-runtime.ts:182–231` requires the migration owner and active platform owner; do not hand its database authority to routine CI.

Reuse the ordinary workspace reconciler/setup/actor/credential/command path, pure smoke scenario ordering from `scripts/cloud-workspace-validation/lib/native-canary-smoke.ts:1–11`, and synthetic MCP fixture generation where useful. The new runner connects to the registered engine like a client; it does not mount the old private runner or mock the control plane's credential service. Existing `S/qualify-cloud-agent.ts:87–122` supplies its own canary lease authority, so running that script alone is not evidence that real workspace credential admission works. Its isolation/probe fixtures remain useful independently.

### Minimal new durable state

```sql
CREATE TABLE cloud_runtime_qualification_runs (
  id uuid PRIMARY KEY,
  channel text NOT NULL CHECK (channel = 'alpha'),
  release_order bigint NOT NULL,
  runtime_id text NOT NULL REFERENCES cloud_runtime_bundles,
  base_image_id text NOT NULL REFERENCES cloud_runtime_base_images,
  base_compatibility_id text NOT NULL REFERENCES cloud_runtime_base_contracts,
  profile text NOT NULL CHECK (profile = 'zeros-cloud-worker-v4'),
  actor_user_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  create_idempotency_key text NOT NULL UNIQUE,
  workspace_id uuid,
  generation integer,
  state text NOT NULL CHECK (state IN
    ('reserved','creating','running','tested','cleaning','succeeded','failed','expired','superseded')),
  expires_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  candidate_revoked_at timestamptz,
  cleanup_state text NOT NULL CHECK (cleanup_state IN ('none','pending','confirmed')),
  diagnostic jsonb,
  UNIQUE (channel, release_order, id)
);
CREATE TABLE cloud_runtime_qualification_cases (
  run_id uuid NOT NULL REFERENCES cloud_runtime_qualification_runs,
  credential_kind text NOT NULL,
  credential_id uuid NOT NULL,
  credential_revision bigint NOT NULL,
  connection_revision bigint NOT NULL,
  model text NOT NULL,
  command_plan jsonb NOT NULL,
  evidence jsonb,
  sealed_at timestamptz,
  PRIMARY KEY (run_id, credential_kind)
);
ALTER TABLE cloud_runtime_qualifications ADD FOREIGN KEY
  (evidence_run_id, credential_kind)
  REFERENCES cloud_runtime_qualification_cases (run_id, credential_kind);
```

Run rows also carry the verified parent workflow/run/attempt/source identity, registered client device ID, exact fixture repository commit, and timestamps. `command_plan` is a bounded typed list of reserved command IDs and scenario enums. `evidence` holds only bound engine/boot/generation/lease/execution IDs, fixture/protocol/check digests, allowed passed-check enums and closed diagnostics; never transcripts or credentials. Enforce the complete three-kind matrix for initial runs and an explicit kind list for later optional coverage. Private transitions atomically bind the first created workspace/generation to the reservation and seal each case once; retries must match its original bytes. No append-only receipt chain or per-run R2 object is necessary.

Retain compact sealed evidence while a qualification references it. Do not add FKs that force indefinite retention of personal credentials, prompt payloads or deleted engine records; persist the minimum historical identities needed to explain the test. The finalizer checks the sealed facts after cleanup, because live engine authority intentionally no longer exists by then.

### Authenticated fixture and bootstrap exception

An operator first prepares **one dedicated staff developer user**, one canary organization/team, an authorized GitHub installation and a disposable pinned fixture repository, with normal Cloud access/compute allowance. This is a real authenticated account with current org/team membership, not a forged system actor or a platform-owner service account. Store its three personally owned provider connections through normal Zeros credential APIs and select them in that organization. The owner explicitly authorizes their automated test use and the bounded model/spend plan. Inventory is metadata-only; no model credential is exported to CI.

For the smallest viable runner authentication, the fixture owner performs normal Alpha WorkOS sign-in and places **only that dedicated account's opaque browser-session credential** in the protected Alpha GitHub environment as `RUNTIME_CANARY_BROWSER_SESSION`. The runner calls the existing CP `/auth/browser/session` with the session cookie, keeps the returned short-lived access token in memory, and refreshes with `/auth/browser/refresh` using the returned revision when required. This already has server-stored sealed refresh state and serialized rotation (`P/workos-browser-sessions.ts:19–22,483–501,723–735,845–876,1164–1180`; mounted separately from `/v1` auth at `P/app.ts:277–292`). Session expiry/revocation fails `actor_session` before allocation; re-enrollment is an operator action. No general WorkOS API key, raw refresh token, account password, or new authentication bypass in CI. No changes to Pages or its proxy allowlist are needed.

Add three small private endpoints under `/internal/v1/runtime-qualification`: reserve/read a run, seal a case, and finish/request cleanup. Reservation/evidence writes require a separate `RUNTIME_QUALIFICATION_DRIVER_TOKEN`, the fixture's normal validated bearer, and matching protected release provenance. The driver token alone cannot impersonate the staff user or get model material. Ordinary create uses its existing bearer and idempotency key plus an optional `runtimeQualificationRunId`; the server must validate the run, active fixture session, exact user/org/team/repository/base, deadline and unbound-or-identical workspace under the ordinary organization lock. There is no general runtime-override field.

**Candidate exception:** only a non-revoked active run may select its registered but unqualified runtime, and only its bound canary generation can temporarily pass the qualification term in agent grant discovery/admission. It does not waive base/manifest verification, setup readiness, staff/funding/repository authority, device proof, credential/delegation/model/revision checks, or compute-trust checks. Bind it to the registered device/actor, runtime/base/profile, one active credential case, reserved command IDs, engine instance/fence, and a bounded lifetime (initially 60 minutes; heartbeat every 30 seconds, ownership expires after 2 minutes). Cap one active run/VM for the fixture and one active case/execution at a time. A new run cannot adopt an unrelated historical VM.

At each credential delivery/renewal, revalidate the run/case alongside the normal checks. Candidate MCP permission covers only the pinned synthetic fixture/configuration; all optional native fork/goal/background capabilities remain false. Marking a case complete, expiry, revocation, cancellation, org/device/credential changes or cleanup ends this exception. Missing qualification on any other Alpha workspace still denies execution. First bootstrap can run while the ordinary v4-create switch is off, with zero rows in either legacy or v4 qualification tables.

### Concrete successful run

1. **Preflight/reserve.** Confirm Alpha release/API source and supported protocols, registered artifact/base identity, parent `Release (alpha)` success and source/branch, fixture session/user/org/GitHub/allowance, and all designated credential revisions/models. The protected driver records the three case bindings. Missing credentials or provider/model availability is a closed failed check, never an inferred approval. Parent provenance must come from the trusted workflow/API lookup, not a submitted `success` flag.
2. **Register device/create.** Generate an ephemeral Ed25519 device key in runner memory and use existing `POST /v1/devices` (`C/routes.ts:1084–1098`). Create `zeros-v2-test-runtime-<run>` with ordinary `POST /v1/organizations/:organization/cloud-workspaces`, exact fixture commit and reserved idempotency key. CP atomically binds the run/pin and provisions through its ordinary provider operation records. Do not create or query unrelated Boat sandboxes from CI; the normal create request has no provider name field (`C/boat-provider.ts:268–284`), so record its opaque resource ID against the named workspace rather than invent a provider label.
3. **Reach ready/attach.** Poll normal workspace state and the safe run diagnostic projection. Setup takes the v4 path in §4. Issue the existing actor-protocol-2 runtime admission with the registered device proof (`C/routes.ts:1266–1286`), then connect the normal engine bridge and maintain actor heartbeats. `C/actor-sessions.ts:55–71,104–110` requires a live WorkOS session and trusted device; CI must satisfy it. Use normal organization credential prepare/delegation routes (`C/agent-credential-routes.ts:44–65`); candidate discovery works only for this case.
4. **Run three real providers.** Sequential cases are `claude-setup-token` with `claude-haiku-4-5`, `codex-chatgpt` with `gpt-5.6-luna`, and `cursor-api-key` with `composer-2.5`, subject to the owner's current model consent (`C/release-canary-contract.ts:4–9` establishes today's smoke matrix). Through the ordinary conversation/queued-command bridge, ask each provider to read a synthetic nonce, perform a bounded file edit/tool call and call the synthetic MCP server. Independently read back the file/proof, check typed tool events and a terminal successful turn, then resume the conversation for a second real turn. Exercise a permission selection, bounded stop and delegation revocation with a denied subsequent execution. Keep prompts/transcripts out of CI logs. CP continues its normal Codex auth keeper/renewal; never send refresh/ID tokens to the VM (`C/agent-executions.ts:188–205`).
5. **Seal evidence.** The runner submits only typed observations, scenario/fixture digests and exact command/execution IDs. CP correlates them with the actual candidate credential lease, same engine/generation/pin and authenticated engine's settled command result (`C/commands.ts:384–416,443–461`). Seal facts while that authority is still observable; terminal command payloads are intentionally removed by settlement. Plain engine startup, HTTP 200, a mock provider, an empty “success” message or a caller-supplied boolean cannot qualify a case. File/MCP/tool observation is protected-runner test evidence; it is not cryptographic proof independent of trusted CI/engine code.
6. **Cleanup.** Revoke candidate permission first, retire agent leases/actor admission, request ordinary workspace DELETE and revoke the ephemeral device/delegations. Wait for that normal delete operation's confirmed terminal outcome, record its resource identity and closed checks, and erase runner memory/temp inputs. Use existing provider deletion/reconciliation, not an independent canary retirement broker. Normal durable storage retention/reclamation remains its existing workflow; do not claim physical storage was erased merely because a VM stopped. Cases are not re-run just because a cleanup retry was necessary.
7. **Finalize.** Once every required case is sealed successful and cleanup confirmed, the constrained finalizer checks runtime/base revocation, evidence freshness, release identity, and fixture consent, then inserts the three exact qualification keys atomically. MCP flags require the MCP checks. Optional native capabilities stay absent/false. Mark run succeeded. The derived channel-head query now sees it if it is the newest compatible release; no Railway mutation or v3 approval row is written.

The small private run service also scans its own expired `reserved/creating/running/cleaning` rows through the existing background tick. It revokes candidate authority immediately and requests the same idempotent normal delete transition for **only their recorded workspace IDs**. It neither inventories historical canary ownership nor blocks release on other artifacts. A crash after accepted create is recoverable through the create idempotency key and ordinary provider journal; an unbound reservation cannot delete a guessed resource. CI always requests cleanup in a finally block; the durable expiry sweep covers process loss. Expose `cleanup_state=pending` and a specific closed check until resolved. Old incomplete worker-lane audits have no effect on new runs.

For expired-user cleanup, extract only the existing deletion-intent transaction into `C/workspace-delete-request.ts`, shared by the normal DELETE handler and the bound-run expiry service. Preserve idempotency, authority retirement, deletion-job creation and audit (`C/routes.ts:2875–2910,3067–3172`). Fixture enrollment preauthorizes discarding this disposable run's uncheckpointed synthetic data; its cleanup uses the existing `discardUncheckpointed` option, so a revoked actor session cannot leave a paid VM waiting forever for an unavailable final checkpoint. The internal caller derives cleanup authority exclusively from the recorded expired/revoked run; it cannot create/wake workspaces, use credentials or delete arbitrary IDs. Register/stop this small sweep alongside the existing workers in `P/index.ts:536–558,637–647`. Do not move unrelated lifecycle code.

## 7. Runtime path and containment change inventory

This is the scoped inventory from the inspected checkout; line anchors identify literals and nearby ownership decisions. Re-run the search during implementation, including `/etc/zeros`, `/zeros`, `zeros-cloud-worker-v3`, marker `version === 3`, and nonliteral adjacent-helper resolution. Do not make a global string replacement. `R`/`W` below are the verified concrete roots from §2, and state paths remain fixed.

| Files and anchors | Required v4 treatment |
| --- | --- |
| `E/cloud-runtime-attestation.ts:18–29,51,57–59`; `E/agents/containment/cloud-worker-config.ts:21,108–133,166–193` | Add trusted descriptor/profile union; resolve R once, validate exact regular canonical entrypoints and root ancestry. Preserve v3 image hash and NULL behavior. |
| `E/cloud-runtime-registration.ts:394`; `S/cloud-runtime-profile.mjs:23,41` | Adjacent non-path v3-only guards must understand the new union; identical v3/v4 UID maps cannot substitute for descriptor/profile validation. |
| `E/agents/cloud-provider-execution.ts:67–74`; `packages/protocol/src/{containment.ts:58–64,125–132,cloud-agent-execution.ts:38–49}` | Emit the verified runtime profile and extend its diagnostic/type union; preserve native execution profile and unavailable Browser semantics. |
| `E/agents/adapters/claude-sdk/adapter.ts:4307`; `codex/app-server.ts:592`; `codex/binary-resolver.ts:121`; `cursor-sdk/host/host-client.ts:787,794` (last three under `E/agents/adapters/`) | Derive CLI/native package/source helper anchors from W, not `/opt/zeros/package.json` or a checkout. Keep ordinary local-desktop resolution unchanged. |
| `E/agents/adapters/codex/cloud-exec-server.ts:10,47,62–63`; `E/agents/containment/cloud-codex-executor.mjs:8,12` | Resolve root-controlled exec helper/node from R/W; retain coordinator UID and broker authority. |
| `E/agents/cloud-language-document.ts:5`; `cloud-language-service.ts:23,151,162`; `cloud-workload-tools.ts:15,37,67,101` (under `E/agents/`) | Derive verified binaries/module roots and finite resource tools; no environment-selected installation. |
| `E/agents/containment/cloud-coordinator-boundary.ts:15,17,22`; `cloud-coordinator-view.mjs:15,25,55`; `cloud-deployment-authority.mjs:9–18,51–63`; `cloud-native-boundary.ts:93` (same containment directory) | Mount only selected R, preserve private provider view, v4-to-v3 identity-map mapping, and explicit allowed profile checks. |
| `E/agents/containment/zsr-boundary.ts:1738–1747` | Keep nonliteral adjacent `.mjs` helper resolution inside the verified source slice; test it with the original checkout unavailable. |
| `E/design/capture-cloud.ts:15–16,139`; `E/transport/cloud-human-services.ts:92`; `cloud-language-services.ts:12–20,55`; `cloud-ssh-session.mjs:189` (last two under `E/transport/`) | R's node/worker/browser cache in proper namespace; preserve actor/terminal/capture UID boundaries. |
| `E/cloud-code-review-records.ts:106`; `E/workspace/service.ts:2435` | Extend private-root denial rules to `/zeros`, `/opt/zeros-infra`, `/opt/zeros-bootstrap`, installation receipts and projected aliases; a new facade must not expose private source/state. |
| `S/start-engine.sh:19,22–24,71–75,118–130,167,189`; `setup-cloud-workspace.mjs:67–68,94,1595,1855,1968,2317,2548–2550` | Use verified concrete root for node/helpers/PATH/working directory; v2 continuation entry branch; state and Git repository paths unchanged. |
| `S/attest-cloud-worker.mjs:39–41,63–123,252,338–419,449,469,554`; `cloud-runtime-profile.mjs:114` | New v4 manifest/receipt/base branch with complete isolation checks and closed failed-check output; retain legacy source/native inventory branch. |
| `S/cloud-engine-launcher.mjs:190,214–222,312`; `cloud-engine-namespace.c:44–52,74–81,98–103,133,245,249,252–253`; `cloud-engine-view.mjs:54–61,138–140,155,166–173` | Construct canonical R/W paths from validated ID/descriptor; per-launch facade and read-only `/etc/zeros` projection, base AppArmor, launch barrier and same UID map. |
| `S/cloud-engine-cgroup.mjs:18–24,159–214`; `cloud-setup-process.mjs:19–25,81–100`; `cloud-worker-supervisor.mjs:28,266–350`; `ensure-cloud-worker-supervisor.mjs:14–31,88` | Explicit trusted delegated subtree, complete drain, systemd idle host, concrete helper paths. Legacy ensure remains on legacy images; v4 first probe is base-owned. |
| `S/consume-cloud-admission.mjs:21–22`; `cloud-worker.json:8–9`; `runtime-layout.json:4`; `image-build-contract.mjs:27`; `write-image-build-metadata.mjs:35`; `zeros-cloud-engine.apparmor:6` | Versioned schemas/host versus engine markers; separate base and runtime metadata; no legacy image-contract reinterpretation. Add v4 AppArmor template instead of broadening old generated policy. |
| `S/qualify-cloud-agent.ts:82,138`; `qualify-cloud-actor-tools.ts:54`; `qualify-cloud-engine.mjs:36,67–68,124,130,207,245,248,270–283` | Resolve harness/native/tool paths using R/W and support v4 profile checks. Reusable probes need no private legacy orchestrator. |
| `C/boat-setup-runner.ts:18–20,419–593`; `C/daytona-setup-executor.ts:19,233–271` | Strict fixed-command/request-version branch and base probe; v4 only Boat initially. Shared legacy executor name and exported contracts need not be renamed. |
| `B/templates/{build,install,attest,sanitize,private-state,builder-preflight,build-hash}.sh`; `B/templates/owned-runner.py:59`; `scripts/cloud-workspace-validation/{image.ts:87–270,Dockerfile:33–172}` | Retain legacy v3 generation/build scripts. Add separate runtime-base-v4 templates/profile; do not feed a v4 facade into v3 source-copy or sanitation assumptions. |
| `scripts/cloud-workspace-validation/runtime.ts:38–44,1000,1094`; `provision.ts:208`; `egress.ts:31` (same directory) | Version-aware validation/profile plumbing where used for B acceptance; legacy commands still select legacy fixtures. |
| `C/dev-native-canary.ts:45,53,73`; `scripts/dev-environment/native-agent-canary.mjs:182` | Remain legacy only; new workspace canary does not rely on these absolute paths. |
| `C/computer-image-scripts.ts:58,73,81,101,103,153,167,176,202,210,213` | Phase C-owned builder contract. Leave legacy script generation intact; refuse claims of v4 privileged-build reuse until protected-file checks exist. |

Root guards currently reject symlinked canonical entrypoints; preserve that protection (`S/ensure-cloud-worker-supervisor.mjs:17–31`; `S/cloud-engine-namespace.c:44–52`). `current` and the public facade are intentionally links, so validate the exact allowed link structure, resolve to R, then apply the strict guards to physical R paths. Inventory verification alone permits relative package links with fully resolved in-tree targets; its current lexical-only test (`S/attest-cloud-worker.mjs:93–123`) is insufficient for chained escapes. Hard links remain forbidden for every installed regular file, including native executables. A facade swap after launch cannot change the mounted runtime or already-resolved entrypoints.

## 8. CI, storage and manual base publication

### Bundle build and immutable R2 publication

Choose R2, not OCI delivery. CP already has `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (`apps/control-plane/package.json:39–40`); a base Python HTTPS client can fetch a presigned object without Docker, OCI extraction or GHCR credentials. Existing `cloud-runtime-publication.yml:5–25` is a manual GHCR OCI publisher on Ubuntu 26.04; retain it for its current consumers, rather than silently changing its output format.

Add `C/runtime-artifact-store.ts` with a strict `runtime/v1/<runtimeId>/<archiveSha256>.tar.gz` key constructor and exact-size limits. Do not loosen workspace ciphertext prefix/key/size restrictions or reuse workspace tombstones and tenant erasure (`C/s3-object-store.ts:41–56`). Artifact writes are create-only conditional PUTs, following the existing `IfNoneMatch: '*'` pattern (`:58–67`); bounded lifetime and signed required headers prevent a different key/method or ordinary overwrite. A conflicting existing object cannot be replaced. An expiry or unknown upload outcome is reconciled by HEAD plus the original immutable descriptor; do not create another mutable alias.

The CP publication API authenticates `RUNTIME_BUNDLE_PUBLISH_TOKEN`, validates bounded descriptor/source/release identity, and issues a short-lived exact-key PUT capability. CI streams its already-hashed archive; afterward CP HEAD-checks byte length and stored descriptor metadata and commits registry identity. ETag is not SHA-256 evidence, and metadata is not an independent content checksum: protected CI owns the content digest, while first install/canary re-hashes all delivered bytes before execution/qualification. If R2's tested conditional-header behavior cannot meet create-only semantics, fail publication and fix that adapter; do not silently accept overwrites. Presigned GET is issued only on an admitted, still-authorized generation/candidate and expires within the bounded install window. SDK exceptions must use the existing value-free treatment (`C/s3-object-store.ts:136–138`).

Build steps are: clean exact commit checkout; frozen install in the pinned Ubuntu/Node/pnpm container; engine/ZSR/C/native builds; stage the closure from §2; verify with original checkout/store inaccessible; generate manifest; create sorted tar/gzip with fixed uid/gid, modes, epoch, gzip timestamp and no absolute build paths; independently re-read/hash and validate. Build twice in the reproducibility test and compare manifest/archive bytes. Source maps/provenance must not contain secret runner paths or inputs. Complete current license/runtime-pin/packaging checks before registration. No provider credential or runtime publication token is exposed to install/build scripts. Preserve a small public build receipt (source, IDs, protocols, sizes, check names); never archive the entire runner environment or a capability URL.

| Authority / name | Where required |
| --- | --- |
| Existing `CLOUD_WORKSPACE_S3_ACCESS_KEY_ID`, `CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY`, endpoint and bucket | CP only for this path. Scope to the Alpha bucket; application adapter enforces its runtime prefix. Do not claim R2 supports prefix-scoped token permissions without verification. |
| New `RUNTIME_BUNDLE_PUBLISH_TOKEN`; CP stores its digest | Protected Alpha publication job, only upload-ticket/register endpoints. No list/delete/general object API or database access. |
| New `RUNTIME_QUALIFICATION_DRIVER_TOKEN`; CP stores its digest | Protected post-release job, only run/evidence/cleanup operations on the configured fixture. Requires the real fixture bearer for starting/testing. |
| New `RUNTIME_CANARY_BROWSER_SESSION` | Protected Alpha qualification job only; a dedicated fixture session, never a maintainer's personal session. Provider credentials stay in CP's existing encrypted credential store. |
| `GITHUB_TOKEN` / `GH_TOKEN` provided by GitHub | Read exact parent run/source/artifacts with `contents: read`, `actions: read`. Keep existing feed-publish authority in its own job. |
| Existing `BOAT_API_KEY`, `BOAT_BILLING_ORG` | CP ordinary provider flow; separately the authorized manual base-build operator/job. Not in bundle build/publication or the canary driver. |

Workflow references establish the S3 credential **names**, not whether those secrets are populated: `scripts/release/cloud-provision.ts:8–9`, `scripts/release/workflows.test.ts:49–50`. `CLOUDFLARE_API_TOKEN` in hosted workflows is Pages/API authority, not S3 object-signing authority. No live secret inventory was performed. This design needs three new protected CI secrets, not general R2 keys or signing keys in CI. Do not repurpose `WORKER_CANARY_ADMISSION_TOKEN`.

### Release graph

Current Alpha has `ci`, parallel hosted/macOS work, and feed publication depending on `[ci, build, hosted]` (`.github/workflows/release-alpha.yml:61–114,333–347`). After Phase A removes the worker prerequisite from hosted promotion (`hosted-promotion.yml:154–157` in this checkout), use:

```text
ci -> runtime-build ----------------------> runtime-publish/register
ci -> hosted schema/API deployment -------> runtime-publish/register
macOS build + ci + hosted + runtime-publish/register -> Alpha feed publication
successful Release (alpha) completion -> separate runtime qualification workflow
runtime qualification -> qualification rows -> derived runtime head
```

`runtime-build` can start after CI alongside hosted/Mac work; `runtime-publish` waits for hosted so its API/schema exist. Add the fast artifact job to feed `needs`; it is bounded Linux compilation/upload/registration, with no Boat request, polling, lock, snapshot, qualification or model call. Start with a measured/bounded 30-minute build/upload budget and report actual duration; this design does not claim a measured latency. Failed artifact publication fails that release before feed publication. Failed or delayed qualification leaves the already-published release green and preserves the prior eligible runtime.

Register a channel-release candidate during publication, with `confirmed_at=NULL`. The separate qualifier confirms the successful parent run through GitHub metadata before setting it, then reserves its DB run. Qualification/finalization also requires that confirmation; failed/cancelled releases cannot become head from an uploaded artifact. First rollout can deploy schema/APIs and publish a bundle while new-workspace v4 selection remains disabled.

Add `.github/workflows/cloud-runtime-qualification.yml` with `workflow_run` for the exact current workflow name **`Release (alpha)`**, `types: [completed]`, `branches: [main]`, and an explicit success/repository/workflow-identity guard. Check out `workflow_run.head_sha`, not the child workflow's default `GITHUB_SHA`; verify the parent run/attempt/source and receipt before using secrets or artifacts. The protected Alpha environment and permissions match the credential table. `concurrency: runtime-qualification-alpha`, `cancel-in-progress: false`, is independent of release/hosted mutation groups. Skip an obsolete pending candidate before allocation when policy chooses to test only the newest; never label that skip a successful qualification. One VM runs cases sequentially. Timeouts always print the closed diagnostic and request ordinary cleanup; the DB sweep survives job cancellation. A narrowly scoped manual rerun takes an existing registered release identity and never rebuilds an image.

### Rare v4 base builds

Extend `B/boat-image.ts` with a separate `runtime-base-v4` profile and templates; keep the v3 default/CLI/receipts unchanged. The current kit requires a named `--from` and old-source preflight (`B/boat-image.ts:150–160,364–397`); the new profile must support a clean Boat stock Ubuntu base (provider create with no `from`) or an explicitly verified prior v4 base. It must not require a successfully promoted v3 worker. Preserve only the kit's local create idempotency, bounded owned process, budget, safe capture and cleanup mechanics; it need not invoke the release worker ledger.

The base owns apt-provisioned Linux tools/libraries needed by the existing namespace, ZSR, Git, SSH and Chromium paths; exact UID/group/subuid setup; base AppArmor/seccomp requirements; Bash/Python bootstrap; systemd units; tmpfiles; and compatibility/provenance metadata. Carry forward necessary OS dependencies from `scripts/cloud-workspace-validation/Dockerfile:37–56`, including the browser shared-library closure, and measure them on Ubuntu. No Zeros engine, provider SDK credential/cache, worktree, history, runtime grant or current pointer is baked. A platform-supplied Node/CLI is not trusted as the runtime. Optional pre-seeded runtime cache is deferred to avoid first-build ambiguity.

Use a new manual `.github/workflows/cloud-runtime-base.yml` or the same reviewed CLI run by an operator, never a dependency of release-alpha. Pin source and profile, require an explicit Alpha/test account and bounded hours/TTL, build once, and emit closed stage/check diagnostics. Before approving the compatibility ID, run boot/systemd/cgroup/UID/AppArmor tests and native ABI smoke with a digest-verified candidate archive in a disposable verification clone. The kit can invoke the same verifier library with an explicit offline test fixture; it does not add a shipped admission-bypass flag or launch credentialed engines. Sanitize/remove temporary runtime/test state, capture and cold-boot the final no-runtime snapshot, prove idle-host behavior and alias reconstruction, then register its immutable named-snapshot/build/compatibility identity. A base receipt is not an agent qualification.

Use `zeros-v2-test-base-v4-<version>` for test snapshot names and `zeros-v2-test-` for other nameable test resources. Keep the approved reusable base only when the implementation task explicitly authorizes retaining it; delete builder/verification VMs and failed snapshots through the kit and record IDs/outcomes. Never delete an old base referenced by a saved generation. Base compatibility review/registration is a rare operator action; runtime registration and real-turn qualification are the automatic release operations.

## 9. Eight implementation PRs

All branches use `cloud-v2/b<N>-<slug>`. Proposed migration numbers 0124/0125 must be reserved with the orchestrator before implementation to avoid other tracks. No PR enables ordinary v4 creation before B8 acceptance. Gating labels below expand to exact commands; run adjacent Vitest suites after each meaningful implementation edit and report actual results, including platform limits.

- **G:** `pnpm typecheck`, `pnpm lint`, `pnpm check:ui`, `pnpm test:git`, `pnpm check:secrets`.
- **CP:** `pnpm test:control-plane`, `pnpm --dir apps/control-plane typecheck`.
- **M:** `pnpm check:control-plane-migrations`, `pnpm check:migration-phases`; test expand migration against populated legacy rows and an empty Alpha-like fixture.
- **P:** `pnpm check:protocol` for wire/schema changes.
- **R:** `pnpm build:engine`, `pnpm check:runtime-pins`, `pnpm check:licenses`, `pnpm check:packaging-paths`; for containment changes add `pnpm check:zsr:contracts` and `pnpm check:zsr:runtime` on a supported secure Linux environment.
- **W:** `pnpm check:actions`; include release workflow graph tests. `pnpm check:web-deploy` applies if hosted/deployment wiring changes. No renderer, preload or Electron IPC change is planned; if scope expands, add its required checks. Engine lifecycle must also pass `pnpm smoke:engine` on macOS before that implementation ships; this Linux design session cannot claim that result.

### B1 — Add versioned runtime identities and immutable generation pins

Branch `cloud-v2/b1-runtime-contracts` — **M**. Depends on the agreed design and migration-number reservation.

Files: add `packages/protocol/src/cloud-runtime-bundle.ts` and `packages/protocol/src/__tests__/cloud-runtime-bundle.test.ts`; export through `packages/protocol/src/index.ts`; extend `packages/protocol/src/{containment.ts,cloud-agent-execution.ts}` with the runtime-profile union and fail-closed browser diagnostic tests; add `C/runtime-contract.ts`, `C/runtime-schema.integration.test.ts`, and `apps/control-plane/migrations/0124_cloud_runtime_registry.sql`. The migration includes §5 registry/base/channel/qualification metadata, nullable generation/engine/attestation identity groups, the second-stage continuation table, and immutable/identity triggers. Do not grant application qualification writes yet. Add the schema contract to `docs/cloud-workspace/runtime-bundles.md`.

Interface: canonical manifest/header, v4 runtime/attestation identity, v2 setup input/redemption/witness, and closed diagnostic enums. Keep these small shared data contracts in the existing protocol package; Python consumes the same golden fixtures, not a new runtime dependency. Tests first: legacy NULL/v3 rows still load; missing/partial/wrong base pins reject; v4 cannot enter old v3 fields; generation pin mutation and cross-org engine/attestation reject; duplicate keys/unknown fields/digest self-reference reject; current/min protocol differences explicit. Gates **G+CP+M+P**. Live: none; deploy expand schema only with v4 switches off after ordinary migration review. B2, B3 and B4 can begin in parallel against this contract; B5 can implement registry logic concurrently.

### B2 — Resolve the verified runtime root across engine and containment

Branch `cloud-v2/b2-runtime-root` — **L**. Depends on B1 contracts; no installer or live selection activation.

Files: add `E/agents/containment/cloud-runtime-root.mjs`, its `.d.mts`, and `E/agents/containment/__tests__/cloud-runtime-root.test.ts`. Change the active engine/adapter/transport/private-root files explicitly listed in §7, `E/cloud-runtime-registration.ts` and `E/agents/cloud-provider-execution.ts`; change the listed sandbox launcher/view/C/cgroup/setup/supervisor/profile/qualification files, including `S/start-engine.sh`, to accept the trusted root descriptor while preserving legacy defaults. Shared host copies import the same resolver source copied into `R/lib/zeros`; do not duplicate its policy. Add `scripts/__tests__/cloud-runtime-v4-containment.test.ts`; extend `cloud-runtime-projection-race.test.ts`, `cloud-setup-process.test.ts`, `E/agents/__tests__/cloud-provider-execution.test.ts`, and adjacent engine config/deployment-authority/adapter/capture tests.

Interface: trusted active-runtime descriptor, canonical R/W getters, delegated cgroup root, v4 profile-to-identity-map-v3 mapping, and v4 engine registration shape. Failing-first regressions: symlinked facade passed to a canonical guard; switch of current during launch; external/chained package links; nlink>1; forged environment root; profile inferred incorrectly from identical UID maps; host/agent/capture/coordinator cross-read; setup/engine descendants surviving parent exit. Keep local desktop and v3 tests. Gates **G+P+R**, plus relevant native C compile/namespace tests and the existing containment suites. Live: disposable Alpha/test VM containment smoke once B4 is available, with no model credentials; report native/macOS checks separately. Can build alongside B3/B4; coordinate only the resolver/attester/cgroup interfaces.

### B3 — Build a complete relocatable Linux runtime archive

Branch `cloud-v2/b3-runtime-bundle` — **M**. Depends on B1 manifest contract; integrates B2 helper output before final qualification.

Files: add `scripts/cloud-workspace-validation/runtime-bundle/{build.ts,manifest.ts,verify.ts,Dockerfile}`, `scripts/__tests__/cloud-runtime-bundle.test.ts`, and `scripts/__tests__/cloud-runtime-bundle-closure.test.ts`; add explicit commands to `package.json`; update `scripts/check-runtime-pins.mjs` and packaging/license inventory inputs only as the new artifact requires. Keep the legacy `scripts/cloud-workspace-validation/Dockerfile` and OCI publisher intact. If `tsup.config.ts` needs no output change, do not edit it.

Interface: one `.tar.gz`, canonical manifest, safe metadata receipt, exact Node/ABI/base requirements, deterministic per-file inventory and measured size limits. Tests: two builds same bytes in fixed toolchain; native load and provider binary resolution with the source/store unavailable; `.bin` relocation; workspace-package topology; source helper/PTY/Cursor/LSP/Chromium completeness; no credential/.git/.context/build-host path leakage; safe archive edge fixtures. Gates **G+R**, adjacent new suites, clean Ubuntu build/readback. Live: none required for assembly; B4 runs native compatibility on Boat. B3 runs in parallel with B2/B4, then rebases only on their finalized interfaces, not a shared dirty implementation tree.

### B4 — Build the v4 base and install verified runtimes atomically

Branch `cloud-v2/b4-base-installer` — **L**. Depends on B1; integrates B2 cgroups and B3 archive format.

Files: add `scripts/cloud-workspace-validation/runtime-base-v4/{boot.sh,dispatch.sh,install-runtime.sh,bootstrap.py,compatibility.json,zeros-boot.service,zeros-host.service,zeros.conf,zeros-cloud-engine.apparmor}`; add `B/runtime-base-v4.ts` and `B/templates/v4/{build.sh,attest.py,sanitize.py}`; change `B/boat-image.ts` and its README for profile dispatch and stock-base creation only. Add `scripts/__tests__/cloud-runtime-bootstrap.test.ts`, `scripts/__tests__/cloud-runtime-base-v4.test.ts`, Python extraction/crash fixtures under `scripts/cloud-workspace-validation/runtime-base-v4/tests/`, and extend `S/attest-cloud-worker.mjs` with the manifest/base/isolation v4 branch and closed diagnostic output. B2 owns shared path/cgroup plumbing; B4 owns final verification/receipt behavior.

Interface: fixed installer command and v2 stdin contract, bootstrap verifier/receipts, atomic current switch, offline boot/idle dispatcher and base registry receipt. Tests first: absent Node/current boot, crashes at every fsync/rename boundary, stale continuation/fence, corrupt/truncated/oversize/dangerous archive, insufficient disk, conflicting cached ID, root/link/mode violations, concurrency, engine retirement failure, pointer restore without old-generation authorization, signal/timeout diagnostic preservation. Gates **G+R**, Python stdlib tests, existing kit tests, actual systemd/namespace tests on Ubuntu. Live: build and cold-boot one named v4 test base, inspect final snapshot cleanliness, test installer on disposable clones, and clean builders/clones; no v3 worker lane. B4 can develop with B2/B3, but its live proof waits for both.

### B5 — Publish registry artifacts and admit exact v4 workspace runtimes

Branch `cloud-v2/b5-runtime-admission` — **L**. Depends on B1 and B4 fixed transport; consumes B2 attestation and B3 publication descriptor.

Files: add `C/runtime-registry.ts`, `C/runtime-artifact-store.ts`, `C/runtime-publication-routes.ts`, `C/runtime-registry.integration.test.ts`, `C/runtime-artifact-store.test.ts`, and `C/runtime-publication-routes.test.ts`; change `P/{config.ts,app.ts,index.ts,release-identity.ts}`, `C/{routes.ts,provisioning-profile.ts,provider-deployment.ts,setup-admission-broker.ts,boat-setup-runner.ts,daytona-setup-executor.ts,setup-materials.ts,setup-worker.ts,internal-routes.ts,agent-credentials.ts,agent-executions.ts}` and their adjacent tests. The existing profile owner is `C/provisioning-profile.ts:23–62`; extend that interface instead of introducing another profile layer. Change `S/consume-cloud-admission.mjs` and the v2 entry in `S/setup-cloud-workspace.mjs`. Add second-stage continuation handling, not edits to old migration-purpose checks.

Interface: separate artifact adapter, immutable register/select operation, create-time pin, two one-use redemption stages, v4 engine/readiness/witness comparisons, and shared v4 credential qualification predicate. Tests first: register conflict/create-only PUT/URL redaction; wrong protocol/base/kind/profile; pin stays fixed across head advance and idempotent create; recheck after org lock; lost-response/expired/replayed continuations; wrong boot/receipt/fence; SSH revoke failure overrides success; legacy v1 setup remains unchanged. Gates **G+CP+P+R**, setup/transport and race suites. Live: upload/register a fixture artifact and verify an ordinary unqualified v4 create rejects before allocation. The first live ready engine waits for B6's scoped candidate route; do not add a temporary unqualified-workspace bypass to test B5.

### B6 — Qualify candidate runtimes through normal staff workspace APIs

Branch `cloud-v2/b6-workspace-canary` — **L**. Depends on B5; no legacy canary orchestration changes.

Files: add `C/runtime-qualification.ts`, `C/runtime-qualification-routes.ts`, `C/runtime-qualification.integration.test.ts`, `C/runtime-qualification-routes.test.ts`, `C/workspace-delete-request.ts`, `C/workspace-delete-request.integration.test.ts`, `apps/control-plane/migrations/0125_cloud_runtime_qualification_runs.sql`, and `scripts/cloud-workspace-validation/runtime-bundle/qualify.ts` with `scripts/__tests__/cloud-runtime-workspace-canary.test.ts`. Wire private routes in `P/app.ts` and sweep startup/shutdown in `P/index.ts`; change candidate/run bindings in `C/routes.ts`, `C/agent-credentials.ts`, `C/agent-executions.ts`, plus the narrowly shared delete transaction described in §6. Reuse the existing browser-session service without modifying auth. Extend `docs/cloud-workspace/runtime-bundles.md` with fixture enrollment/renewal and cleanup.

Interface: §6 run/case state, expiring exception, normal authenticated driver, sealed real-turn evidence, constrained finalizer, durable cleanup. Failing-first tests: bootstrap with both qualification tables empty; global bypass denied; wrong org/user/device/runtime/kind/model/revision/command/fence; candidate expiry/revocation at lease renewal; forged/mock/partial result; normal command/lease correlation before sealing; no approval before cleanup; duplicate evidence conflict; runner death before/after create; cleanup limited to recorded workspace; all failures expose closed stage/check diagnostics. Gates **G+CP+M+P+R**, authorization/credential/command/reconciler suites. Live: enroll the dedicated Alpha fixture, complete real Claude/Codex/Cursor cases, confirm exact three qualification rows and automatic cleanup; no owner DB credentials. Develop driver/tests alongside B7, but do not run them against an incomplete B5 deployment.

### B7 — Publish bundles with Alpha and run qualification after release

Branch `cloud-v2/b7-runtime-ci` — **M**. Depends on B3/B5/B6 interfaces and Phase A release decoupling.

Files: add `.github/workflows/cloud-runtime-qualification.yml`, `.github/workflows/cloud-runtime-base.yml`, `scripts/cloud-workspace-validation/runtime-bundle/publish.ts`, and `scripts/__tests__/cloud-runtime-bundle-publication.test.ts`; change `.github/workflows/release-alpha.yml`, `scripts/release/workflows.test.ts`, `scripts/release/worker-workflow.test.ts` only where needed to assert independent graphs, and the runtime runbook. Phase A owns `hosted-promotion.yml` decoupling; B7 verifies it rather than restoring the worker dependency. Do not change the meaning of existing `cloud-runtime-publication.yml`.

Interface: exact-source build/receipt, least-authority upload/register token, parent release confirmation/order, protected post-release run, and manual base profile. Tests: failed/delayed canary never blocks hosted/feed; artifact publication failure does block feed; wrong parent/branch/repo/attempt/source rejects; checkout uses parent SHA; stale/out-of-order completion cannot regress head; secrets not passed to build scripts; timeout/cancellation diagnostic and cleanup; no Boat dependency or shared mutation concurrency in release graph. Gates **G+W+P**, release workflow suites and **CP** if release-identity wiring changes. Live: after explicit deployment/workflow authorization, observe one normal Alpha release and its separate qualifier; intentionally fail a new candidate and prove the release remains successful. B7 workflow/tests can be authored alongside B6 once request/receipt schemas are fixed.

### B8 — Preserve pins through lifecycle transitions and prove Alpha acceptance

Branch `cloud-v2/b8-runtime-lifecycle` — **M**. Depends on B2–B7 and Phase A hash fix; final enablement follows acceptance.

Files: change `C/{routes.ts,automatic-recovery.ts,provider-deployment.ts}` and their integration tests for same-base runtime upgrade, rollback/recovery pin copying and legacy coexistence; extend `scripts/cloud-workspace-validation/runtime-bundle/qualify.ts` with a separate explicit lifecycle acceptance mode; add `scripts/__tests__/cloud-runtime-lifecycle.test.ts`; update `docs/cloud-workspace/{runtime-bundles.md,qualification-status.md,provider-contract.md}` with verified results only. Verify the Phase A unequal-hash regression in `P/dev-agent-qualification.test.ts` and `P/dev-agent-qualification.integration.test.ts`; any missing fixture belongs in that coordinated A change, not a duplicate B fix.

Interface: explicit upgrade uses source base + later eligible runtime, wake/retry/recovery preserve pins, rollback checks checkpoint/state compatibility, and switch rollback affects new creation only. Tests first: configured base/head changes while A sleeps; recovery accidentally chooses current config; upgrade saves B once despite head C arriving; stale setup/engine registration cannot ready the new generation; failed upgrade preserves recoverable source; legacy NULL generations retain old behavior; v4 image with NULL pin fails closed. Gates **G+CP+P+R**, lifecycle/checkpoint/recovery suites; run required macOS engine smoke separately. Live: all §10 acceptance steps, retain only the authorized base/artifacts, report cleanup/resource IDs and enable new Alpha v4 only after success. This is the final integration PR; no parallel edits to B5's route/setup sections.

## 10. Alpha acceptance and negative tests

Run only after explicit authorization for implementation deployment/live resources. Use `pnpm agent:check` read-only before live work; never print credential values. The existing diagnosis reports 200 starts/day and roughly 531 compute hours available, not a reservation or ongoing guarantee (`.context/impl/steer-db-1.md:8–9`). Recheck ordinary quota/allowance/provider admission; one sequential canary plus disposable base verification is sufficient. No Beta/Production mutation or v3-lane repair is part of acceptance.

| Acceptance | Evidence required |
| --- | --- |
| Empty-state bootstrap | Start with no v4 approvals and no reliance on v3 approvals. Candidate fixture alone reaches v4 ready; ordinary users cannot select the unqualified runtime or obtain its credentials. |
| Base and layout | Cold-boot approved named v4 base with no current runtime; tmpfiles creates `/zeros`; boot and idle host work without candidate Node. Install A and verify the exact facade/R, UIDs, mounted source, AppArmor/cgroup checks and value-free installation receipt. No private state or admission survives the saved base. |
| Real qualification | Three actual provider cases pass tool/file/MCP, conversation resume, permission, stop/revoke checks through a normal ready engine. Registry has exactly the tested kind/profile/base-compatibility approvals with sealed evidence; untested API-key kinds and native capabilities remain disabled. Cleanup is confirmed. |
| Ordinary staff create | After A is qualified, create a second ordinary Alpha staff workspace without a candidate run ID. It pins A transactionally, installs it, registers and runs Claude, Codex and Cursor using ordinary credential grants. The first canary result is not the sole proof of product admission. |
| State/history baseline | In that disposable workspace, create known file content, uncommitted/staged changes and provider conversations. Record bounded file/tree digests, local engine schema/checkpoint version, conversation/native-binding IDs and non-secret message counts; verify no secret transcript in CI artifacts. |
| Sleep/wake | Stop and resume through normal APIs. Require identical generation/runtime/base IDs and preserved files/Git/history, with fresh setup/boot/supervisor/engine authority. Reattach and continue the provider conversations; no background head lookup can change A. |
| Later release, same base | Publish/qualify B from a later source without any Boat image build/capture. A remains pinned while asleep. Explicitly upgrade the ordinary workspace: new generation pins B, provider create uses the **identical saved base image reference/build**, B is installed, files/Git/native history survive checkpoint transfer, and all three providers work. Record A/B runtime IDs, common base identity and provider operations proving no new image was built. |
| Pointer versus generation semantics | On a replacement VM, previous may be absent until that VM has two installations; retained source-generation pins provide rollback authority. Separately exercise local interrupted switch/reconciliation on an installer fixture. Never treat a restored previous pointer as permission to register an old engine against B. |
| Failed candidate/release independence | Publish candidate C and cause a named closed qualification failure. Alpha release/feed and hosted deployment succeed; C has no complete approval matrix; ordinary new workspaces choose the newest eligible qualified runtime, and existing A/B pins do not change. |
| Ordered selection/revocation | Complete older/newer release cases out of order, deploy an incompatible protocol fixture, and revoke a candidate/qualification. Check deterministic head, no silent incompatible selection, rejection at delivery/renewal, and safe cleanup without implicit pin migration. |
| Compatibility/rollback | Integration fixtures cover v1–v3 NULL runtime pins and old setup commands. On a disposable compatible checkpoint, v4 rollback uses the saved runtime/base; incompatible state schema fails closed. Turning new-create selection back to legacy does not strand existing v4 generations. No live other-channel workspace is needed. |
| Final cleanup | Delete test workspaces and ephemeral devices/delegations through normal APIs, drain active processes/leases, delete failed/unneeded test snapshots and temporary objects through their authorized owners, and record confirmed IDs/outcomes. Keep only explicitly authorized reusable base and content-addressed release artifacts. Report storage-retention progress truthfully. |

Mandatory negative automation includes archive traversal/absolute paths, duplicate names/JSON keys, link chains/cycles, hard links, PAX overrides, device files, setuid/capabilities, extra inventory entries, ABI/profile/base/digest mismatch, staged writable ancestry, insufficient space, lost download/SSH reply, expired material continuation, wrong boot/receipt, stale fence, simultaneous installs, death before/after current rename, failed cgroup drain, and missing inner diagnostic. Assertions are both “no unverified process/credential launch” and “an exact closed failed check is observable.” Database races cover create versus qualification/revocation, wake versus head advance, registration versus generation retirement, and finalization versus cleanup/candidate expiry. Existing engine/Git/containment suites remain acceptance gates, not substitutes for the live three-provider path.

## 11. Deferred work, risks and decisions still needed

- **Explicitly deferred:** signing/key rotation and supply-chain hardening, chunked CAS/dedupe, automatic runtime/base GC and retention drills, in-place live upgrades, fleet-wide rollout/rollback automation, artifact mirroring/CDN, public API/CLI/MCP and billing changes. These are not reasons to repair the disabled v3 worker lane.
- **Other tracks:** Phase A fixes image-versus-source hash semantics and release decoupling. Phase C owns first-build-required UX, root organization recipes/protected-file validation, reusable organization images, stopped templates and real provider forks. Phase D owns the admin-agent configuration workspace. Phase E is the workspace parity pass: terminals, SSH, previews/forwarding, one-way file sync, 10-minute idle behavior and staff collaboration. B preserves their runtime paths and essential smoke coverage; it does not claim the complete parity pass or launch-hardening work.
- **Measurements still required:** actual Boat libc/systemd/kernel/controller behavior, native binary/browser shared-library closure, compressed/expanded archive and temporary disk use, cold download/verify/ready latency, and stop/resume persistence of the no-runtime base. Expected ABI 127 and inferred glibc 2.39 must become measured receipt fields. A failing base assumption requires a new compatibility contract, not a weaker attester.
- **Fixture provisioning:** orchestrator selects the exact Alpha staff user/org/team, test repository/installation and current per-kind model consents; verify Claude setup token, Codex ChatGPT cache and Cursor key are actually available. The investigation established no credential inventory for this design. Session re-enrollment before its 30-day expiry is an internal operational requirement; expired credentials produce explicit failures and preserve prior head.
- **New secrets and schema ownership:** approve/configure the three protected secrets named in §8 through the existing operator process when implementing; none was read or set here. Reserve migration numbers with parallel tracks and review the definer function's least privileges. No new npm dependencies are proposed; if closure tooling cannot be built from existing dependencies/stdlib, ask the orchestrator before adding one.
- **Performance and trust limits:** full verification costs I/O on boot and attestation, and replacement-VM upgrades cost a download/checkpoint cycle; measure before adding caches. Hash/admission authority cannot defend against compromised CI/CP/provider/root. A fixture session in protected CI has that dedicated account's normal privileges, so keep its membership/data limited. API support for saved v4 pins must remain deployed during rollback; switching new creates alone is not a code rollback plan.
- **Artifact availability:** keep every referenced base/runtime object available for wake/recovery; there is no automatic deletion in B. A qualified artifact that later becomes unavailable fails delivery with a closed check, not a fallback to another runtime. Package redistribution/license checks and R2 conditional upload/size behavior are build/publication gates, not assumptions to waive.

Validation performed for this design: repository/source/reference reads, the Alpha diagnosis supplied by the orchestrator, scoped literal/profile inventory, and report consistency checks. No implementation, test/build execution, live query, credential read, workflow dispatch, provider mutation, commit or PR was performed. All tests and live steps above are proposed implementation gates, not claimed results.
