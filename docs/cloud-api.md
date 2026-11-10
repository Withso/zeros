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
`X-Zeros-Session-Id` header identifies the calling chat; v1 validates its shape
but does not use it to grant access.

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
| `400 invalid_request` | Invalid parameters, unknown fields or malformed session attribution |
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
| `Workspace` | `id`, `number`, `name`, `title`, `state`, `status`, `repository`, `branch`, `baseBranch`, `archived`, `createdAt`, `lastActivityAt`, `creatorId`, `creatorName`, `link` |
| `Session` | `id`, `workspaceId`, `name`, `agent`, `model`, `effort`, `archived`, `createdAt`, `updatedAt`, `link` |
| `WorkspaceStatus` | `workspaceId`, `status`, `state`, `updatedAt` |
| `SessionStatus` | `workspaceId`, `sessionId`, `status`, `updatedAt` |
| `Message` | `id`, `sessionId`, `index`, `type`, `content`, `createdAt` |

`Workspace.name` is the workspace name; `title` is its optional display title.
The rename endpoint sets `title`. `state` is the stored cloud lifecycle state.
The friendlier `status` is `initializing` for creating/starting, `ready` for
running, `sleeping` for stopping/stopped, `failed` or `deleting`. The separate
archive flag takes precedence and yields `archived`.

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
| `POST /sessions` | Session creation body below | `201 { session, message: { id } }` |
| `GET /sessions/{id}` | — | `Session` |
| `GET /sessions/{id}/status` | — | `SessionStatus` |
| `POST /sessions/{id}/cancel` | No body required | `SessionStatus`; stops the current turn and drops queued prompts |
| `POST /sessions/{id}/rename` | `{ name }`, session-name bounds | `Session`; changes the title without waking the workspace |
| `POST /sessions/{id}/archive` | No body required | `Session`; archives an idle session without waking the workspace |
| `POST /sessions/{id}/unarchive` | No body required | `Session`; unarchives it without waking the workspace |
| `GET /sessions/{id}/messages` | Pagination; optional `after=<message id>` | Page of `Message` |
| `POST /sessions/{id}/messages` | `{ message, messageId? }` | `201 { message: { id } }`; `200` on replay |
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
  message?, messageId?, sessionName? }
```

`repository` is `owner/repository`. The optional workspace `name` is trimmed,
1–200 characters; it defaults to the repository name. Branch names use the
existing cloud Git branch rules (1–255 characters). If omitted, `baseBranch`
uses the recorded default and `branch` is generated. Creating with `message`
requires `agent` (`codex`, `claude` or `cursor`). The workspace, first session
and queued prompt are committed together. `messageId` and `sessionName`
require a message.

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

The desktop still renames through the worker with a whole chat row. A desktop
edit racing an unapplied API edit is last-writer-wins on the worker.

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
