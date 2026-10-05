# Cloud Computer agent tools

The reserved `cloud-computer` MCP server gives an initiating administrator five
execution-scoped tools in a marked admin workspace. It is composed with existing
Design and workspace tools through the Claude, Codex and Cursor product-tool
adapters. It has no global registry entry or stdio product server.

## Creation and admission

`POST /v1/organizations/:organization/cloud-computer/v2/admin-workspaces`
accepts only `{expectedActiveVersion, operationId}` from current engineering staff
who are organization owners/admins. It requires an active ready template and at
least one repository. The first configured repository is primary, at its exact
build SHA; an empty list returns 409 with guidance to configure and build a repo.
The ordinary template-fork creation path assigns creator, owner, assignee and
billing owner to the authenticated admin, with private sharing. It calls
`markAdminWorkspace(tx, {workspaceId, orgId, creatorUserId})` in the same transaction
as the generation, source pin, settings snapshot and lifecycle intent. There is
no client-supplied admin flag.

Reopening with a new operation ID returns that creator's existing matching
non-retired admin workspace for the active version with `reused: true`. Requests
for a stale version conflict; testing a new active version requires an explicit
new request. Immutable operation receipts preserve the original workspace and
reuse result on replay, including after later activation, without another
allocation. Organization erasure removes these receipts before the sidecars.
Normal VM accounting meters the creator through the existing billing epoch.

Workspace DTOs expose optional server-derived `adminWorkspace: {creatorUserId}`
metadata. Execution admission supplies the fixed context through the existing
native system-instruction channel or first-turn preamble: “This workspace can
view and change the organization's Cloud Computer through the cloud-computer
tools; do not edit repository code unless asked.” It is included on resume too;
DTOs and prompt text never establish tool authority.

`cloud_computer_admin_workspaces` binds the workspace and organization to an
immutable creator. Forced system RLS hides it from user transactions. Updates
and ordinary deletes are forbidden. The existing fenced organization-erasure
transaction removes it before workspace deletion, as it does other immutable
computer records.

Engine admission adds `computerToolsVersion: 1` only for this creator in a
marked workspace with current engineering staff and organization owner/admin
authority, an exact v4 generation/engine pin, and an enabled MCP qualification
for that runtime/base/credential tuple. Admission and every tool call share the
runtime admission/renewal predicate, including bundle, base image and base
contract revocation, protocol compatibility and qualification evidence mode.
Older marked admissions return
`cloud_computer_tools_update_required`; opting in on an ordinary workspace grants
nothing.

## Calls and results

Each call uses the existing authenticated
`POST /internal/v2/cloud-workspaces/engine/agent-execution` route with
`kind: "computer-tool"`, a live initiating `leaseId`, a native `toolCallId`, and
one strict `{name, arguments}` tool request. The engine scope is authenticated by
its heartbeat credential. The control plane resolves the actor from the recorded
execution lease, rechecks current engine/generation, account/device/session,
credential consent, staff role, organization membership and immutable creator,
and holds those authority fences through the operation. Body identity, prompts,
environment variables and repository files do not grant access.

| Tool | Arguments | Result and operation |
| --- | --- | --- |
| `ListComputers` | Empty object | At most the bound organization's computer, its state, active/draft/latest build identifiers, and capabilities. |
| `GetComputerConfiguration` | `computerId` | Install script/timeout, revision/latest build, repository names/refs and cloud setup commands/settings versions, environment names/set markers. Repository IDs are Zeros UUIDs; an unmaterialized repository has a null ID. |
| `CreateComputerConfiguration` | `installScript`, optional `timeoutSeconds`, `expectedRevision`, `previousBuildId` (nullable) | Atomically save the script and queue/replace a build; return `revision`, `buildId`, `version`. Preserve current repositories and exact environment binding versions. |
| `GetComputerBuildStatus` | `buildId`, optional `after` cursor | Same-org build state/stage/error code, current activation, last 200 redacted lines, cursor, truncation and completion. |
| `UpdateRepositorySetupScript` | `repositoryId`, `expectedSettingsVersion`, `script`, `timeoutSeconds` | Replace only the cloud setup commands of a repository in the active or draft configuration; return its settings version without starting a build. |

Arguments and results reject extra fields. Scripts are at most 16 KiB UTF-8 and
timeouts are 1–900 seconds. Configuration output is bounded to 20 repositories,
32 setup commands per repository and 128 environment names. Results contain no
provider resource/installation IDs, access URLs, credential material or saved
environment values. Build logs pass through the existing computer log writer's
redaction; its default withholds arbitrary script output.

Log output excludes trailing-newline split artifacts before applying the
200-line cap. Genuine blank lines and unterminated chunk fragments retain their
sequence/line identities; the polling cursor consumes whole persisted chunks.

Both configuration guards are required: a repository/environment edit can
advance the revision without changing the latest build. Authorized conflicts
return HTTP 409 with `{result: {conflict: true, revision, latestBuildId}}`. The
agent must refresh and review before issuing a new call.

The MCP session and JSON-RPC request ID form the native call identity. The
control plane derives a namespaced operation UUID from that identity and the
initiating lease. Build requests use the existing computer operation receipts,
so a lost-reply replay returns its original revision/build/version even after a
later edit. Distinct calls with identical arguments remain distinct operations;
changing arguments under an existing identity conflicts.

Repository setup uses an injected `updateRepositorySetupScript` function with
`{orgId, repositoryId, expectedSettingsVersion, operationId, script,
timeoutSeconds, actorUserId}` and the caller's transaction. Selection is checked
against both active and draft configurations under the organization lock. The
repository settings service must preserve unrelated settings and enforce
`expectedSettingsVersion` CAS. Setup edits do not replay operation receipts:
retrying an applied call returns HTTP 409 with
`{result: {conflict: true, version}}`, where `version` is the current repository
settings version, even for the same native call identity. The control-plane
entrypoint wires C4's shared settings writer, translating the tool's repository
UUID to its GitHub identity within the same transaction. A caller that omits the
writer still advertises a false capability and fails closed.

## Lifetime and secrecy

The loopback HTTP endpoint uses a random execution-owned header and checks host,
origin, request/session limits and live lease authority. Product headers enter
the execution transcript redactor before provider launch. Stop, disposal,
expiry or lease retirement closes the endpoint with the execution's other
resources. A build already accepted as an explicit durable action continues
under normal build cancellation and provider-cleanup rules. Superseding a build
does not release its physical allocation or cleanup capacity hold.

The admin workspace's ordinary shell can read the organization environment
injected into that workspace. These five tools constrain control-plane writes
and result projections; they do not establish a separate secret boundary inside
an already authorized shell. Organization environment injection and live
provider qualification remain separate rollout requirements. Admin
creation uses the normal generation settings path, so organization environment
delivery joins through that path when its implementation lands.
