# Zeros Cloud API

The Cloud API manages the caller's cloud workspaces and sessions inside one
organization. It does not expose Local Personal or organization-local workspaces.
HTTP uses `<control plane origin>/api/v0`; remote MCP uses `/api/mcp` on that
origin. Both use the same service and authorization rules.

## Credentials

Send `Authorization: Bearer <credential>` on every request. These credentials
are separate from desktop sign-in and do not require desktop compatibility
headers.

| Credential | Scope | Storage and lifetime |
| --- | --- | --- |
| User API key (`zk_` plus 43 base64url characters) | Its creator, in one organization | Only a SHA-256 hash is stored. The key is shown once at creation and remains usable until revoked or its authority is lost. |
| Workspace token (`zw2a_` plus 43 base64url characters) | The workspace's creator, in its organization | A hash authenticates requests; an envelope-encrypted copy supports exact redelivery. One token is stable for a VM run, bound to the workspace's stop generation. |

A workspace token can operate on other cloud workspaces created by that user
in the same organization. It cannot manage API keys. The VM is the credential's
trust boundary; sessions, agents and terminals inside it are not isolated from
each other.

Every request checks that the user is active, remains an eligible organization
member, and the organization allows cloud workspaces. Workspace and session
access stays creator-only. Another member's workspace or an object outside the
credential's organization returns `404 not_found`.

A workspace token also requires `api_access`, a matching stop generation, an
unarchived workspace, and state `creating`, `starting` or `running`. It has no
wall-clock expiration while that VM run lives. It is invalid as soon as a stop,
archive or delete is recorded. Wake mints a new token. Worker restarts and runtime
adoption within the same VM run keep the token unchanged, including candidate
configuration, rollback and cancellation. An unreadable encrypted copy causes
configuration to omit `api`; it never rotates the current run's token.

## Workspace API access

Workspace API access defaults to **true** per user and organization. The
WorkOS-authenticated setting routes are:

| Method and path | Body or response |
| --- | --- |
| `GET /v1/cloud-v2/organizations/:org/api-access` | `{ "workspaceApiAccess": true }` |
| `PUT /v1/cloud-v2/organizations/:org/api-access` | Body and response: `{ "workspaceApiAccess": boolean }` |

New workspace creation copies the creator's current setting into `api_access`.
An opted-out user's new workspaces have `api_access = false`; changing the
setting does not change existing workspaces.

Existing workspaces receive API access too. Migration `0226_cloud_api.sql` adds
`api_access boolean NOT NULL DEFAULT true`, enabling rows that predate the
column and rows inserted by an older control plane during rollout. The first
configuration for a worker advertising `workspace-api-v1` supplies its token,
whether that happens on wake or during a live runtime update. A worker without
that exact feature receives no `api` field. Apply the migration before running
the new control plane; the migration barrier protects the API and worker routes
while required migrations are pending.

## API key management

Open the web app, select an organization, and choose **API keys**. A member sees
their own keys; an organization owner or admin can list and revoke every key in
that organization. Creating a key always assigns it to the signed-in user.
Copy a newly created key before closing its dialog; it cannot be retrieved later.
Organizations without cloud workspaces can list and revoke existing keys, but
creation returns `409 cloud_workspaces_not_enabled`. The page shows that state
instead of a Create button.

The web app uses its authenticated control-plane proxy for these
WorkOS-authenticated routes:

| Method and path | Result |
| --- | --- |
| `GET /v1/organizations/:org/api-keys` | `{ apiKeys: [{ id, name, ownerUserId, ownerName, prefix, createdAt, lastUsedAt }] }` |
| `POST /v1/organizations/:org/api-keys` | Body `{ name }` (1–80 characters); `201 { apiKey, key }`. This is the only response containing the key. |
| `DELETE /v1/organizations/:org/api-keys/:id` | Owner or organization admin; `204` with no body. |

The prefix is the first seven characters. `lastUsedAt` is approximate and
batched. There may be at most twenty active keys per user and organization.
Creation and revocation are audited without key material. Revocation takes
effect on the next request. If a create response is lost, revoke the new entry
and create another key.

## HTTP requests and limits

Use `Content-Type: application/json` when sending a body. Lifecycle actions,
session cancel, and session archive/unarchive accept a bodiless POST without
that header. An operation requiring input still returns `400 invalid_request`
when its body is missing or empty. Responses have
`Cache-Control: no-store`. Request bodies are limited to 8 MiB. Creation,
rename and message bodies are strict: unknown fields return
`400 invalid_request`. The optional
`X-Zeros-Session-Id` header identifies the calling chat. A workspace token may
attribute work only to a chat in its own workspace; a user key may attribute it
to any of the caller's chats in that organization. Missing, malformed,
ambiguous or inaccessible IDs are ignored. Attribution grants no access.

Workspace creation, session creation and queued messages retain the validated
ID as nullable, read-only `createdBySessionId`. The first message and session
created with a workspace receive it too. Replays retain the original value,
even when their header changes. Worker history updates and deletion of the
calling chat do not erase it. HTTP, MCP and CLI JSON expose the same field.

Paginated lists accept `limit` (1–100, default 20) and `offset` (a nonnegative
integer, default 0), and return:

```json
{ "data": [], "offset": 0, "hasMore": false }
```

The model catalog has its own `{ data }` envelope and is not paginated.
Workspace and session lists exclude archived rows by default; use
`includeArchived=true` to include them. Deleted workspaces and terminal chats
are not returned as sessions.

HTTP and MCP share these budgets:

| Budget | Limit |
| --- | --- |
| Requests per credential | 240 per minute |
| Workspace-create requests per user API key | 60 per hour |
| Workspace-create requests per workspace token | 10 per hour |
| Workspace creation through any of one creator's workspace tokens in an organization | 10 workspaces in the preceding hour, enforced in the database across replicas |
| Failed credential lookups per client address | 1,200 per minute |

The credential and address gates are in-memory fixed windows. Valid credentials
do not spend the address budget, so VMs sharing an egress address can poll
independently. Once the failed-lookup budget is exhausted, new lookups from
that address are refused until the window resets. Credential shape validation
rejects malformed values before a database read.

The durable workspace-token budget counts that creator's workspace creations
in the organization from every source, including user keys and the desktop,
even if a workspace is later deleted. A new workspace's token inherits this
shared budget; it cannot multiply the allowance. An idempotent creation replay
does not create another workspace or spend this durable budget, but it still
passes through the request limits. `429` responses carry `Retry-After` in
seconds. Key management has a separate 60 requests/minute signed-in-user gate.

Errors use the control-plane envelope:

```json
{ "error": { "code": "not_found", "message": "Not found" } }
```

| Status | Meaning |
| --- | --- |
| `400 invalid_request` | Invalid parameters or unknown fields |
| `401 unauthorized` | Missing, malformed, unknown or revoked credential, or authority lost since the preceding request |
| `404 not_found` | Missing or inaccessible object, or an unsupported v1 route |
| `409 idempotency_conflict` | A creation key was reused with different content |
| `409 prompt_conflict` | A message ID was reused with different prompt content |
| `409 workspace_archived` | Unarchive before creating a session or sending a message, including a replay |
| `409 session_busy` | Cancel a working session before archiving it |
| `409 worker_update_required` | A running workspace needs a worker advertising `chat-edit-v1` before its sessions can be renamed or archived |
| `413 payload_too_large` | Request body exceeds the limit |
| `413 message_too_large` | A mirrored message cannot fit the bounded message-list response |
| `415 unsupported_media_type` | A nonempty request body did not use JSON |
| `429 rate_limited` / `workspace_create_limit` | A request or creation budget is exhausted |
| `503 service_busy` | The database is temporarily unavailable; retry after the returned delay |

Cloud Computer, GitHub authorization and lifecycle errors retain their existing
codes. For example, creating without a built Cloud Computer returns
`409 cloud_computer_build_required`. A repository read refreshes an expired
GitHub user credential through the existing connection service; it never
starts a VM or takes a workspace/source-admission mutation lock.

## Objects

Dates are ISO 8601 strings. A link uses the organization's fixed ID (its slug),
not its UUID. Unnumbered workspaces have a null link.

| Object | Fields |
| --- | --- |
| `Workspace` | `id`, `number`, `name`, `title`, `state`, `status`, `repository`, `branch`, `baseBranch`, `archived`, `createdAt`, `lastActivityAt`, `creatorId`, `creatorName`, `createdBySessionId`, `link`, optional `setup` and `agentCost` |
| `Session` | `id`, `workspaceId`, `name`, `agent`, `model`, `effort`, `archived`, `createdAt`, `updatedAt`, `createdBySessionId`, `link` |
| `WorkspaceStatus` | `workspaceId`, `status`, `state`, `updatedAt` |
| `SessionStatus` | `workspaceId`, `sessionId`, `status`, `updatedAt` |
| `Message` | `id`, `sessionId`, `index`, `type`, `content`, `createdAt`, `createdBySessionId` |

`Workspace.name` is the workspace name; `title` is its optional display title.
The rename endpoint sets `title`. `state` is the stored cloud lifecycle state.
The friendlier `status` is `initializing` for creating/starting, `ready` for
running, `sleeping` for stopping/stopped, `failed` or `deleting`. The separate
archive flag takes precedence and yields `archived`.

`setup`, when reported by a worker advertising `setup-status-v1`, contains
`state` (`running`, `succeeded`, `failed` or `interrupted`), `startedAt` (epoch
milliseconds), and optional `finishedAt`, integer `exitCode` and `reason`
(`timed_out`, `script_refused` or `source_changed`). It contains no script,
path or logs. It remains readable while the workspace sleeps and is absent
until reported. The v2 workspace document exposes the same top-level field;
its strict `capabilities` object is unchanged. Reports do not count as activity
or change lifecycle timestamps.
Workers report this object to `POST /v2/cloud/worker/setup` with their worker
credential and boot headers; an accepted report returns `204`.

`agentCost`, when at least one mirrored prompt has a known cost, is
`{ totalUsd: number, estimated: boolean }`. It sums the recorded
`turnSummary.usage.totalCostUsd` values; `estimated` is true when any contributing
turn is estimated. A known zero appears as zero; no reported costs means the
field is absent. Replays never add twice, and rewrites, chat deletion and
history replacement adjust the total to the current mirror. Earlier turns
remain uncounted until their payload changes; there is no backfill. The same
top-level field appears on v2 workspace documents and stays readable asleep.
Cost changes do not count as activity or change lifecycle timestamps.

A session ID is the chat ID. Its name comes from the mirrored title and is
empty until named. Unselected model/effort fields are null. A session link is
the workspace link with `?session=<id>`. Terminal chats are excluded.

Session status is `working` while a prompt at the current chat epoch is
queued, inboxed, dispatching or accepted; otherwise it is `error` if the newest
prompt failed, or `idle`. A successful send commits its queue row before
returning, so a status request immediately after it sees `working` unless the
turn has already finished. Status polling does not require observing a
transition through `working`.

Messages come from the history mirror. `index` is the one-based position in
the session, `type` is the mirror's message kind, and `content` is its parsed
JSON payload (or the original string if it is not JSON). Sending returns the
message ID before the worker necessarily mirrors the message itself. Reads
never wake a VM and may lag worker activity.

## HTTP endpoint reference

All paths in this table are relative to `/api/v0`. Responses are `200` unless
another status is listed. Single-object responses are unwrapped unless shown
otherwise.

After creating a key, set `ZEROS_API_KEY` in your calling process's environment
and `ZEROS_API_URL` to `<control plane origin>/api/v0`. For example:

```sh
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $ZEROS_API_KEY" "$ZEROS_API_URL/repositories"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer $ZEROS_API_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: <unique-operation-id>' \
  --data '{"repository":"owner/repository","agent":"codex","message":"Review the tests","sessionName":"Test review"}' \
  "$ZEROS_API_URL/workspaces"
```

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /me` | — | `{ userId, email, name?, organizationId, organizationName, credential, workspaceId? }` |
| `GET /models` | — | `{ data: [{ agent, models: [{ id, effortLevels? }] }] }` |
| `GET /repositories` | Pagination | Page of `{ repository, defaultBranch }` from the caller's Cloud Computer source access |
| `GET /workspaces` | Pagination; `state`, `repository`, `name` substring, `includeArchived` | Page of `Workspace` |
| `POST /workspaces` | Creation body below; optional `Idempotency-Key` header | `201 { workspace, session? }` |
| `GET /workspaces/{id}` | — | `Workspace` |
| `GET /workspaces/{id}/status` | — | `WorkspaceStatus` |
| `POST /workspaces/{id}/rename` | `{ name }`, trimmed 1–120 characters | `Workspace` with the new title |
| `POST /workspaces/{id}/archive` | No body required | `Workspace`; records archive and stops the VM |
| `POST /workspaces/{id}/unarchive` | No body required | `Workspace`; clears archive and starts the VM |
| `POST /workspaces/{id}/sleep` | No body required | `Workspace`; requests stop |
| `POST /workspaces/{id}/wake` | No body required | `Workspace`; requests start |
| `GET /workspaces/{id}/sessions` | Pagination; `includeArchived` | Page of `Session` |
| `POST /sessions` | Session creation body below | `201 { session, message: { id, createdBySessionId } }` |
| `GET /sessions/{id}` | — | `Session` |
| `GET /sessions/{id}/status` | — | `SessionStatus` |
| `POST /sessions/{id}/cancel` | No body required | `SessionStatus`; stops the current turn and drops queued prompts |
| `POST /sessions/{id}/rename` | `{ name }`, session-name bounds | `Session`; changes the title without waking the workspace |
| `POST /sessions/{id}/archive` | No body required | `Session`; archives an idle session without waking the workspace |
| `POST /sessions/{id}/unarchive` | No body required | `Session`; unarchives it without waking the workspace |
| `GET /sessions/{id}/messages` | Pagination; optional `after=<message id>` | Page of `Message` |
| `POST /sessions/{id}/messages` | `{ message, messageId? }` | `201 { message: { id, createdBySessionId } }`; `200` on replay |
| `GET /sessions/{id}/messages/{messageId}` | — | `Message` |

The model list mirrors the repository's existing catalog. `effortLevels` is
omitted when the catalog does not declare it; credentials and runtime support
still determine which models a workspace can run.

Message lists are ordered from the start of the session. `after` selects only
messages later than the named message; `offset` then skips that many additional
messages. The returned offset is absolute within the session. An unknown
anchor returns `404`. Message pages have an 8 MiB bound and may contain fewer
rows than `limit` with `hasMore: true`; use the last returned ID for the next
`after` request.

### Workspace and session creation

`POST /workspaces` accepts:

```text
{ repository, name?, branch?, baseBranch?, agent?, model?, effort?,
  message?, messageId?, sessionName?, env? }
```

`repository` is `owner/repository`. The optional workspace `name` is trimmed,
1–200 characters; it defaults to the repository name. Branch names use the
existing cloud Git branch rules (1–255 characters). If omitted, `baseBranch`
uses the recorded default and `branch` is generated. Creating with `message`
requires `agent` (`codex`, `claude` or `cursor`). The workspace, first session
and queued prompt are committed together. `messageId` and `sessionName`
require a message.

`env` is an optional map of application variable names to strings, with at most
50 entries. Each value is at most 8 KiB in UTF-8 and all values together at most
64 KiB; empty strings are allowed, NUL bytes are not. Names follow the existing
Cloud environment rules (1–128 ASCII letters, digits or underscores, starting
with a letter or underscore). Runtime, GitHub and agent credential names remain
reserved. Exactly `ZEROS_API_KEY` is user-settable; `ZEROS_API_URL`,
`ZEROS_API_TOKEN`, `ZEROS_WORKSPACE_ID` and `ZEROS_SESSION_ID` are reserved.
Invalid input returns `400 invalid_request`.

Workspace values override the creator's saved Cloud values for that repository.
The merged variables and saved files must also fit the existing Cloud
environment limits. Creation stores a private encrypted version and pins it to
the workspace in the creation transaction. It does not change the saved
defaults. Later default edits and idempotent replays cannot change that pin;
changing `env` on a replay returns `409 idempotency_conflict`. Map entry order
does not change the creation identity.

Creates with nonempty `env` finish the existing source check before returning,
so older lifecycle replicas receive a workspace with verified sources and
its complete environment pin. The worker receives the values through its
existing environment configuration and redaction path. API and MCP reads never
return the values. Workspace deletion releases the private version; checkpoint
and environment-file handling stay the same as for saved Cloud environments.
MCP `create_workspace` accepts the same `env` map.

`POST /sessions` requires the first message:

```text
{ workspaceId, agent, message, model?, effort?, name?, sessionId?, messageId? }
```

Messages are nonempty text. Optional model IDs are 1–256 characters and effort
values 1–64. Session and message IDs default to generated UUIDs; supplied IDs
are 1–256 characters, cannot start with `cloud:`, and cannot contain ASCII
control characters U+0000–U+001F. URL-encode supplied IDs in paths.

Session `name` and first-session `sessionName` are 1–120 characters after
trimming and cannot contain control characters. The name is stored beside the
first prompt and seeds the discoverable chat row. A worker advertising
`session-name-v1` receives it outside the prompt payload and applies it only
when that delivery creates the chat. It is not injected into the agent's
message, cannot rename an existing chat, and replay changes nothing. The
worker's first mirror preserves the name. With an older worker, its first
empty-title mirror replaces the seeded name; upgrade the runtime for durable
API-created names.

Sending to a sleeping workspace wakes it. An archived workspace must be
explicitly unarchived first; both new sessions and messages return
`409 workspace_archived`, including retries of previously accepted IDs.

### Session rename, archive and unarchive

Session edits appear immediately in the history mirror, including while the
workspace sleeps. Rename accepts a trimmed name of 1–120 characters with no
control characters. Archive returns `409 session_busy` while the session is
working; cancel its current turn first. Terminal chats and sessions outside
the caller's creator/organization scope return `404`.

These edits preserve `Session.updatedAt`, never wake the VM, and do not count
as activity or pending prompts for idle stop. A running workspace must have a
worker that advertised `chat-edit-v1`; otherwise all three operations return
`409 worker_update_required`. Stopped workspaces accept edits for the runtime
installed at their next wake. Workspace archive and session archive are
separate: unarchiving a session does not unarchive or start its workspace.

The worker's chat store remains authoritative. Migration `0228_cloud_chat_edits.sql`
adds one coalesced pending edit per chat with a growing version. Acceptance
updates that row and the mirror in one transaction. Until acknowledged, every
worker mirror write retains the pending title/archive fields and updates
other fields normally. A mirrored deletion removes the pending edit.

Only workers advertising `chat-edit-v1` receive `chatEdits` on prompt pull.
Each reply offers at most 128, least recently offered first. An edit is
reoffered when its version changes, a new worker boot pulls, or at least
30 seconds have elapsed. Previously offered edits wait until a held poll
finishes; they do not make it return immediately.

The worker applies an edit once per version, preserves the chat's `updatedAt`,
and sends its updated chat row with `chatEditAcks` in the same sequenced
history batch. The control plane writes that batch's rows before clearing an
edit whose acknowledged version is at least the pending version. An older
acknowledgement leaves newer fields pending. Within a boot, history gaps are
rejected and already-processed older batches cannot overwrite the mirror.

The app uses the WorkOS-authenticated
`POST /v1/cloud-v2/workspaces/:id/chats/:chatId/edit` route for the same
creator-only operation. Its strict body is `{ title?, archived? }`, with at
least one field. Titles have the same bounds as API session names. It returns
`200 { chat: { id, title, archived } }` and the same `session_busy` and
`worker_update_required` refusals. The edit never wakes the workspace or
refreshes GitHub credentials, and rechecks the signed-in session in the mutation
transaction.

V2 workspace documents advertise this route with top-level `chatEdits: 1`.
It is deliberately outside `capabilities`, whose strict schema is already used
by released desktops. Desktops that support this field use the route for
rename, archive and unarchive, including while asleep. Without it, they keep
the worker chat-write path. Local workspace edits stay unchanged. An older
desktop's worker edit racing an unapplied API edit remains last-writer-wins
on the worker.

### Safe retries

Use a fresh `Idempotency-Key` for each intended workspace creation and reuse
it with the same body after a lost response. It accepts 1–200 printable ASCII
characters without spaces. The existing creator-scoped receipt returns the
original `{ workspace, session? }` snapshot and prevents another VM or first
prompt. Reusing the key with different content returns `409`.

For a session, supply and retain both `sessionId` and `messageId` before
sending the request. For subsequent messages, retain `messageId` and the same
text. An identical send returns the original message ID; different text with
the same ID returns `409 prompt_conflict`. Without these IDs, a retry is a new
message. All retries still recheck current authorization.

## Remote MCP

Connect an MCP client using Streamable HTTP to
`<control plane origin>/api/mcp`, with the same `Authorization: Bearer
<credential>` header. OAuth discovery and browser sign-in are not provided by
this endpoint. The client sends JSON-RPC POST requests with
`Accept: application/json, text/event-stream`. The server uses JSON responses,
keeps no MCP session, and reauthenticates every request. GET/SSE subscriptions,
DELETE sessions and JSON-RPC batches are not supported. If an `Origin` header
is supplied, it must match the endpoint's origin.

`tools/list` exposes strict argument schemas. Each tool calls the same service
operation as HTTP and returns the same document in both `structuredContent`
and JSON text content. Domain and validation failures set `isError: true` and
return `{ error: { code, message } }`. Authentication and the shared request
limiter can reject the HTTP request with `401` or `429` before tool execution.
A tool-level create limit returns an MCP error result and `Retry-After`.

| Tool | Arguments |
| --- | --- |
| `whoami`, `list_models` | `{}` |
| `list_repositories` | `limit?`, `offset?` |
| `list_workspaces` | Pagination and the HTTP workspace filters |
| `create_workspace` | HTTP creation fields plus `idempotencyKey?` |
| `get_workspace`, `get_workspace_status` | `workspaceId` |
| `rename_workspace` | `workspaceId`, `name` |
| `archive_workspace`, `unarchive_workspace`, `sleep_workspace`, `wake_workspace` | `workspaceId` |
| `list_workspace_sessions` | `workspaceId`, pagination, `includeArchived?` |
| `create_session` | HTTP session-creation fields |
| `get_session`, `get_session_status`, `cancel_session` | `sessionId` |
| `rename_session` | `sessionId`, `name` |
| `archive_session`, `unarchive_session` | `sessionId` |
| `send_message` | `sessionId`, `message`, `messageId?` |
| `list_messages` | `sessionId`, pagination, `after?` |
| `get_message` | `sessionId`, `messageId` |

Use JSON booleans for MCP `includeArchived`. HTTP and MCP requests using the
same credential share its request and creation budgets. A workspace token
whose own VM is stopped or archived loses access to both transports, even if
it was controlling a different workspace.

## VM environment and CLI

The runtime provides these variables to agent and terminal processes:

| Variable | Meaning |
| --- | --- |
| `ZEROS_API_URL` | API base ending in `/api/v0`, when API access is delivered |
| `ZEROS_API_TOKEN` | This VM run's workspace token, when delivered |
| `ZEROS_WORKSPACE_ID` | Workspace UUID; always set |
| `ZEROS_SESSION_ID` | Chat ID; set for agent processes |
| `ZEROS_API_KEY` | Optional user-supplied key, preferred over the workspace token by the CLI |

The `ZEROS_` prefix is reserved in Environment settings except for exactly
`ZEROS_API_KEY`. Users cannot replace the other four variables. Credentials
are redacted from transcripts and diagnostics and are not delivered to setup
script logs.

The runtime ships the dependency-free `zeros cloud` command on PATH. It reads
`ZEROS_API_KEY` first, then `ZEROS_API_TOKEN`, and uses `ZEROS_API_URL` as its
base. Workspace arguments default to `ZEROS_WORKSPACE_ID` where applicable;
the calling chat is attributed with `X-Zeros-Session-Id` when set. Examples
inside a configured VM:

```sh
zeros cloud me --json
zeros cloud models --json
zeros cloud repo list --json
zeros cloud message send --session '<session-id>' --message-file ./request.txt \
  --message-id '<stable-message-id>' --json
zeros cloud session wait '<session-id>' --timeout 120 --json
zeros cloud session messages '<session-id>' --after '<message-id>' --json
zeros cloud session rename '<session-id>' --name 'Review complete' --json
zeros cloud session archive '<session-id>' --json
zeros cloud session unarchive '<session-id>' --json
```

`--json` prints the API object unchanged. List commands support `--limit` and
`--offset`; message lists support `--after`. `session wait` polls until `idle`
or `error`, or its timeout, without waking the VM. CLI exit codes are 0 for
success, 1 for runtime failure, 2 for usage, 3 for authentication and 4 for
server errors. Credentials are never printed, including with `--debug`.
`zeros local` retains its Local-only behavior.

The VM's existing `zeros-workspace` MCP server is separate from the remote API.
Its `GetTerminalOutput` and `GetWorkspaceDiff` tools read the current workspace;
they are not additional remote Cloud API routes.

## Commands on a connected Mac

The cloud worker's `zeros_workspace` MCP server exposes `RunLocalCommand` when
the worker advertises `local-commands-v1`, its configuration has
`localCommands: 1`, the durable prompt outbox is enabled, and the organization
allows local commands. This tool is absent from `/api/mcp` and from Local
workspaces. Personal and organization-local execution stays on the Local
engine.

The tool accepts `command`, with optional `cwd`, `description`, `reason`,
`timeoutMs`, `extendedTimeoutReason` and `mac`. The command is at most 16,384
characters, cwd 4,096, descriptions and reasons 1,000 each, and a Mac name 128.
Values must be nonblank and contain no NUL. Timeout defaults to 60 seconds;
above 120 seconds an extended reason is required, with a 30-minute maximum.
Approval has a separate 120-second deadline. Each output stream is limited to
1 MiB of UTF-8; larger tool presentations are saved in the VM's `.context/`.

Only the target Mac approves and runs a command. The control plane resolves
the target from the chat's latest verified desktop message. Later messages
from the same person through an API key, `zeros cloud`, remote MCP, a workspace
token or a desktop without device headers inherit that binding. A desktop
message from another Mac moves it; a message by a different person never
inherits it. Without a prior desktop binding, the result is `no_target`, even
when `mac` is supplied. Non-desktop sends cannot establish a new binding or
reconnect a disconnected Mac. The prompt's body, hash and delivery do not
contain the device identity; idempotent prompt retries never retarget it.
Every new turn still cancels in-flight local commands, even when its Mac is
unchanged. A new message after chat Stop can inherit the same Mac.

The default target is the Mac that sent that chat's latest desktop message.
An explicit `mac` is an exact, case-sensitive name of another connected Mac belonging to
the same sender. An explicit target always asks for approval, including when
it names the default Mac. Unreachable or ambiguous targets return
`mac_not_connected`; there is no fallback or broadcast. These two recovery
outcomes include `connectedMacs: [{ name, isDefault }]`, at most 20 names from
that sender's eligible devices, with no user or device IDs.

Desktop device routes use a normal WorkOS desktop bearer. All except
registration also require `X-Zeros-Device-Id`, `X-Zeros-Device-Registration`
and `X-Zeros-Device-Instance`. The server issues registration and instance
UUIDs bound to the exact account and sign-in session. API credentials cannot
use these routes. The same three optional headers on
`POST /v1/cloud-v2/workspaces/:id/prompts` are verified inside enqueue; all must
be present together. A stale supplied binding is refused.

| Desktop route | Purpose |
| --- | --- |
| `PUT /v1/cloud-v2/devices/:deviceId` | Register with `{ requestId, name, capabilities: ["local-commands-v1"] }`; preserve requestId across retries |
| `DELETE /v1/cloud-v2/devices/:deviceId` | Unregister before sign-out |
| `POST /v1/cloud-v2/devices/:deviceId/heartbeat` | Renew a connected device's 65-second presence lease |
| `GET /v1/cloud-v2/devices/:deviceId/events` | Account-level SSE, including when no workspace is open |
| `GET /v1/cloud-v2/workspaces/:id/macs` | Read the caller's connected-Macs choices without waking the VM |
| `POST /v1/cloud-v2/workspaces/:id/macs/:deviceId/connect` | Connect from that Mac itself |
| `POST /v1/cloud-v2/workspaces/:id/macs/:deviceId/disconnect` | Disconnect one of the caller's Macs |
| `GET /v1/cloud-v2/devices/:deviceId/requests/:requestId` | Read the target registration's notice |
| `POST` to that request's `/received`, `/claim`, `/result`, `/ack` | Acknowledge delivery, submit a local decision, report the result, acknowledge the terminal notice |

`/claim` accepts `{ decision: "approve" | "deny" }` once. `/result` accepts
`{ result }`. Other actions accept an absent body or `{}`. Requests with JSON
bodies require `application/json`; unknown fields are rejected. SSE events are
`ready`, `presence`, `request`, `heartbeat`, `revoked` and `notify`. Reconnect replays
durable command notices; `notify` events are never replayed. A command notice carries input while pending or claimed, and only the
outcome after termination; it never carries output or grants execution.
The Mac journals its decision before claiming and reconciles a lost reply by
reading the same request, never by executing again.

The latest app-sending Mac in a workspace remains connected until disconnected
or signed out. Other connections expire 12 hours after connect, a message or
a claimed command. Heartbeats do not extend this clock. A Mac connected
nowhere sends no presence heartbeat. Its SSE connection uses at most two
indexed reads per 25 seconds; a connected Mac adds at most one lease update
per 25 seconds, excluding normal authentication work.

Worker requests use the worker bearer, `X-Zeros-Worker-Boot` and
`X-Zeros-Worker-Features: local-commands-v1`:

| Worker route | Request and response |
| --- | --- |
| `POST /v2/cloud/worker/local-commands` | `{ requestId, chatId, executionId, input }`; 201 receipt, or 200 for an identical retry |
| `GET /v2/cloud/worker/local-commands/:requestId?waitMs=25000` | Receipt; waitMs is 0–25,000 and holds no database connection |
| `POST /v2/cloud/worker/local-commands/:requestId/cancel` | Idempotently cancel and return the receipt |
| `POST /v2/cloud/worker/local-commands/:requestId/ack` | Erase retained input/output after the worker consumes the result; 204 |
| `POST /v2/cloud/worker/local-commands/retire-sender` | `{ chatId, executionId }`; secondary fence for legacy relay sends |

A receipt contains `requestId`, `state` (`pending`, `claimed`, `terminal`),
`approvalDeadline`, nullable `runDeadline` and `mac`, nullable `result`, and
`outputAvailable`. Request IDs are UUIDs preserved across retries; different
input for the same ID returns `409 local_command_conflict`. The VM cannot
choose a user or device. Stop, a new chat message, sign-out, boot or workspace
authority changes fence outstanding work. Pending and claimed commands also
prevent idle stop. Reads, retries and device connection changes never wake a
VM. Legacy relay prompts retire bindings in the control plane before forwarding.

Outcomes are `completed`, `failed`, `denied`, `approval_timed_out`,
`command_timed_out`, `mac_not_connected`, `no_target`, `disabled`, `cancelled`
and `interrupted`. A request not delivered within 10 seconds becomes
`mac_not_connected`. An app restart interrupts a claimed command; it cannot be
claimed again. A failed launch has exactly `error: "cwd_not_found"` or
`"spawn_failed"` and no exit code. Transport and database failures remain
availability errors; they never invent a denial or command outcome.

Input and output use the existing envelope encryption keyring with separate
purpose and request identity. They are erased after worker acknowledgement or
24 hours after termination. A bounded receipt retains the request hash,
outcome, Mac name, recovery hints and a failed launch's closed error reason,
never its command, path or output. Chat or workspace deletion removes receipts.
Creation limits are durable across replicas: 10/minute/chat and sender,
30/minute/device, two outstanding/chat, four/device, 128 unacknowledged notices
per current device registration, and 10,000 receipts/workspace. Output reserves
are capped at 32 MiB/device and 64 MiB/workspace. Reads and identical retries
do not consume creation quotas. Capacity errors return `429` with `Retry-After`.

Organization members read `GET /v1/cloud-v2/organizations/:org/local-commands`.
Owners and admins can `PUT` `{ localCommandsEnabled: boolean }` to the same
route. It defaults to true. Disabling ends outstanding commands with `disabled`
and refreshes worker configuration. Older workers receive no new field;
new workers receiving an old configuration expose no local-command tool.

## NotifyUser

Cloud agents can use `NotifyUser { title, message, kind }` through
`zeros_workspace`. `kind` is `review` or `blocked`; nonblank title and message
are limited to 80 and 280 characters. Worker configuration includes
`notifyUser: 1` only with the exact `notify-user-v1` feature and the durable
prompt outbox. This feature is independent of the local-command organization
switch and does not change Local workspaces.

The worker sends `POST /v2/cloud/worker/notifications` using its worker bearer,
`X-Zeros-Worker-Boot` and `X-Zeros-Worker-Features: notify-user-v1`. Its strict
JSON body is:

```json
{
  "notificationId": "11111111-1111-4111-8111-111111111111",
  "chatId": "chat-id",
  "userMessageId": "active-turn-user-message-id",
  "executionId": "native-session-id",
  "kind": "review",
  "title": "Ready for review",
  "message": "The change and its tests are ready."
}
```

The three chat/message/execution IDs are 1–256 characters without C0 control
characters. The server accepts one notification per `(chatId, userMessageId)`;
`executionId` may be reused by later turns. Success returns `202` with no body.
Replaying the same notification ID and input is inert; changed input returns
`409 notification_conflict`. A second notification for a turn returns
`409 already_notified`. New notifications share a rolling budget of thirty per
hour per workspace across replicas, boots and chat deletion; excess returns
`429 rate_limited` with `Retry-After`. Identical retries consume no budget.

Delivery uses the account-level device channel's `notify` event:
`{ notificationId, workspace: { id, name, title }, chat: { id, title }, kind,
title, message, createdAt }`. `createdAt` is an ISO timestamp. Every currently
registered Mac of the latest verified desktop sender is eligible, even with no
workspace connection or presence lease. The latest message selects the sender
separately from the notifying turn and inherits the same person's desktop
binding across API, CLI, remote MCP, agent and headerless desktop messages.
A different person never inherits that binding. If the chat has no verified
desktop sender, the server accepts the notification but sends no channel
event; the worker also delivers to attached apps over the bridge.

Channel delivery is best effort, lives for ten minutes and never replays after
reconnection. Late delivery rechecks the receiver's sign-in and registration,
workspace access, run and chat sender. Delivery does not wake the VM or extend
its idle clocks. The event text is erased after ten minutes; a compact hash
receipt remains until chat or workspace deletion so a retry cannot notify again.
At most 10,000 receipts are retained per workspace (`429 notifications_full`
when full). No notification text is sent in PostgreSQL notification hints or
written to server logs.

## Restart and v1 scope

The desktop's WorkOS-authenticated route
`POST /v1/cloud-v2/workspaces/:id/restart` returns `202 { workspace }`. It
records a stop-generation-fenced restart intent and starts only after Boat
confirms the stop. A later stop, archive or delete cancels the intent; terminal
stop failure clears it. Stopped and failed workspaces use the existing start
behavior. Creating without an assigned VM, and deleting, return `409`.
This route is outside `/api/v0` and is not a remote MCP tool.

V1 does not expose routines, SQL, attachments, sections, previews, or workspace
deletion. Those HTTP routes return
`404`, and they are absent from the remote tool list. Cloud API access does
not add Browser, Design or simulator capabilities to a cloud workspace.
