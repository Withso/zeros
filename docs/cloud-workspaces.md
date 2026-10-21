# Cloud workspaces

Cloud v2 gives each workspace one Boat VM with a standalone
[`apps/cloud-worker`](../apps/cloud-worker/) process. The desktop shares its
chat, files, Git and terminal UI with Local. Cloud advertises Browser, Design
and simulators as unavailable. Local Personal and organization-local workspaces
keep their own engine, provider permissions and Host lifecycle.

Cloud requires a non-personal organization with `cloud_workspaces_allowed`.
Only the workspace creator can list, connect to or manage it, and they must
still belong to that organization. Organization admins manage the shared
Cloud Computer; ordinary members can read its installed repository list.

## VM, relay and runtime

The worker and native Claude, Codex and Cursor drivers run as Boat's stock
`user`, with Node 24 and checkouts at `/home/user/<owner>/<name>`. Agents have
full permissions inside the VM. The VM is the isolation boundary; session
directories and environment allowlists do not isolate conversations from one
another. The worker never imports the Local engine runtime.

The worker dials out to `/v2/cloud/worker`; the app obtains a short-lived
connection ticket through `/v1/cloud-v2/workspaces/:id/connect`. The control
plane relays existing bridge frames with a client identity. Multiple app
connections can attach, and losing an app connection does not stop a turn.
No inbound VM port is needed. The worker validates bridge messages; the
renderer translates native checkout paths and IDs into scoped `cloud://`
identities. A worker `workspace.list` row uses native paths and the workspace
UUID, not the HTTP workspace document shape.

On create and wake, the control plane installs its selected runtime tarball
from object storage, verifies its SHA-256 and caches it under
`/opt/zeros/runtime/<sha256>`. `/opt/zeros/worker` points to that directory.
The runtime is root-owned; `zeros-worker.service` runs `worker.mjs` as `user`.
The control plane delivers the worker credential to
`/home/user/.config/zeros/worker-token` with mode `0600`. The worker rereads it
on every connection attempt. Checkout and provider configuration arrive over
the authenticated relay after `hello`.

Each organization's Cloud Computer is a recipe and an active named snapshot.
A build starts from Boat's stock image, installs the runtime, clones the
selected repositories, runs their setup scripts and records the cloned
branches and commits. A successful build becomes the active snapshot, and
the temporary builder is deleted. New workspaces fork that snapshot. The
worker fetches origin and switches to the workspace branch, creating it from
the selected base only when absent; it never resets an existing branch.
Runtime updates do not require rebuilding the Cloud Computer.

## Credentials and history

Settings → Agents stores encrypted logins in the control plane. The creator's
organization selection supplies Claude with `CLAUDE_CODE_OAUTH_TOKEN` or
`ANTHROPIC_API_KEY`, and Cursor with `CURSOR_API_KEY`, directly in the VM.
Codex calls `/v2/cloud/proxy/openai/*` with a workspace proxy token;
the upstream credential and ChatGPT renewal stay in the control plane.
Each child receives only its own login through a shared environment allowlist.
Config refreshes replace the entire configuration; idle drivers reopen as
needed, while active turns keep their spawn-time credentials. Git and `gh`
request short-lived GitHub installation tokens through the worker's broker.
Credentials must never be written to transcripts, command arguments or logs.

The worker folds native streams through the shared `applyUpdate` reducer and
persists chat/session state under `/home/user/.local/share/zeros/cloud-worker`.
It mirrors chat metadata, deletions and message rows to the control plane.
The app can read that history while the VM sleeps. This history mirror is
separate from repository files; there is no Mac checkout synchronization.

The lifecycle loop stops a running VM after ten minutes without activity
reports. Turns and recent terminal input/output keep reports flowing; an
untouched shell eventually becomes idle. Passive history reads do not wake
the VM. Explicit work or Start wakes it and reconnects the worker. Stop
retains the VM disk; Delete removes the VM and revokes its access. Account
and organization deletion also enqueue their workspaces for cleanup.

Archive sets `archivedAt` and requests the same stop lifecycle. The UI treats
a stopped or failed workspace with that flag as archived; idle stop leaves it unset.
Start restores the workspace by clearing the flag, as does a connect request
that wakes a stopped workspace. Archive is refused during creation or deletion.

## Configuration

The control plane reads these names in
[`src/config.ts`](../apps/control-plane/src/config.ts):

| Environment variable | Purpose |
| --- | --- |
| `CLOUD_V2_ENABLED` | Enables the v2 routes, relay and lifecycle roles. |
| `BOAT_API_KEY`, optional `BOAT_BILLING_ORG` | Boat provisioning and billing. |
| `CLOUD_V2_API_URL`, `CLOUD_V2_REALTIME_URL` | Public HTTPS API and WSS relay origins. |
| `CLOUD_V2_RUNTIME_SHA256` | Published runtime archive digest. |
| `CLOUD_V2_RUNTIME_STORE_ENDPOINT`, `CLOUD_V2_RUNTIME_STORE_BUCKET` | Runtime object storage. |
| `CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID`, `CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY` | Server-side storage credentials. |

The existing database, authentication and GitHub App configuration is also
required. Agent vault keys retain their persisted deployment names:
`CLOUD_WORKSPACE_SECRET_KEY_V1`, or `CLOUD_WORKSPACE_SECRET_KEYS_JSON` with
`CLOUD_WORKSPACE_SECRET_CURRENT_KEY_VERSION`. Codex renewal retains
`CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON` and
`CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION`. Keep old key versions
available to decrypt existing records.

The worker receives only the non-secret boot settings `ZEROS_WORKER_URL` and
`ZEROS_WORKSPACE_ID` in its `worker.env`; its credential comes from the token
file. The Dev hosted-profile launcher takes `ZEROS_CLOUD_V2_RUNTIME_SHA256`
and maps it to the control-plane runtime pin.

`pnpm --filter @zeros/cloud-worker build` produces a self-contained `dist/`.
`pnpm --dir apps/control-plane cloud-v2:publish-runtime` builds, packages and
uploads it from a clean Linux x64 checkout. Set the returned archive digest
in the target deployment. Publishing an archive alone does not change running
workspaces; create and wake apply the
configured pin. Tests use fake relays and native provider streams; live
verification must also cover stop, offline history, wake and deletion.
