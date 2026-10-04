# Cloud runtime bundles and registry

V4 separates the immutable engine runtime from the Boat base image. The schemas
in [cloud-runtime-bundle.ts](../../packages/protocol/src/cloud-runtime-bundle.ts),
migration `0124_cloud_runtime_registry.sql`, and their tests are authoritative.
This is the internal Alpha contract. The control plane implements OIDC
publication, base registration, and staff registry operations. Workspace
selection, installation, qualification workers and lifecycle services are
separate changes.

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
bounded to 16 KiB. There are no evidence-run/case or continuation tables.

For internal Alpha, the control plane inserts qualification evidence itself
(AB-2, for example `{mode:"smoke",checks:[...]}`). All new tables have enabled
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
Revoked registry records remain referenced for audit and retirement. Workspace
admission/qualification checks, newest compatible selection, explicit upgrades
and copying pins across lifecycle transitions belong to later services; these
schemas grant none of that authority. Browser diagnostics accept v3 and v4
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

After commit, completion calls `enqueueRuntimeSmokeQualification(runtimeId)`.
Until the B7 worker is configured the hook returns `not_configured` and creates
no qualification. Scheduling failures return a closed 503 after registration;
retrying completion preserves the committed identity and retries the hook.
The worker must make enqueue idempotent and recheck revocation. A registered
runtime alone is never a qualified channel head.

Staff endpoints use ordinary account authentication and the server's current
`developer` or `platform_owner` role. `support_admin` and ordinary users receive
404. These routes remain usable when CI publication is disabled:

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/internal/cloud-runtime/status` | Lists up to 100 bases, the last 20 runtimes, their kind/profile/approval/MCP/evidence-mode/timestamp metadata, and the current channel's last 20 releases. It lists releases until the separate selection service supplies channel-head eligibility. |
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
