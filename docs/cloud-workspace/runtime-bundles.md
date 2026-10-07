# Cloud runtime bundles and registry

V4 separates the immutable engine runtime from the Boat base image. The schemas
in [cloud-runtime-bundle.ts](../../packages/protocol/src/cloud-runtime-bundle.ts),
migration `0124_cloud_runtime_registry.sql`, and their tests are authoritative.
The control plane implements channel-scoped OIDC publication for Alpha, Beta
and Production, Alpha base registration, and staff registry operations. It selects and
pins runtimes at creation, admits installation, and binds redemption,
registration and readiness to that pin. The base installer, qualification workers
and generation upgrade/recovery services have their own implementation boundaries.

The [version-skew gate](runtime-skew-gate.md) pins historical runtime/desktop
source contracts for required CI testing and documents pin advancement and
cohort retirement. It verifies source compatibility; released-engine qualification remains
separate.

## Qualified bundle versus retained image publication

The supported workspace artifact is the physical v4 tarball built by
`runtime-bundle/build.cjs` through the reusable `cloud-runtime-bundle-build.yml`.
The Alpha desktop release and the standalone `cloud-runtime-bundle.yml` use this
build; runtime eligibility requires qualification against the protected Boat base and saved
Computer source. The separate `cloud-runtime-publication.yml` flat
`/opt/zeros-runtime` OCI publisher is retired: its recipe still installs the v3
worker profile, so `publish-vm-image` and `publication-receipt` refuse before any
build, registry or receipt work. The shared image kit retains separate Dev
callers. A v4 flat image would need its own qualification; changing a marker
cannot qualify it. The opt-in v3 release-worker promotion lane now refuses before
allocation/build; it retains historical receipts and cleanup, while the disabled
lane preserves ordinary release publication. See
[qualification status](qualification-status.md) and
[release worker qualification](release-worker-qualification.md).

[Runtime updates](live-runtime-updates.md) owns staging, retained allocation,
consumption/enrollment and rollback. One journal owns those transitions; staging
never activates and ordinary resume never changes a saved pin implicitly.

## Standalone publication

Dispatch [cloud-runtime-bundle.yml](../../.github/workflows/cloud-runtime-bundle.yml)
with `channel=alpha`, `beta`, or `production` to build and publish the runtime
without a desktop release. Alpha accepts only `refs/heads/main`; Beta and
Production accept `refs/heads/main` or a nonempty `refs/heads/release/*` branch.
Forks are refused. Each channel has its own non-cancelling publication lock.

The reusable build retains the contained user-namespace runner setup, verifies
the exact event SHA, and uploads the tarball, descriptor, manifest and build
receipt. The publisher downloads that same run's immutable artifact ID. Its
job names the selected GitHub environment, so that environment's branch rules
and configured reviewer protections apply before OIDC access. It verifies the
current checkout and branch plus the latest exact-SHA Preflight and CodeQL
results immediately before publishing; automatic Alpha's fast path does not
apply to this dispatch.

Set `CLOUD_WORKSPACE_CONTROL_PLANE_URL` and `CLOUD_RUNTIME_OIDC_AUDIENCE` as
Actions variables in each selected environment, matching that channel's
control plane. See [deployment environments](../deployment-environments.md).
The control plane holds the artifact credentials; the workflow receives an
expiring upload capability through OIDC. No VM is allocated by this workflow.

Deploy the matching control plane before running the updated publisher. The
existing `alpha-publication.yml` `runtime-publish` job already depends on
`hosted`, which deploys the control plane first. Both publication paths now send
the GitHub run ID as `releaseOrder`. An older control plane refuses that body
with HTTP 409 `runtime_identity_conflict`; rerun publication after deploying the
updated control plane. This change needs no database migration or historical
release rewrite.

Publication registers immutable bundle bytes and a channel release; it grants
no runtime/base qualification or workspace execution authority. Workspaces
adopt a bundle only through the existing qualified upgrade and wake paths.
Running allocations retain their pin, and missing qualifications, revoked
identities or failed lifecycle admission still refuse adoption. Qualification,
staging, generation replacement and existing channel rollout policies are
unchanged by standalone publication.

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
credential-kind v4 qualifications. Every new channel release uses the
OIDC-verified GitHub run ID as its order, shared across the Alpha and standalone
workflows; their workflow-specific run numbers cannot order interleaved
publications. Historical run-number orders remain unchanged. A legacy
`releaseOrder` equal to the verified run number is accepted only as a retry of
an existing row with the same run ID, channel and runtime; it cannot insert a
new release. Updated publishers can also retry those rows using their run ID
without changing the saved order. Run attempt and source checks still apply.
The five credential kinds remain
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
Historical qualification rows remain immutable audit data; current executable
admission joins only exact v4 qualification records.

Generations carry the nullable six-column group `runtime_id`,
`runtime_manifest_sha256`, `runtime_base_image_id`, `runtime_base_compatibility_id`,
`runtime_profile`, `runtime_engine_protocol_version`: all NULL or all present.
Composite foreign keys bind runtime/digest and base image/compatibility. A
registered v4 base's image ref requires a pin. The pinned base must match the
generation's provider, source commit, architecture and storage. The generation's
image ref must equal the base's registered ref or match
`^boat-template:[A-Za-z0-9_-]{1,128}$` for an org template fork. The saved v2
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

NULL pins identify retired generations, never “latest”. Old rows are not
backfilled or admitted to execution; authorized history/management/cleanup remain.
Revoked registry records remain referenced for audit and retirement. Explicit
upgrades and copying pins across generation transitions belong to the lifecycle
services; the registry schemas grant none of that authority. Current worker
attestation admits v4 only; missing/unknown reports are unavailable. Historical
diagnostic schemas do not re-enable a retired profile. Shipping capture Chromium
does not qualify native provider Browser access.

The shared [plain JSON fixtures](../../packages/protocol/src/__tests__/fixtures/cloud-runtime/)
include `cases.json` with each file's contract and validity; manifest cases also
record the digest of their exact bytes. TypeScript and the Python bootstrap can
consume the same inputs. Database behavior is covered by
[runtime-schema.integration.test.ts](../../apps/control-plane/src/cloud-workspaces/runtime-schema.integration.test.ts)
against a disposable PostgreSQL 18 database with `TEST_DATABASE_URL` set.

## Publication and operator API

Publication is disabled by default and can be enabled on Alpha, Beta or
Production. The control plane verifies GitHub Actions OIDC with `jose` and a
cached GitHub JWKS at
`https://token.actions.githubusercontent.com/.well-known/jwks`. It requires
RS256, issuer `https://token.actions.githubusercontent.com`, the configured
audience, a case-insensitive repository match, and an exact `workflow_ref`
containing that repository, an allowed workflow file and the token's actual
ref. Publication accepts `release-alpha.yml` with event `push` on Alpha/main,
or `cloud-runtime-bundle.yml` with event `workflow_dispatch` under the
channel/ref matrix above. Standalone tokens must name an environment equal to
the control plane's deployment channel. Base registration remains restricted
to Alpha/main `cloud-runtime-base.yml` with event `workflow_dispatch` and an
Alpha environment. Run ID, number, attempt and source SHA come from verified
claims. Body run values and runtime/base source commits must agree with those
claims.
Issued-at times may be at most 60 seconds ahead of the control plane's clock;
token expiration remains enforced independently.

| Environment variable | Default / behavior |
| --- | --- |
| `CLOUD_RUNTIME_PUBLICATION_ENABLED` | `false`; the three CI endpoints return 404 before auth or database work |
| `CLOUD_RUNTIME_OIDC_AUDIENCE` | `zeros-control-plane-<deployment channel>` |
| `CLOUD_RUNTIME_OIDC_REPOSITORY` | `Withso/zeros`; its spelling also determines the exact workflow ref |
| `CLOUD_RUNTIME_OIDC_ENVIRONMENT` | Deployment channel (`alpha`, `beta`, or `production`); an explicit mismatch is rejected. An empty value retains only the legacy Alpha push opt-out and cannot authorize standalone publication or base registration. |
| `CLOUD_WORKSPACE_NEW_RUNTIME_PROFILE` | `v4`; only `v4` is accepted; saved v2 source and current qualification are required |

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
| `POST /internal/v1/runtime-bundles/publications/complete` | **The same full request** → `{runtimeId,registered:true}`. The endpoint is stateless: it needs neither a prior call nor pending metadata. It revalidates descriptor/header/claims, HEADs the derived key, requires exact bytes, then inserts or validates the bundle and configured channel release atomically in system context. New releases require `releaseOrder=githubRunId` from verified claims; run-number requests require an existing same-run/channel/runtime row. |
| `POST /internal/v1/runtime-bases` | `{baseImageId,imageRef,sourceCommit,imageBuildSha256,storageMib,compatibilityRawB64,compatibilitySha256,compatibility?}` → `{baseImageId,baseCompatibilityId}`. `imageRef` uses `boat:<snapshot>@sha256:<imageBuildSha256>`. Canonical standard base64 decodes to at most 64 KiB of strict UTF-8 JSON; SHA-256 covers those original bytes. An optional parsed `compatibility` echo must agree with them. Contract and approved base image are inserted atomically. |

The descriptor's runtime ID must equal `r1-<manifestSha256>`, its header source,
ABI and protocol fields must agree, and registry byte counts must be positive
safe integers. An exact replay preserves registration, approval and
confirmation timestamps; conflicting immutable identities return 409. Missing
or short/long artifacts cannot register a bundle. Completion sets the channel
release's `confirmed_at` only once; the Alpha desktop publishing job runs after
hosted promotion succeeds. An identical rerun with the same run ID and number may
use an equal or later verified attempt, preserving the first stored attempt
as provenance, the release order and all registration timestamps. Completion
retries smoke enqueue after a lost response or post-commit scheduling failure.
An attempt older than the first stored attempt, different content/run, an unverified order,
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
For v4, the exact live engine records optional-customization support when it
advertises `agentCustomizationVersion: 3` during registration or makes an
admitted customization-v3 request. Registration verifies the pinned runtime,
manifest, base and installation witness. Admission verifies the engine, actor,
consent, model and runtime qualification before recording evidence in
`cloud_workspace_engine_instances.agent_customization_version`. A v1/v2 request
on a basic-qualified, non-MCP runtime records required-only evidence (1 or 2),
but never downgrades existing v3 proof. Unknown engines remain eligible: earlier
v3-capable bundles did not advertise the registration field. Runtime dates and
profile names are not capability evidence.

Discovery returns `runtimeUpgradeRequired` only when basic qualification exists,
MCP proof is absent, and the live engine has recorded required-only evidence.
These grants report `runtimeQualified: false`. The rejected admission commits its
evidence and exact command receipt before returning the closed
`cloud_runtime_upgrade_required` error. Settlement preserves that code even when
older engines replace the HTTP error with a generic failure. The renderer reads
the exact receipt, restores the rich draft without overwriting newer typing,
pauses queued successors, and refreshes discovery without resending.

The renderer excludes blocked grants' models, shows “This workspace gets the new
cloud runtime the next time it wakes” and blocks Send and Enter while preserving
the draft. A provider remains usable if another matching grant qualifies.
Lifecycle surfaces can use
`delegations.some(grant => grant.runtimeUpgradeRequired)` from the existing
prepare/discovery response; no credential material is involved. Missing or
retired engines do not inherit the previous engine's capability. Runtime
selection on wake is owned by lifecycle policy, not this discovery flag.

Worker-profile3 gateways are retired. Customization schema versions1–3 remain
independent compatibility contracts used by v4; they do not identify worker profiles.
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
The lifecycle service owns automatic runtime selection on wake. Existing engines
retain their old required-customization behavior until the next sleep/wake selects
a qualified bundle with the new registration capability. The composer does not
initiate an upgrade. Previously built v3-capable engines without the registration
field are also unproven; only registration from the newly selected engine clears
this requirement. Existing rows are not backfilled.
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
| `CLOUD_WORKSPACE_NEW_RUNTIME_PROFILE` | `v4` | Only `v4` is accepted; new cloud workspaces require a saved v2 Computer source and qualified pin. |
| `CLOUD_RUNTIME_QUALIFICATION_MODE` | `full` | `full` requires full evidence; `smoke` accepts smoke or full evidence for selection and credential admission. |

The configured base is the newest approved, non-revoked base image. A revoked
compatibility contract on that base closes admission rather than selecting an
older base. Its Alpha head is the highest confirmed, non-revoked `release_order`
whose bundle is not revoked, uses the deployed engine protocol, and has enabled,
non-revoked qualifications for all of `claude-setup-token`, `codex-chatgpt`, and
`cursor-api-key` for that base's compatibility ID and the configured evidence
mode. MCP approval is checked independently when a credential path requires it.
V4 admission supports only the current tested engine protocol. An incompatible
`CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION` override closes new creates before
allocation. The removed staff rollout selector grants no execution fallback;
current organization/member/admin roles, funding and qualification still apply.

Create reselects under the organization lock and saves base provenance and all
six runtime fields in the generation transaction, without provider or artifact
I/O. No eligible head returns HTTP 409 `cloud_runtime_unavailable` before
allocation. Workspace responses include the saved six-field `generation.runtime` for supported execution. Idempotent replay and setup retry retain the saved pin; a stopped
workspace may automatically select a compatible successor on wake, through the existing lifecycle decision. Unsupported saved sources/pins return
`cloud_workspace_v2_required`; no active-template/legacy resolver substitutes
new inputs. See [template forks](template-forks.md).

### V4 lifecycle pins and automatic wake updates

Ordinary resume, setup retry, rebuild, rollback and automatic or explicit
checkpoint recovery keep all six saved runtime fields through
`copyGenerationPins` in `generation-pins.ts`, together with the provisioning
profile. Retired generations keep their historical NULL fields for metadata/cleanup but
cannot use execution replacement or recovery. Saved v2 source pins copy with the
supported generation; current-template selection never repairs an old source.

A stopped or archived v4 allocation now checks for a newer runtime before its
ordinary start/resume. The existing `/wake` route and direct create/wake lifecycle
intents execute the same server decision; renderer polling never wakes compute.
`selectCloudWorkspaceRuntimeUpgrade(tx, {workspaceId, organizationId, runtime,
qualificationMode})` in `runtime-upgrade-availability.ts` selects the newest
confirmed, nonrevoked Alpha release qualified in the configured mode for the
exact saved base and compatibility. It requires the existing three-kind floor
plus every active, unexpired, unrevoked delegation's current credential kind.
`updateAvailable` requires a strictly later release order. A running allocation
is never restarted to update, and a different base is never selected.

`upgradeCloudRuntimeOnWake` uses the existing generation-replacement transaction,
not a second installer or upgrade flow. Admission locks organization, workspace
and the claimed wake intent, uses that intent UUID as the operation ID, and saves
`runtime-upgrade:automatic-wake:<intent UUID>` as its durable replacement key.
The original wake becomes a completed receipt; drain/create/setup own execution.
Other devices join an active wake or automatic transition with their own
replayable receipts, without accepting another start. Generation CAS, lease,
authority, quota, settings and active-work checks still apply. Stop/archive/delete
can cancel a transition and restore the source before cleaning its candidate.

Admission runs inside a savepoint. Missing qualification, replacement headroom,
a fresh checkpoint or another admission requirement defers the update and
continues ordinary resume on the saved pin. Closed audit codes record deferral.
A candidate provider/setup failure before readiness uses the existing rollback
immediately, including retryable failures: the source wakes on its saved pin,
and the rejected candidate is cleaned by its generation-scoped delete intent.
The fallback wake carries the transition ID and never selects again in that
attempt. A later sleep with a fresh final checkpoint and wake retries selection.
Invalid or revoked source authority remains closed; fallback never revives a
revoked base/runtime. A qualified newer same-base runtime may repair a revoked
stopped runtime, as the explicit upgrade already permits.

The internal staff-only POST on
`/v1/organizations/:organization/cloud-workspaces/:workspace/runtime-upgrade`
remains compatible. Its strict body is `{expectedGeneration, operationId}`.
Session and current database staff roles must allow organization creation
(`developer` or `platform_owner`), and membership, management, funding and quota
checks apply. It selects the existing three-kind-qualified head on the saved
base. Fresh stale generations return `cloud_generation_changed`; active work
returns `cloud_workspace_busy`. An accepted replacement returns 202 with
`{operationId, sourceGeneration, generation, runtimeId, transitionId,
unchanged:false}`. Replay returns that accepted selection with 200 and
`Idempotency-Replayed:true` before CAS or head selection; a different request or
actor reusing the key returns `idempotency_key_reused`. Already-current requests
save a durable `unchanged:true` no-op receipt with no provider dispatch.

The same staff and management gates protect a read-only, `no-store` GET on that
path. It exposes the current runtime, newest compatible credential-qualified
runtime, availability and closed transition progress/error. The effectively
gated details row shows **Runtime · short ID** and, when newer exists,
**Updates automatically the next time this workspace wakes**. During replacement
it shows **Starting the cloud workspace…**. The cloud composer also discovers
availability while details are closed; optional
`ModelPill.runtimeUpgradeRequiredForAgents` supplies AG's stable additional reason
and explains that installation happens on the next wake. When agent discovery
already supplies the empty-menu explanation, the availability footer is omitted
to keep one notice. There is no manual
update button or renderer POST caller. The keyed
`requestCloudRuntimeUpgradeDetails(folder)` navigation interface remains available
for a cloud caller to focus the informational row. Local folders are a no-op.
Hidden, concealed, nonstaff and nonmanager surfaces do no runtime polling.
Availability is fenced by account, catalog, workspace and generation.
Idle runtime polling reads availability only; the details panel refreshes the
workspace document during startup or an active replacement to follow readiness.

Automatic replacement reuses the already committed current lossless final
checkpoint. The existing freshness checks require current content/record revisions
and no later source registration or setup attestation. Explicit running upgrades
first capture `before_rebuild`; a fresh completed rebuild capture can also be
reused for a later stopped upgrade. Files excluded by the durability policy do
not become durable merely because an update occurs.

| State | Replacement behavior |
| --- | --- |
| Files and Git | Restores eligible working files, staged/unstaged changes, branch/HEAD/refs, index, local objects/history and immutable remote base. Existing ignored/secret-like and size exclusions apply. GitHub remote state is not changed. |
| Chats/transcripts | Keeps workspace identity and durable records, plus existing allowlisted native agent/Design session history. Final sleep flushes records before committing its checkpoint. |
| Agent turns and commands | No running turn continues across sleep/update. Dispatching commands, live execution/service/write leases and Cloud Computer builds block update admission. Undispatched queued commands keep their saved pause state and bind to the first fresh candidate or fallback engine. Claims wait for workspace readiness, with the existing durable command/claim/user-message identities preventing replay. Interrupted dispatched outcomes stay `uncertain` and paused. Ordinary later engine replacement still requires explicit queue Resume. |
| Terminals, setup and previews | Sleep's final drain stops PTYs and running processes. Replacement does not restore a live shell, preview or setup process; terminal scrollback is not promised. Reopen terminals and restart previews. Setup reruns from the saved accepted settings/secrets snapshot; excluded dependencies may need regeneration. |
| Engine and access | Source provider stop proves access revocation; the candidate restores the checkpoint into a new allocation/generation and registers a fresh engine before readiness. Old-generation access is fenced and clients reattach through existing transport. |
| Failure | Retains the source checkpoint and exact pin, resumes that source with fresh setup/engine admission, and cleans the rejected candidate. Source revocation remains authoritative. Credential/delegation records are not mutated. |

Wake latency is a code-path estimate, not live provider measurement. Plain resume
uses one lifecycle claim and provider `start` before setup. Automatic replacement
uses three claims: admission, source drain (`stop`, even when already stopped, to
prove access revocation), and candidate `create`. This adds two lifecycle claims,
selection/admission queries, stop/access drain, creation rather than resume,
checkpoint restoration, and installation of the new bundle before the common
setup/readiness path. It needs no additional final checkpoint capture. The
reconciler drains up to 20 claims per tick, so there is no required two-interval
sleep between those stages; provider latency, artifact size, restore size and
worker availability determine the real delta. Local DB fixtures assert the
`stop:1`/`create:2` path versus a plain `resume:1`; they do not measure Boat latency.

The [Alpha lifecycle acceptance runbook](runtime-lifecycle-acceptance.md) covers
the disposable automatic-wake exercise, cleanup and owner Mac acceptance. Local
PostgreSQL and mocked tests do not constitute live Alpha acceptance.

V4 setup checks the base status and compatibility ID, requiring `idle` or
`waiting_for_runtime`. The existing pinned SSH transport delivers a maximum
64 KiB encoded installer input containing the descriptor, a 15-minute artifact
GET capability and the unchanged nested setup payload. Artifact URLs never enter workspace responses, persisted
setup logs, grants or errors. The helper result uses the existing parser and the
final installer diagnostic must also confirm success.
V4 uses a 900-second one-use setup admission, covering the ten-minute install
allowance and the helper's five-second minimum remaining lifetime. The executor
rejects an admission without that remaining budget before installation. The historical setup-TTL configuration name remains a compatibility contract;
it does not enable an old helper or worker profile.
Materials are minted by the single redemption after installation, so their
lifetime covers the remaining setup work independently of admission expiry.
Outer timeout and setup-lock contention use the worker's bounded retries with
fresh admission and artifact delivery for the same pin. Integrity failures stay
terminal. Validated installer component, stage, exit code, timeout flag and
failed checks are retained in bounded diagnostics without raw output or URLs.
Publication and setup share one artifact store from `CLOUD_WORKSPACE_S3_*`;
without that store v4 setup rejects with `cloud_runtime_unavailable`. Saved supported pins still require current qualification and artifact delivery;
release gates and registry revocation remain authoritative.

The v4 helper redeems the existing setup admission with a strict `runtime`
witness: runtime ID, manifest digest, base compatibility ID, installer receipt
digest, boot ID and supervisor session ID. Current v4 redemption requires that witness; unsupported generations fail
before credentials or enrollment. Redemption compares the first three with the generation and
inserts all nine engine identity columns atomically. Registration must repeat
the exact witness using the v4 `agentRuntime` union; its registration grant keeps
`purpose = 'setup'` and the existing run/fence binding. Readiness copies the
registered engine's nine fields into the setup attestation under the existing
grant-before-engine lock order.

Every fresh setup, registration and readiness publication rechecks the pinned
runtime's current qualifications and revocation state. Credential discovery,
execution and renewal share the exact per-kind v4 qualification join, including
evidence mode and independent MCP/native-capability requirements. No v3 worker credential-qualification fallback remains. Revocation closes new admissions without choosing a
different runtime; existing in-flight credentials retain their lease deadlines.
