# Cloud runtime bundles and registry

V4 separates the immutable engine runtime from the Boat base image. The schemas
in [cloud-runtime-bundle.ts](../../packages/protocol/src/cloud-runtime-bundle.ts),
migration `0124_cloud_runtime_registry.sql`, and their tests are authoritative.
This is the internal Alpha contract. The control plane implements OIDC
publication, base registration, and staff registry operations. It selects and
pins runtimes at creation, admits installation, and binds redemption,
registration and readiness to that pin. The base installer, qualification workers
and generation upgrade/recovery services have their own implementation boundaries.

## Identity and installed layout

`manifestSha256` is lowercase SHA-256 of the **original canonical UTF-8 manifest
bytes**. `runtimeId = "r1-" + manifestSha256`. The manifest contains neither value.
`archiveSha256` and `archiveBytes` describe the exact gzip bytes separately.
`baseCompatibilityId = "bc1-" + sha256(raw compatibility.json bytes)` identifies
the bootstrap/isolation contract, including protected base files and ABI needs.
Boat snapshot metadata and the base builder commit are separate provenance.

The immutable runtime is `R=/opt/zeros-infra/<runtimeId>`. `R/bin` contains Node
and launchers; `R/worker` retains the existing worker-relative payload layout;
`R/lib/zeros` contains runtime helpers. The root-owned tree has no group/other
write bits and regular files have one link. `/opt/zeros/current` selects R;
`/opt/zeros/{bin,worker,manifest.json}` point through it, with a `previous`
pointer for explicit rollback. `/zeros` is a facade for `/opt/zeros`. Writable
sessions, logs, state and receipts live outside R. The base-owned bootstrap is
under `/opt/zeros-bootstrap`; its worker marker is version 4.

## Shared documents

Every object is strict: additional fields reject. Digests are 64 lowercase hex
characters, source commits are 40 lowercase hex characters, byte counts are safe
integers, and dates are RFC3339. Shared document schemas and exported types are:

| Document / type                                              | Required fields                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeManifest` (`zeros.runtime-manifest/v1`)              | `agents` (Claude CLI/SDK, Codex package, Cursor SDK versions); `entrypoints` (`node`, `setup`, `startEngine`, `supervisor`; optional `selfTest`); typed `files`; `platform` (`arch:x64`, `libc:glibc`, `minGlibc`, `node`, `nodeModulesAbi`, `os:linux`); `protocols` (`bootstrap:1`, `engine`, `setup:2`); `source` (`commit`, `lockfileSha256`) |
| `RuntimeDescriptor`                                          | `runtimeId`, `manifestSha256`, `archiveSha256`, positive `archiveBytes`, `expandedBytes` (sum of regular-file sizes), `sourceCommit`, `nodeModulesAbi`, `bootstrapProtocolVersion:1`, `engineProtocolVersion`                                                                                                                            |
| `RuntimeInstallInput` (`zeros.runtime-install/v1`)           | `purpose:workspace-setup\|build\|qualification`, `runtime:RuntimeDescriptor`, `artifact:{url,expiresAt}`; `setup` is required only for `workspace-setup` and forbidden for the other purposes                                                                                                                                            |
| `RuntimeInstallReceipt` (`zeros.runtime-install-receipt/v1`) | `archiveSha256`, `baseCompatibilityId`, `bootstrapVersion:1`, `expandedBytes`, `fileCount`, `installedAt`, `manifestSha256`, `runtimeId`                                                                                                                                                                                                 |
| `ActiveRuntimeDescriptor` (`zeros.active-runtime/v1`)        | `baseCompatibilityId`, kernel `bootId`, `cgroupRoot`, `installerReceiptSha256`, `manifestSha256`, `root`, `runtimeId`, `supervisorSessionId`                                                                                                                                                                                             |
| `BaseCompatibility` (`zeros.base-compatibility/v1`)          | `arch:x64`, `artifactHostSuffixes`, `bootstrapProtocolVersion:1`, `glibc`, `os:{id,versionId}`, `protectedFiles:{mode,path,sha256}[]`, `supportedManifestSchemas`, `systemdMin`, `uids:{agent:10001,capture:10002,coordinator:10004,engine:10003}`                                                                                       |
| `RuntimeBaseStatus` (`zeros.base-status/v1`)                 | `baseCompatibilityId`, `bootId`, nullable `currentRuntimeId`, `hostState:idle\|waiting_for_runtime\|stopped\|failed`                                                                                                                                                                                                                     |

Archive bytes are 1 through 2 GiB; expanded bytes and the sum of regular-file
sizes are 1 through 4 GiB. Individual regular files may be empty.
`nodeModulesAbi` and engine protocol versions are integers from 1 through 65,535.
Agent versions follow `^[0-9A-Za-z][0-9A-Za-z.-]{0,63}$`; Node retains its version
format. Every listed entrypoint must name a regular inventory file. `selfTest`
is omitted when its runtime self-test file is absent. Receipt `fileCount` counts
only regular files, with the same expanded-byte total.

The manifest is recursively sorted by ASCII object key, with JSON.stringify's
minimal escaping, no whitespace or trailing newline, and no build timestamps,
hostnames, absolute build paths or run IDs. Inventory paths sort by UTF-8 byte
order and are unique. Entry types are `dir:{mode,path}`, `file:{mode,path,sha256,size}`
or `symlink:{path,target}`. Manifests have at most 250,000 entries and 64 MiB of
original UTF-8 bytes. Paths and symlink targets have at most 4,096 UTF-8 bytes,
without NUL, backslash, CR or LF. Paths are normalized relative POSIX paths: no
empty, `.` or `..` segments, absolute/drive paths or malformed Unicode.
Modes are four-digit octal without special bits or group/other write. Symlink
targets are relative and must remain inside R both lexically and after resolving
links in at most 64 symlink substitutions, including the initial link. Link
cycles and inventory entries under a file/symlink reject.
`manifest.json` is the sole inventory exclusion. The builder/installer must also
compare the inventory with the complete archive and extracted tree.

`parseCanonicalManifest(rawBytes, expectedManifestSha256?)` hashes the supplied
bytes, optionally compares an admitted digest, validates canonical tokens
(including duplicate keys and encoding), then validates the document. It returns
`{manifest,manifestSha256,runtimeId}`. It never re-serializes the manifest for
verification. `runtimeIdFromManifestSha256` validates and derives the ID.

The archive is deterministic POSIX ustar/pax tar with gzip level 9, gzip mtime 0
and no filename. `manifest.json` (0444) is first, followed by inventory order.
Headers use uid/gid/mtime 0 and empty user/group names. Only per-entry PAX
`path`/`linkpath` records are allowed, with at most 16 KiB per PAX payload; no
global PAX, hard links, devices, FIFOs, sparse files, xattrs, ACLs or capabilities.
Producers use symlink header mode 0777 or 0555; consumers ignore those mode bits
and validate the symlink type and target confinement.

## Installer, runtime root and probes

The fixed command is `/usr/bin/flock --exclusive --nonblock /run/zeros/setup.lock
/opt/zeros-bootstrap/install-runtime.sh --stdin`. Input is base64url JSON,
bounded to 64 KiB **before decoding**. The schema also rejects documents whose
shortest encoding exceeds that bound. Artifact URLs require HTTPS; the installer
must additionally enforce the base's host allowlist and an expiry of at most
15 minutes. URLs and nested setup material must never enter logs or persistence.

Installation and pointer selection happen before the existing one-use admission
redemption. For workspace setup the installer invokes R's setup helper with the
unchanged nested `setup` string on stdin. There is no continuation redemption.
Exit 0 means installation and, for workspace setup, the helper both succeeded.

Receipts live at `/srv/zeros/runtime-installs/<runtimeId>.json`;
`installerReceiptSha256` hashes their original bytes. The root-owned 0600 active
descriptor is `/run/zeros/active-runtime.json`; the engine receives a read-only
projection. Its root must be exactly `/opt/zeros-infra/<runtimeId>`, and its
cgroup must be under `/sys/fs/cgroup/`. Runtime-root consumers read this verified
descriptor, rather than choosing a root from environment variables.

The base status probe is `/usr/bin/sudo -n /usr/bin/python3 -I
/opt/zeros-bootstrap/bootstrap.py status` and emits one `RuntimeBaseStatus` JSON
line. The root supervisor starts through `zeros-host.service` and the base
dispatcher. Runtime self-test is `R/bin/node R/lib/zeros/runtime-self-test.mjs` and
emits a qualification diagnostic. These executable entrypoints belong to their
runtime/base implementation changes.

`ClosedDiagnostic` (`zeros.diagnostic/v1`) contains only `component`, `stage`,
`ok`, nullable `exitCode`, `timedOut`, and deduplicated `failedChecks` (at most 32).
Components are `bundle`, `publication`, `base`, `bootstrap`, `installer`,
`attester`, `setup`, `qualification`, `cleanup`, `build`. Stage/check names are
bounded snake_case constants; component owners define their enums. Installer
names are explicitly checked against `RuntimeInstallerStageSchema` and
`RuntimeInstallerCheckSchema`, including the download, verification, extraction,
receipt, pointer, host and setup phases, plus `lock_busy`, `base_compatibility`
and `cgroup_retired`. The installer reports a nested setup failure as stage
`run_setup`, check `setup_exit`; the setup helper emits its own diagnostic. An
installer diagnostic cannot forward a setup check such as `generation_pin`.
Diagnostics cannot include free text, paths, URLs, stderr or exception fields.

## Registry, pins and authority

The registry has five tables: base compatibility contracts, approved Boat base
images, runtime bundles, ordered channel releases, and per-runtime/base/
credential-kind v4 qualifications. Channel ordering is the parent release run
number, separate from run ID and attempt. The five credential kinds remain
`claude-api-key`, `claude-setup-token`, `codex-api-key`, `codex-chatgpt`, and
`cursor-api-key`. Qualification `evidence` is a required JSON object bounded to
64 KiB; contract/header objects have the same bound and native capabilities are
bounded to 16 KiB. There are no per-provider real-turn case or continuation
tables. Smoke scheduling uses the separate run and provider journals below.

For internal Alpha, the control plane inserts qualification evidence itself
(AB-2, for example `{mode:"smoke",checks:[...]}`). All registry tables have enabled
and forced RLS with only `app_is_system()` policies. The broad `zeros_app` DML
grants inherited from migration 0004 remain; **restrictions are enforced by RLS
and triggers, not column grants**. Tenant contexts cannot read or write these
rows. System writes cannot delete them or change identity/evidence. Only
`revoked_at` is mutable; channel releases additionally permit their initial
`confirmed_at`. Those timestamps cannot later be cleared or changed.
Qualification `enabled`/`mcp_qualified` can only move to false while revoked;
revoked qualifications must have both false. Native capabilities are immutable.
The v3 qualification/operator write boundary remains unchanged.

Generations carry the nullable six-column group `runtime_id`,
`runtime_manifest_sha256`, `runtime_base_image_id`, `runtime_base_compatibility_id`,
`runtime_profile`, `runtime_engine_protocol_version`: all NULL or all present.
Composite foreign keys bind runtime/digest and base image/compatibility. A
registered v4 base's image ref requires a pin. The pinned base must match the
generation's provider, source commit, architecture and storage. The generation's
image ref must equal the base's registered ref or match
`^boat-template:[A-Za-z0-9_-]{1,128}$` for an org template fork. Phase C's
`cloud_workspace_computer_sources` sidecar validates template/build and org
provenance; this guard only admits the ref format. The protocol must match its
bundle. The six columns are immutable after insert, including NULL-to-v4 updates.

Engine instances and setup attestations carry those columns plus
`runtime_installer_receipt_sha256`, UUID `runtime_boot_id`, and UUID
`runtime_supervisor_session_id` (all nine NULL or all present). Engine identities
must equal their exact workspace/org/generation pin. Starting engines receive
all nine fields at setup redemption. Their registration grant retains purpose
`setup`, bound to the same workspace, org, generation, account, setup run and
execution fence. Insertion and transitions to ready require a live, unrevoked
grant; becoming ready also requires consumption. Later heartbeats and retirement
can outlive the registration grant. V4 engines cannot carry the v3
`agent_runtime_profile`/`agent_runtime_contract_sha256` columns. An attestation
must match the exact engine's pin, receipt, boot, session and setup fence, while
retaining the existing live setup/engine readiness checks. Engine pins/witnesses
and every setup attestation are immutable after insertion.

NULL pins continue to mean legacy, never “latest”. Old rows are not backfilled.
Revoked registry records remain referenced for audit and retirement. Explicit
upgrades and copying pins across generation transitions belong to the lifecycle
services; the registry schemas grant none of that authority. Browser diagnostics accept v3 and v4
profiles, with missing/unknown reports unavailable. Shipping capture Chromium
does not qualify native provider Browser access.

The shared [plain JSON fixtures](../../packages/protocol/src/__tests__/fixtures/cloud-runtime/)
include `cases.json` with each file's contract and validity; manifest cases also
record the digest of their exact bytes. TypeScript and the Python bootstrap can
consume the same inputs. Database behavior is covered by
[runtime-schema.integration.test.ts](../../apps/control-plane/src/cloud-workspaces/runtime-schema.integration.test.ts)
against a disposable PostgreSQL 18 database with `TEST_DATABASE_URL` set.

## Publication and operator API

Publication is disabled by default and can be enabled only on Alpha. The
control plane verifies GitHub Actions OIDC with `jose` and a cached GitHub JWKS
at `https://token.actions.githubusercontent.com/.well-known/jwks`. It requires
RS256, issuer `https://token.actions.githubusercontent.com`, the configured
audience, a case-insensitive repository match, `ref=refs/heads/main`, an exact
`workflow_ref`, and the configured environment. Runtime publication accepts
only the `release-alpha.yml` workflow with event `push`; base registration
accepts only `cloud-runtime-base.yml` with event `workflow_dispatch`. Each
workflow ref includes the configured repository and `@refs/heads/main` suffix.
Run ID, number, attempt and source SHA come from verified claims. Body run
values and runtime/base source commits must agree with those claims.
Issued-at times may be at most 60 seconds ahead of the control plane's clock;
token expiration remains enforced independently.

| Environment variable | Default / behavior |
| --- | --- |
| `CLOUD_RUNTIME_PUBLICATION_ENABLED` | `false`; the three CI endpoints return 404 before auth or database work |
| `CLOUD_RUNTIME_OIDC_AUDIENCE` | `zeros-control-plane-<deployment channel>` |
| `CLOUD_RUNTIME_OIDC_REPOSITORY` | `Withso/zeros`; its spelling also determines the exact workflow ref |
| `CLOUD_RUNTIME_OIDC_ENVIRONMENT` | `alpha`; an explicit empty value disables the optional environment check |
| `CLOUD_WORKSPACE_NEW_RUNTIME_PROFILE` | `legacy`; `legacy\|v4` is reported in release identity; workspace selection is implemented separately |

Enabling publication requires the existing CP-held
`CLOUD_WORKSPACE_S3_ENDPOINT`, `CLOUD_WORKSPACE_S3_BUCKET`,
`CLOUD_WORKSPACE_S3_ACCESS_KEY_ID`, and `CLOUD_WORKSPACE_S3_SECRET_ACCESS_KEY`.
`CLOUD_WORKSPACE_S3_REGION` defaults to `auto`. These credentials stay on the
control plane; GitHub receives only an expiring upload capability. This block
can be configured independently of workspace provisioning and ciphertext
encryption keys. The endpoint must be an HTTPS origin without credentials,
path, query or fragment.

The separate runtime artifact adapter uses only
`runtime/v1/<runtimeId>/<archiveSha256>.tar.gz` in that bucket. It does not use
`CLOUD_WORKSPACE_S3_KEY_PREFIX` or workspace ciphertext deletion/encryption
semantics. `presignCreatePut(objectKey, bytes)` signs `If-None-Match: *` and the
exact `Content-Length`, and returns the required headers. The caller must send
every returned header unchanged. PUT capabilities expire after 900 seconds;
`presignGet(objectKey, ttlSeconds)` permits 1–900 seconds. `head(objectKey)`
returns only existence and validated byte length. URLs never enter database
rows, diagnostics, errors or logs. Existing object bytes cannot be replaced
through a publication capability.

`createRuntimeArtifactStore({s3})` returns the adapter or null when S3 is not
configured; `runtimeArtifactObjectKey(runtimeId, archiveSha256)` validates and
constructs its key. A missing object returns `{exists:false,bytes:null}`.
`index.ts` constructs one runtime artifact store from the CP-held S3 config and
passes it into the publication routes. Workspace runtime setup can consume the
same instance separately.

All three CI endpoints accept strict JSON, use
`Authorization: Bearer <GitHub Actions OIDC JWT>`, return `Cache-Control:
no-store`, cap requests at 192 KiB and return closed error codes. Existing
maintenance and controlled-migration barriers still apply.

| Endpoint | Request and result |
| --- | --- |
| `POST /internal/v1/runtime-bundles/publications` | `{descriptor, manifestHeader, releaseOrder, githubRunId, githubRunAttempt}` → `{objectKey, upload:{url,expiresAt,headers}\|null}`. `manifestHeader` is the manifest without `files`; `upload` is null only when HEAD reports the exact advertised size. No registry row is inserted. |
| `POST /internal/v1/runtime-bundles/publications/complete` | **The same full request** → `{runtimeId,registered:true}`. The endpoint is stateless: it needs neither a prior call nor pending metadata. It revalidates descriptor/header/claims, HEADs the derived key, requires exact bytes, then inserts or validates the bundle and Alpha channel release atomically in system context. |
| `POST /internal/v1/runtime-bases` | `{baseImageId,imageRef,sourceCommit,imageBuildSha256,storageMib,compatibilityRawB64,compatibilitySha256,compatibility?}` → `{baseImageId,baseCompatibilityId}`. `imageRef` uses `boat:<snapshot>@sha256:<imageBuildSha256>`. Canonical standard base64 decodes to at most 64 KiB of strict UTF-8 JSON; SHA-256 covers those original bytes. An optional parsed `compatibility` echo must agree with them. Contract and approved base image are inserted atomically. |

The descriptor's runtime ID must equal `r1-<manifestSha256>`, its header source,
ABI and protocol fields must agree, and registry byte counts must be positive
safe integers. An exact replay preserves registration, approval and
confirmation timestamps; conflicting immutable identities return 409. Missing
or short/long artifacts cannot register a bundle. Completion sets the parent
release's `confirmed_at` only once; the publishing job must run after hosted
promotion succeeds. An identical rerun with the same run ID and number may
use an equal or later verified attempt, preserving the first stored attempt
as provenance, the release order and all registration timestamps. Completion
retries smoke enqueue after a lost response or post-commit scheduling failure.
An attempt older than the first stored attempt, different content/run/order,
or a revoked identity still conflicts. A later release run may reference an
identical bundle. Registration does not verify archive contents by downloading them;
the installer verifies the archive and manifest digests before execution.

After commit, completion calls the injected runtime-smoke enqueue hook. With
`CLOUD_RUNTIME_QUALIFICATION_ENABLED=false` it creates no qualification. With
the worker enabled, enqueue deduplicates pending runs and rechecks revocation.
Scheduling failures return a closed 503 after registration; retrying completion
preserves the committed identity and retries the hook. A registered runtime
alone is never a qualified channel head.

Staff endpoints use ordinary account authentication and the server's current
`developer` or `platform_owner` role. `support_admin` and ordinary users receive
404. These routes remain usable when CI publication is disabled:

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/internal/cloud-runtime/status` | Lists up to 100 bases, the last 20 runtimes, their kind/profile/approval/MCP/evidence-mode/timestamp metadata, the current channel's last 20 releases, and the last 20 qualification runs with closed diagnostics and cleanup timestamps. It lists releases until the separate selection service supplies channel-head eligibility. |
| `POST /v1/internal/cloud-runtime/runtimes/:runtimeId/requalify` | Queues an explicit smoke retry and returns HTTP 202 with `runtimeId`, `runId` and `status:queued\|running`. Concurrent requests reuse the pending run. Disabled workers return a closed 503; unconfirmed or revoked runtimes reject. |
| `POST /v1/internal/cloud-runtime/runtimes/:runtimeId/revoke` | Sets the bundle and all its qualifications' `revoked_at`, disables qualification/MCP approval, preserves existing revocation timestamps, and emits an audit line with only runtime ID and acting staff role. Registry identities and saved pins remain intact. |

`GET /v1/release-identity` retains all v1 fields and readiness behavior. Optional
`runtimeV4` metadata reports the configured new-workspace profile, newest
approved non-revoked base ID/compatibility/source, newest registered runtime
ID/source/revocation, and enabled/MCP-qualified/smoke kind counts for that
runtime/base pair. It exposes no credentials or qualification evidence. An
unreadable registry omits that optional metadata; unfinished qualification
cannot delay existing release readiness.

Local verification uses the artifact/OIDC/route suites, including the
database-backed publication suite with `TEST_DATABASE_URL` pointing at a
disposable PostgreSQL 18 database. Live OIDC publication belongs to the Alpha
CI integration, and disposable-VM smoke qualification belongs to its worker.

## Runtime smoke qualification

`CLOUD_RUNTIME_QUALIFICATION_ENABLED` defaults to false. The worker runs only
on Alpha with managed Boat and the shared runtime artifact store configured.
It follows the existing background-worker pause and maintenance barriers; its
startup does not depend on workspace setup being enabled. Qualification mode
remains a separate admission setting: Alpha must select `smoke` to admit smoke
evidence. The default `full` admits none of these smoke approvals.

Publication completion and staff retries enqueue durable runs. A 30-second tick
also discovers the newest confirmed, unrevoked, unqualified runtime for the
current approved base compatibility. The database permits one running smoke
globally, including runs awaiting cleanup. Each claim selects the newest
approved, unrevoked Boat base and records a 25-minute deadline. A failed run is
not retried automatically for the same runtime/base compatibility; staff may
retry explicitly. The claim transaction also prepares the builder allocation
intent, so an expired claim cannot be marked cleaned while a suspended worker
can still dispatch an unjournalled create.

The worker creates `zeros-v2-qual-<runtime-short>` with a 30-minute provider TTL,
waits up to 12 minutes for bootstrap to report `idle` or `waiting_for_runtime`,
and installs with `purpose:qualification`, a descriptor and an artifact GET
capability lasting at most 15 minutes. Cloud Computer builds use the same wait:
Boat readiness can precede lazy image hydration, persistent binds and host startup.
Nonzero, timed-out or malformed status probes are retried; a parsed `failed`
state or the deadline fails closed. Installer input travels only on pinned SSH
stdin. The installed runtime must report idle with the exact runtime and base
identity before the worker invokes its self-test.

`runtime-self-test.mjs` selects R only through the active runtime resolver and
checks the original manifest and receipt bytes against that descriptor. It runs
with a private HOME, minimal environment and a disconnected network namespace
(loopback is enabled only inside that namespace). Its closed checks are
`node_abi`, `sqlite_query`, `pty_load`, `claude_version`, `codex_version`,
`cursor_load`, `engine_load`, `supervisor_idle` and `containment_smoke`.
Containment uses the existing credential-free `qualify-cloud-engine.mjs`
through R's fixed engine launcher, including identity, workload, capture,
human-service and actor-tool probes. Before launch, the self-test creates the
worker-owned workspace if missing and the root-owned empty mount points under
`/srv/zeros/files`. Existing workspace contents are preserved. These paths use
the existing image-layout ownership and modes, are
created directly at their final paths, and are revalidated by the launcher.
The logical data paths may be bind mounts from `/home/user/.zeros-persist`.
No directory is renamed and R is unchanged. Workspace setup's v4
attester is a separate boundary. The runtime bundle must include this helper and list
`entrypoints.selfTest`; a bundle built before it was included fails closed.

Approval happens only after confirmed VM deletion. Success inserts the five
credential-kind rows (`claude-setup-token`, `codex-chatgpt`, `cursor-api-key`,
`claude-api-key`, `codex-api-key`) for the runtime/base compatibility and
`zeros-cloud-worker-v4`. Evidence records `mode:smoke`, the completed check
inventory, base image ID, run ID and timestamp. These checks use no model
credentials and do not prove a per-kind model turn or an MCP round trip;
`mcp_qualified` stays false and native capabilities stay empty. Existing
immutable qualification evidence is never overwritten or re-enabled by retry.

Credential discovery reports `runtimeQualified` for basic turns, plus independent
`mcpQualified` and optional versioned `nativeCapabilities` metadata per delegation.
For v4, a smoke-only delegation is usable only when its exact live engine has
recorded `agentCustomizationVersion: 3` during registration. Registration verifies
the pinned runtime, manifest, base and installation witness before persisting
`cloud_workspace_engine_instances.agent_customization_version`. Absence is
unknown support; neither the v4 profile nor the smoke qualification date proves
that an old engine can request optional customization.

Discovery returns the stable boolean `runtimeUpgradeRequired` for a v4
delegation that has basic runtime qualification but cannot run because its
engine lacks this capability and its credential kind lacks MCP proof. The
renderer excludes that grant's models, shows “Update the cloud runtime to use
agents” and blocks Send and Enter while preserving the draft. A provider remains
usable if another matching grant qualifies. Runtime update controls can use
`delegations.some(grant => grant.runtimeUpgradeRequired)` from the existing
prepare/discovery response; no credential material is involved. Missing or
retired engines do not inherit the previous engine's capability.

Legacy v3 gateways still require MCP in discovery because they always request
required customization.
The empty native capability object in a smoke row is absence of proof and is
omitted from execution and renewal responses. Revoked, mismatched, disabled or
wrong-mode qualifications still reject. Marked computer administration workspaces
continue to require MCP proof because their purpose requires the computer tools.

V4 engines request customization version 3: use the same encrypted snapshot and
history as version 2 when MCP is qualified, or explicitly continue a basic turn
without user MCP and organization skills when it is not. Versions 1 and 2 remain
required requests and never downgrade. Replay cannot gain or lose an admitted
snapshot; renewal of a customized execution still requires MCP qualification.
The composer describes unavailable features, and goals, review and native fork
remain gated by their independent capability flags. Smoke success never grants
these flags and is not evidence of a real provider turn.

Deploy migration 0131 and the control-plane reader before a runtime containing
the version-3 client and its registration capability.
Existing pinned runtimes retain their old required-customization behavior until
an explicit runtime upgrade; merely restarting them does not install this fix.
Previously built v3-capable engines without the registration field are also
unproven and need an explicitly upgraded bundle. Existing rows are not backfilled.
No qualification rows need to be rewritten for basic turns. Enabling MCP or
native features requires separate per-kind evidence and a new qualified runtime
identity under the immutable registry contract; rerunning today's smoke worker
cannot upgrade existing evidence. Keep full-mode deployments closed until that
evidence exists.

Failures retain only a closed diagnostic and insert no qualifications. A
crashed run is reconciled after its deadline: recover the sandbox identity from
the provider journal, delete it, verify the deletion receipt and a subsequent
404, then mark the run failed. A receipt may be `completed`, or `blocked` at
`waiting_for_uploads`, `kept_for_newer_snapshots` or `waiting_for_restore` with
the sandbox absent. The latter proves compute release while storage remains
pending; it does not prove storage erasure. Unknown stages, `pending`/`processing`
operations and still-visible sandboxes never confirm builder deletion.
A seven-minute cleanup lease prevents concurrent
reconcilers. Unconfirmed cleanup keeps the running slot occupied. A lost create
reply is recovered with the original idempotency key and exact request; replay
is bounded to 23 hours so it cannot silently allocate a second VM after the
provider's idempotency window. Every HTTP create attempt is journalled before
dispatch. A certified Boat refusal is recorded against that attempt alone;
later refusals never resolve an earlier lost response. If an intent has
no dispatches, or every attempt was certified rejected, cleanup durably
closes the intent without allocating a VM and releases the running slot.
Closure prevents any future dispatch or resource binding. Every builder intent
tracks attempts from the start. Deleting a bound sandbox remains possible after
the qualification run becomes terminal; cleanup evidence is recorded only
after confirmed absence.

The shared `CloudBuilderVms` module also supports authorized template sources
and graceful stop-to-archived for Cloud Computer builds. Its system-only
`cloud_builder_vm_operations` journal preserves intent before provider I/O
and the sandbox ID before readiness or wallet validation. Workspace journals
require an organization/generation owner and cannot represent these
infrastructure VMs. The extracted pinned-SSH transport is shared with workspace
setup; fixed commands live in `cloud-builder-commands.ts`, where computer
builds add their closed command entries.

## Alpha live verification runbook

Run this only from the orchestrator's credential-bearing Alpha workspace. The
script does not deploy, change worker flags, publish artifacts or contact Boat
directly. The control-plane worker owns VM cleanup.

1. Deploy the additive migration and worker with the v4 base/installer, runtime
   resolver and bundle builder. Enable `CLOUD_RUNTIME_QUALIFICATION_ENABLED`
   on Alpha and resume background workers. For admission checks, also select
   `CLOUD_RUNTIME_QUALIFICATION_MODE=smoke`. Register an approved v4 base and
   publish a confirmed runtime containing the self-test. Start from the sanitized
   B4 base with `/srv/zeros/files` empty; do not prepopulate its workspace or
   mount points. Use a fresh runtime without existing full/MCP approvals for
   this smoke acceptance.
2. In the private, mode-0600 repository-root `.env.agent`, set the existing
   `ZEROS_ACCOUNT_ACCESS_TOKEN` variable to an Alpha staff account session
   (`developer` or `platform_owner`). Keep its value out of shell arguments,
   command output and reports. The script reads the file directly and pins all
   HTTP requests to the Alpha API; redirects reject.
3. Set `qualification_runtime_id` to the published resource ID and invoke:

       node scripts/cloud-workspace-validation/runtime-qualification-live.mjs --runtime "$qualification_runtime_id"

   The script verifies the status channel before requesting a staff retry,
   saves the enqueue receipt immediately, then observes for at most 35 minutes.
   It requires a successful run, durable cleanup confirmation and all five
   enabled smoke rows with MCP false. Stdout is one closed diagnostic.
4. Attach `.context/runtime-qualification-<runId>.json` to the verification
   report. It records the runtime, base, run and Boat sandbox IDs, final state,
   approval kinds and cleanup timestamp. For a run with a sandbox ID, a
   non-null cleanup timestamp means the worker confirmed deletion and the
   provider 404. Pre-allocation failures can confirm that nothing was allocated.
   The run, provider journal and intended qualification rows remain as
   audit/approval state.
5. If authentication expires or observation times out, cleanup is unconfirmed
   until a later observation proves it. Refresh the private staff session,
   set `qualification_run_id` from the saved receipt and resume without
   allocating another VM:

       node scripts/cloud-workspace-validation/runtime-qualification-live.mjs --run "$qualification_run_id"

   Keep the worker running for crash reconciliation. If provider errors prevent
   cleanup, report that unresolved state and the recorded sandbox ID; do not
   claim the VM was deleted. Local fake-provider/database tests cover crash,
   failed installer/self-test and unconfirmed-deletion paths without live
   mutation. No live provider resource was created by the local test suite.

## Control-plane admission

| Variable | Default | Behavior |
| --- | --- | --- |
| `CLOUD_WORKSPACE_NEW_RUNTIME_PROFILE` | `legacy` | `v4` opts eligible new managed Boat workspaces into runtime selection. |
| `CLOUD_RUNTIME_V4_STAFF_ONLY` | `true` | V4 creation requires the `developer` or `platform_owner` staff role. |
| `CLOUD_RUNTIME_QUALIFICATION_MODE` | `full` | `full` requires full evidence; `smoke` accepts smoke or full evidence for selection and credential admission. |

The configured base is the newest approved, non-revoked base image. A revoked
compatibility contract on that base closes admission rather than selecting an
older base. Its Alpha head is the highest confirmed, non-revoked `release_order`
whose bundle is not revoked, uses the deployed engine protocol, and has enabled,
non-revoked qualifications for all of `claude-setup-token`, `codex-chatgpt`, and
`cursor-api-key` for that base's compatibility ID and the configured evidence
mode. MCP approval is checked independently when a credential path requires it.
V4 admission supports only the current tested engine protocol. An older
`CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION` override retains legacy behavior but
closes new v4 creates with HTTP 409 before allocation.

Create reselects under the organization lock and saves base provenance and all
six runtime fields in the generation transaction, without provider or artifact
I/O. No eligible head returns HTTP 409 `cloud_runtime_unavailable` before
allocation. Workspace responses include the saved six-field `generation.runtime`
only for v4. Idempotent replay, wake and setup retry retain the saved pin even
after the head advances or new v4 creation is disabled. Existing selected legacy
organization images and delegated provider connections retain their current path;
Cloud Computer v2 template forks belong to Phase C.

### V4 lifecycle pins and explicit runtime upgrades

Wake/resume and setup retry reuse the saved generation. Rebuild, rollback and
automatic or explicit checkpoint recovery copy all six runtime fields unchanged
through `copyGenerationPins` in `generation-pins.ts`, together with the saved v4
provisioning profile. Neither a later channel head/base nor the new-workspace
profile switch changes that selection. C5 extends this same transaction boundary
for `cloud_workspace_computer_sources`; its extension test lives in
`runtime-lifecycle.integration.test.ts`. Legacy generations keep their existing
profile selection and NULL runtime fields.

Wake, recovery, provider provisioning and each setup attempt revalidate the saved
runtime. Revoked bundle/base/contract or required qualification returns
`cloud_runtime_revoked`, with an explicit-upgrade instruction. Other missing or
incompatible runtime authority returns `cloud_runtime_unavailable`. Revocation
during setup also prevents readiness and records the actionable error. No path
falls back to another runtime. Boat restore is not a reboot: resume still requires
fresh setup admission and its execution fence; it cannot rely on boot services
having rerun or publish by renaming a pre-existing directory.

Engineering staff (`developer` or `platform_owner`, including a current account
role check) can request `POST
/v1/organizations/:organization/cloud-workspaces/:workspace/runtime-upgrade`
with the strict body `{expectedGeneration, operationId}`. Normal workspace
management, funding and quota authorization also applies. This internal HTTP
contract is exported by `@zeros/protocol`; there is no renderer upgrade UI here.

The endpoint selects the latest eligible runtime under
`CLOUD_RUNTIME_QUALIFICATION_MODE` for the source's exact saved base. It keeps the
base image, resource profile and settings snapshot, refuses a downgrade, and
uses the existing drain/checkpoint/replacement-generation/restore flow. Running
agents or other active work return 409 `cloud_workspace_busy`; a stale generation
returns 409 `cloud_generation_changed`. A stopped, archived or failed source
requires its current lossless final checkpoint before an upgrade can wake it.
For v4 runtime upgrades, a completed `before_rebuild` capture also qualifies if
content and record revisions are current and no later source registration or
setup attestation exists. This permits a new upgrade after a failed candidate
rolls back to a revoked source; ordinary recovery retains its existing rules.
The ordinary `/generations` rebuild endpoint preserves v4 runtime pins.

An accepted replacement returns 202 with `{operationId, sourceGeneration,
generation, runtimeId, transitionId, unchanged:false}`. Replaying the same
operation returns that accepted selection with 200 and `Idempotency-Replayed:
true`, even if the generation or channel head advanced. Reusing the operation
with a different request returns 409 `idempotency_key_reused`. Already-current
requests return 200 with `unchanged:true`, the source generation and a null
transition ID; their durable receipt never dispatches provider work. Failed
candidates retain the source generation's pin; waking that source still checks
revocation. If no later eligible runtime exists on the saved base, the endpoint
fails closed instead of changing bases.

The [Alpha lifecycle acceptance runbook](runtime-lifecycle-acceptance.md) covers
the disposable API exercise, cleanup and the remaining manual acceptance cases.
Local PostgreSQL and mocked tests do not constitute live Alpha acceptance.

V4 setup checks the base status and compatibility ID, requiring `idle` or
`waiting_for_runtime`. The existing pinned SSH transport delivers a maximum
64 KiB encoded installer input containing the descriptor, a 15-minute artifact
GET capability and the unchanged nested setup payload. Legacy input remains
bounded to 48 KiB. Artifact URLs never enter workspace responses, persisted
setup logs, grants or errors. The helper result uses the existing parser and the
final installer diagnostic must also confirm success.
V4 uses a 900-second one-use setup admission, covering the ten-minute install
allowance and the helper's five-second minimum remaining lifetime. The executor
rejects an admission without that remaining budget before installation. Legacy
keeps `CLOUD_WORKSPACE_SETUP_ADMISSION_TTL_SECONDS` (120 seconds by default).
Materials are minted by the single redemption after installation, so their
lifetime covers the remaining setup work independently of admission expiry.
Outer timeout and setup-lock contention use the worker's bounded retries with
fresh admission and artifact delivery for the same pin. Integrity failures stay
terminal. Validated installer component, stage, exit code, timeout flag and
failed checks are retained in bounded diagnostics without raw output or URLs.
Publication and setup share one artifact store from `CLOUD_WORKSPACE_S3_*`;
without that store v4 setup rejects with `cloud_runtime_unavailable`. Delivery
remains enabled for saved v4 generations when new v4 creation is disabled.

The v4 helper redeems the existing setup admission with a strict `runtime`
witness: runtime ID, manifest digest, base compatibility ID, installer receipt
digest, boot ID and supervisor session ID. Legacy redemption rejects that field;
v4 requires it. Redemption compares the first three with the generation and
inserts all nine engine identity columns atomically. Registration must repeat
the exact witness using the v4 `agentRuntime` union; its registration grant keeps
`purpose = 'setup'` and the existing run/fence binding. Readiness copies the
registered engine's nine fields into the setup attestation under the existing
grant-before-engine lock order.

Every fresh setup, registration and readiness publication rechecks the pinned
runtime's current qualifications and revocation state. Credential discovery,
execution and renewal share the exact per-kind v4 qualification join, including
evidence mode and independent MCP/native-capability requirements. V3 retains its
provider/image/contract join. Revocation closes new admissions without choosing a
different runtime; existing in-flight credentials retain their lease deadlines.
