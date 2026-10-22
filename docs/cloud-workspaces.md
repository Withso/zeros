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

## VM, connections and runtime

The worker and native Claude, Codex and Cursor drivers run as Boat's stock
`user`, with Node 24 and checkouts at `/home/user/<owner>/<name>`. Agents have
full permissions inside the VM. The VM is the isolation boundary; session
directories and environment allowlists do not isolate conversations from one
another. The worker never imports the Local engine runtime.

The worker listens only on `127.0.0.1:41783`. On create and on every wake,
the control plane registers that port with Boat as a protected route
(`POST /sandboxes/{id}/host` with `localhost: true`). Boat serves it at
`https://<subdomain>-41783.on.boat.dev` and refuses any request without the
route's `_port_auth` cookie. The control plane stores the route URL and the
envelope-encrypted route token; neither appears in workspace documents or
reaches the Mac.

The app obtains a short-lived connection ticket through
`/v1/cloud-v2/workspaces/:id/connect` and opens
`/v2/cloud/workspaces/:id/bridge` on the control plane, as before. The control
plane connects in to the worker's `/v2/worker/bridge` through the Boat route
and relays existing bridge frames with a client identity. Before upgrading,
the worker verifies a single-use Ed25519 grant in `X-Zeros-Worker-Auth`, signed
by the control plane for this workspace and this worker boot and valid for at
most 60 seconds. Anything in the VM can read the route token, so the grant, not
the cookie, is the authority. Any control-plane replica can serve any
workspace: each dials the worker while it has app clients, so the realtime
role needs no app affinity. Multiple app connections can attach, and losing
one does not stop a turn. The control plane never dials a stopped workspace;
Boat's route hangs rather than refusing while the VM sleeps.

The worker keeps outbound HTTPS to the control plane under
`/v2/cloud/worker/*` for work that continues without an attached app: `hello`
and configuration, the history mirror, activity reports and GitHub
installation tokens. Each request carries the worker credential and the
worker's boot identity; history batches are sequenced per boot so a retried
batch is a no-op. A renderer `workspace.list` row from the worker uses native
paths and the workspace UUID, not the HTTP workspace document shape; the
renderer translates native checkout paths and IDs into scoped `cloud://`
identities.

On create and wake, the control plane installs its selected runtime tarball
from object storage, verifies its SHA-256 and caches it under
`/opt/zeros/runtime/<sha256>`. `/opt/zeros/worker` points to that directory.
The runtime is root-owned; `zeros-worker.service` runs `worker.mjs` as `user`.
The same step writes the control plane's public verification keys to
root-owned `/opt/zeros/worker-auth.json`. Every wake rotates the worker
credential in `/home/user/.config/zeros/worker-token` (mode `0600`) and
restarts the worker, which registers a new boot identity in `hello` before the
control plane dials it. The worker rereads the credential on every request.

Each organization has one Cloud Computer: a recipe and an active named snapshot.
A build starts from Boat's stock image, installs the runtime, clones the
selected repositories, runs their setup scripts and records the cloned
branches and commits. A successful build becomes the active snapshot, and
the temporary builder is deleted. New workspaces fork that snapshot. The
worker fetches origin and switches to the workspace branch, creating it from
the selected base only when absent; it never resets an existing branch.
Runtime updates do not require rebuilding the Cloud Computer.

## Testing a branch

[`pnpm cloud:local`](cloud-local.md) runs a branch's control plane, worker
runtime and desktop app together, with an isolated database and a named
tunnel for Boat VMs. Agents run it headless and then gate0 with `--local`.

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
the VM, and neither do reconnects: `/connect` accepts `{ "wake": false }`, and
the single-use ticket carries that intent through bridge admission. The app
asks to wake only for an explicit open; a missing value still wakes, for older
callers. Explicit work over the bridge, or Start, wakes it and reconnects the
worker. Stop
retains the VM disk; Delete removes the VM and revokes its access. Account
and organization deletion also enqueue their workspaces for cleanup.

Archive sets `archivedAt` and requests the same stop lifecycle. The UI treats
a stopped or failed workspace with that flag as archived; idle stop leaves it
unset. Start restores the workspace by clearing the flag, as does a connect
request that wakes a stopped workspace. Archive is refused during creation or
deletion.

## Configuration

The control plane reads these names in
[`src/config.ts`](../apps/control-plane/src/config.ts):

| Environment variable | Purpose |
| --- | --- |
| `CLOUD_V2_ENABLED` | Enables the v2 routes, the app bridge relay and lifecycle roles. |
| `BOAT_API_KEY`, optional `BOAT_BILLING_ORG` | Boat provisioning and billing. |
| `CLOUD_V2_API_URL`, `CLOUD_V2_REALTIME_URL` | Public HTTPS API (also the worker's outbound origin) and the app's WSS bridge origin. |
| `CLOUD_V2_WORKER_SIGNING_KEY`, optional `CLOUD_V2_WORKER_SIGNING_KEY_PREVIOUS` | Ed25519 PKCS#8 private key (base64 DER) that signs worker grants. VMs trust both public keys after their next create or wake, so a rotation keeps the previous key until every running VM has woken with the new trust file. |
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

The worker receives only the non-secret boot settings `CLOUD_V2_API_URL`,
`CLOUD_V2_RUNTIME_SHA256` and `ZEROS_WORKSPACE_ID` in its `worker.env`; its
credential comes from the token file. The Dev hosted-profile launcher takes
`ZEROS_CLOUD_V2_RUNTIME_SHA256` and maps it to the control-plane runtime pin,
and derives each Dev generation's worker signing key.

`pnpm --filter @zeros/cloud-worker build` produces a self-contained `dist/`.
`pnpm --dir apps/control-plane cloud-v2:publish-runtime` builds, packages and
uploads it from a clean Linux x64 checkout. Set the returned archive digest
in the target deployment. Publishing an archive alone does not change running
workspaces; create and wake apply the
configured pin. Tests use fake worker connections and native provider streams;
live verification must also cover the private route, stop, offline history, wake
and deletion.
