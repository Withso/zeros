# Persistent Dev connections

Hosted Dev can opt into an isolated persistent credential authority. The launcher
deploys it before the disposable backend and registers that exact generation.
Connect once; subsequent disposable databases restore references after normal
WorkOS sign-in. Fake-provider and PostgreSQL tests cover this implementation;
first hosted provisioning and macOS acceptance remain operator actions.
Provider revocation, expiry, and uncertain refresh outcomes can require reconnect.

## Components and trust

- A small Node service uses `src/dev-connections/index.ts`, its own Railway
  project/environment, PostgreSQL database and persistent volume. The Dockerfile
  lives beside the entrypoint. It starts no product controllers or background
  jobs other than bounded audit retention, and uses only its own migrations.
- Broker encryption and refresh-fingerprint key rings, provisioner authority,
  and its database logins never enter portable profiles, disposable R2
  ownership keys, desktop storage, workers, renderer variables, or generation receipts.
  The separate protected encrypted operator registry holds generated root keys
  and receipts; it is unavailable to portable profiles. Separate Railway authority
  prevents profile holders reading service variables (use a separate workspace
  when the portable token spans the disposable workspace). Database owner and runtime logins are
  separate; runtime can assume `zeros_app`, with schema grants and forced RLS.
  Broker WorkOS/GitHub settings come from the private operator file. The existing
  product WorkOS and GitHub OAuth settings remain in the normal Dev profile;
  the GitHub client secret also serves the product's OAuth exchange. Those
  application settings are not broker encryption or provisioning authority.
- The provisioner can register, rotate or revoke exact owner/generation records.
  It cannot list members or read provider credentials. A disposable backend has
  only an expiring generation credential. Generation identity, credential hash,
  audience, selected stable WorkOS organization, expiry and revocation are checked
  again when access is issued. Registration cannot resurrect an archived ID.
- Every member operation verifies the original WorkOS JWT signature, issuer,
  audience, allowed application, subject and session claims using the existing
  token contract. WorkOS must confirm an active session, verified user and current
  membership in the explicitly configured Dev organization. No fixture, email,
  local user UUID, or backend identity assertion substitutes for this check.
- The backend owns current product actor, model, workspace, compute and image
  admission. The broker independently intersects current member consent with the
  requested model/repository. GitHub also checks the actual token's application
  and account plus current installation/repository and user permissions. A
  generation credential alone cannot mint a grant.

## Dedicated data model

All tables below are in `dev_connections`; the checksummed migration ledger is
`public.dev_connections_migrations`. The migrator refuses a product database.

| Records | Contract |
| --- | --- |
| `members` | Unique `(issuer, subject)`; local database UUIDs are not identity. |
| `connections`, `connection_versions` | Member, provider kind/account/app scope, revision, material version, encrypted material and expiry. AES-GCM AAD binds all those identities and key version; only current ciphertext is retained. |
| `organization_consents` | Stable WorkOS org, connection, model/repository/action allowlists, revision and revocation. |
| `generations`, `bindings`, `generation_revocations` | Exact generation plus member, connection and consent revisions; bounded expiry, credential hash and key revision. Permanent archive tombstones also fence registrations that arrive late. |
| `refresh_attempts` | Fenced attempt, material version, `reserved/dispatched/published/uncertain/abandoned`; one pending attempt per connection. |
| `fingerprint_keys`, `refresh_fingerprints` | Key checks and keyed seed tombstones prevent reimport across members, connections, restarts and key rotation. Never prune these to recover a login. |
| `grant_audit` | Member/binding, workspace/model/repository/action, revisions, grant and actual provider expiry. No tokens, JWTs, request bodies or provider errors. Retained 30 days. |
| `revocation_outbox` | Durable generation-scoped cursor stream for archive, disconnect, consent or generation-key invalidation. Consumers keep their cursor; revoked generations receive denial. |

## Flows

**First connect.** The member signs in normally and explicitly supplies a new
provider connection plus organization consent. GitHub validates the token's real
app/client and user; Codex validates the native cache account binding and uses the
pinned native keeper. The broker encrypts centrally and records the seed fence.
Claude setup tokens and API keys, Codex API keys, and Cursor keys use the same
store. Static credentials without provider account claims have a member-scoped
account label; image qualification still proves actual usability.

**Reconnect.** A new GitHub OAuth completion or explicit agent authorization
sends `replaceExisting: true` to the member-authenticated broker connect
operation. For the same member/provider/account/app, one transaction revokes
the former connection and consents, abandons its pending renewal, removes its
material, emits invalidations and installs the fresh authorization. Late
publication by the former owner is rejected. Seed fingerprints remain forever;
supplying an already-used seed rejects and rolls back the entire replacement.
The same connection operation ID is replayable. Normal restore never replaces
authorization, and connect without explicit replacement still rejects duplicates.
New model/repository consent must be selected for the new authorization.

**Fresh generation.** Provisioning journals a random generation credential in its
encrypted receipt before registration. After WorkOS sign-in, `client.ts` sends
only that generation authority and the member bearer. Restore returns metadata
and references for that exact member/org. The database restore port
rechecks local identity/membership revisions and atomically replaces references
and fresh local consent. It cannot copy old consent fingerprints, grants, quota,
workspace data, runtime approvals or image qualification. An outage retains the
last local metadata but prevents new issuance.

**Refresh.** PostgreSQL serializes the connection across all generations and
replicas. Only a reservation that has not dispatched can expire/reclaim. Dispatch
commits before native Codex startup or GitHub's OAuth request. The original owner
may publish a proven late result; observers never take over a dispatched seed.
Only publication of the known result retries, with readback after an ambiguous
COMMIT. A lost provider result becomes `uncertain`, including after process death,
and requires reconnect. GitHub and Codex share this journal policy. A competing
request waits briefly and uses the published version or fails closed.
The broker retains a confirmed refresh-only native cache rotation even when its
access token is still expired. It denies access and applies the native keeper's
one-minute renewal cooldown; it never discards the known replacement seed just
because access is not usable yet.

**Grant.** Recheck generation, member, consent, connection and binding after
refresh/network permission checks. Issue only access material; never a Codex
native cache or GitHub/Codex refresh token. Grant expiry is at most five minutes
and no later than member JWT, generation, binding or actual provider expiry.
A provider bearer is not cryptographically restricted by that metadata. Static
keys and already-issued bearers may remain usable until actual provider expiry
or revocation. GitHub writes remain behind the constrained proxy. Agent admission
and every lease validation drain the durable invalidation cursor; invalidation
revokes delegations/releases leases, and an outage cannot renew them. Agent
leases are capped at 45 seconds and by the broker grant, including persisted
and replayed leases. GitHub native leases last at most 60 seconds; every proxy
authorization rechecks invalidations and local membership. GitHub's rotating token
behavior and user/app permission intersection are documented by
[GitHub](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
and its [authorization API](https://docs.github.com/en/rest/apps/oauth-applications).

**Revoke.** Disconnect immediately prevents future broker grants for every
binding, deletes current ciphertext, increments revision, and records outbox
invalidations. Revocation racing refresh wins before issuance. Organization
consent removal invalidates that organization's bindings. It does not promise
to erase a credential already delivered to a running native client.
All event writers acquire a shared transaction lock before their identity/row
locks and retain it through commit. The sequence watermark cannot overtake an
uncommitted earlier event, including revocations across multiple generations.

**Archive.** Revoke only the exact generation before removing disposable
resources. Other generations and the persistent connection remain usable.
Registration and archive serialize on the generation ID, including when archive
arrives first; archive records a permanent tombstone rather than a no-op.
The new provisioning helper records pending revocation before its network call;
an outage leaves a durable retry task for GC after the checkout disappears.
Compute shutdown proceeds independently. Archive/GC union configured and recorded
`connectionProtection`, protecting the entire persistent project even before
resource IDs are known. Generation keys default to 24-hour expiry, with a server
maximum of seven days. Run and its monitor rotate with six hours remaining before
publishing the replacement backend; the previous key is immediately fenced. The
monitor also runs without an agent fixture. A missing operator hook cannot skip
recorded revocation and authorize DB deletion.

**Outage.** Database, WorkOS, GitHub, key or service failure prevents issuance.
No fallback reads from another checkout, release backend, exported native cache
or stale refresh seed. Requests and responses are bounded; error bodies contain
fixed codes rather than provider/database details.

## Bootstrap, operations and costs

Build with the `apps/control-plane` context and
`src/dev-connections/Dockerfile`. The launcher first runs
`node dist/dev-connections/index.js --bootstrap` with temporary administrative
and migration URLs. This health-only deployment creates dedicated database
logins and applies the broker migrations. It then replaces the full variable
collection, removes administrative/owner URLs, and starts
`node dist/dev-connections/index.js`. Runtime refuses owner URLs and checks the dedicated migration
ledger; it never migrates on ordinary boot. `/healthz` verifies schema readiness.

The configuration uses `ZEROS_DEPLOY_ENV=dev`,
`ZEROS_DEV_CONNECTIONS_ENABLED=true` and the exact Railway environment name
`zeros-dev-connections`. Required `DEV_CONNECTIONS_*` names:

- `ORIGIN`, `DATABASE_URL`, `PROVISIONER_TOKEN`; owner-only
  `MIGRATION_DATABASE_URL` for the explicit migration command.
- `ENCRYPTION_KEYS`, `FINGERPRINT_KEYS`: distinct JSON key rings shaped
  `{ "currentKeyVersion": 1, "keys": { "1": "<32-byte base64url key>" } }`.
- `WORKOS_ISSUER`, `WORKOS_JWKS_URL`, `WORKOS_AUDIENCE`,
  `WORKOS_WEB_CLIENT_ID`, `WORKOS_DESKTOP_CLIENT_ID`, `WORKOS_API_KEY`,
  `WORKOS_ORGANIZATION_ID`.
- `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

`scripts/dev-environment/hosted-connections.mjs` provides operator bootstrap via
an authenticated Railway GraphQL port and a persistent registry lease. It
ensures an environment, broker/database services, a volume, public domain,
staged configuration and source deployments idempotently. It requires a digest-pinned
PostgreSQL 18 image, mounts `/var/lib/postgresql`, and never overwrites persistent
secrets when its configuration fingerprint changes. Unknown create outcomes are
retained; ambiguous volume creation needs operator reconciliation, never blind
retry. It stages one replica and a 1 vCPU / 1 GB ceiling per service; these are
initial limits to qualify, not a measured sizing claim. Infrastructure API contract details follow Railway's
[services](https://docs.railway.com/integrations/api/manage-services) and
[volumes](https://docs.railway.com/integrations/api/manage-volumes) documentation.

Costs are one continuously available broker, one PostgreSQL service, durable
volume/backups, and small API/egress usage in addition to disposable environments.
Budget CPU/RAM, storage growth for permanent refresh tombstones, retained outbox
history, and backup retention separately. There is no fixed provider quote here;
measure the idle baseline and verify the configured caps after first deployment.

Rotate encryption by adding a new key version while keeping versions still used
by stored envelopes. New writes use the current version. Fingerprint keys remain
available for **all** recorded versions; missing or replaced keys fail closed.
Do not retire them with ordinary encryption keys. Take consistent encrypted
backups containing journals, fingerprints and revocations; keep keys separately.
**A restored backup must not serve traffic or execute renewal.** Before first
start, run the owner-only `--quarantine-restored-backup` command. Its transaction
revokes all restored generations/connections, tombstones generations, fences
pending refresh work and deletes material while preserving seed fingerprints.
Require provider reconnect and fresh generation
registration. An old snapshot cannot prove a rotating seed is unconsumed. Never
roll back the credential database as a normal deployment rollback.

## Product reference mode and cutover

The additive product migration is **0119_dev_connection_references.sql** (renumbered
from the initially reserved 0120 before any deployment). Existing version rows
default to `local`; a check requires exactly one of local envelope material or
`dev-reference`. Reference rows contain the stable WorkOS mapping and binding,
never a refresh cache. Sessions retain only encrypted, expiring original WorkOS
access bearers. System-only RLS protects references, sessions, cursors and
reference-only GitHub handoffs. No existing migration is modified.

Admission retains current actor, delegation, model, compute, quota and exact-image
checks before requesting broker access. Restore creates no image approval. The
Dev qualifier uses broker access; forced Codex renewal uses the same persistent
reservation/dispatch journal, verifies changed access and stable account identity,
and tests adoption on the exact disposable image. Only one agent per provider
has selected model consent across generations. Repeating the selection is idempotent.

The hosted monitor also discovers the fixture organization's attested Cloud
Computer images, including the active image, for the current base and Boat
account. Each image is independently qualified using the same disposable canary
and migration-owner approval path. It requires the exact image digest, source
contract and a qualification newer than machine attestation. Builders/verifiers
cannot approve their own output. One paid canary runs at a time, with the same
three-attempt and twelve-minute bounds. Failed/retiring/foreign images are
excluded; W12 activation remains a separate action after qualification succeeds.

Hosted Dev GitHub OAuth deposits the rotating pair in the broker. The desktop
receives only a WorkOS member/generation/backend-bound reference in its separate
`github-app-dev-reference-v1:` safeStorage namespace. The cloud courier sends
that reference; the backend rechecks user, app, installation/repository access
and the existing constrained managed/native write policy. Neither workers nor
renderer receive the rotating pair.

Cutover is **connect once into the broker**, after stopping every old Dev refresh
owner. With the explicit Dev flag present, legacy backend agent material cannot
be admitted or qualified, desktop GitHub refresh is frozen, and the legacy
GitHub refresh endpoint returns a reconnect error. Reconnect with fresh provider
authorization; do not copy a cache still owned by another process. Alpha/Beta/
Production and Personal/Local keep their existing paths when the flag is absent.
Seamless transfer would require a separate recoverable ownership-transfer journal.

Removal scopes are explicit:

| Operation | Effect |
| --- | --- |
| Existing organization credential Remove / Dev desktop GitHub Disconnect | Suppress this generation's local binding, retaining the shared connection; automatic restore respects removal. |
| Organization agent Disconnect | Withdraw broker consent for this WorkOS organization and clear selected local consent. |
| Agent `DELETE /v1/cloud-agent-credentials/:credentialId/dev-reference` with `{organizationId,scope}` | `local`, `organization`, or `global`; global deletes shared material and invalidates all generations. |
| GitHub `POST /v1/github/dev-reference/remove` with `{bindingId,scope}` | The same three scopes; cloud installation disconnect remains an installation-association operation. |
| Agent `POST /v1/cloud-agent-credentials/:credentialId/dev-reference/reattach` with `{organizationId}` | Explicitly reattach that still-active broker binding after local removal; requires the current member session and fresh broker metadata. |
| GitHub `POST /v1/github/dev-reference/reattach` with `{bindingId,organizationId}` | The same explicit reattach operation, returning the verified reference metadata. Automatic sign-in never clears local suppression. |

## First provisioning (operator host)

1. Prepare a **separate empty Railway project** and protected R2 registry bucket.
   Portable Dev Railway/R2 authority must not read either; a workspace-wide
   Railway token requires the broker to live in a different workspace. Record
   persistent IDs in operational protection sets. Verify a PostgreSQL 18 Alpine
   image digest; tags without `@sha256:` are rejected.
2. Create a mode-0600 JSON file outside checkouts/Files to copy, for example
   `~/.zeros-dev/connections-operator.json`. These are its required keys; angle
   brackets are placeholders, never values to deploy:

   ```json
   {
     "projectId": "<separate-project-uuid>",
     "apiToken": "<operator-Railway-authority>",
     "postgresImage": "postgres:18-alpine@sha256:<verified-64-hex-digest>",
     "registry": {
       "endpoint": "https://<Cloudflare-account-id>.r2.cloudflarestorage.com",
       "bucket": "<protected-dev-connections-registry>",
       "accessKeyId": "<operator-R2-access-key>",
       "secretAccessKey": "<operator-R2-secret>",
       "encryptionKey": "<32-random-bytes-as-64-hex-characters>"
     },
     "serviceVariables": {
       "DEV_CONNECTIONS_WORKOS_ISSUER": "https://api.workos.com/user_management/<web-client-id>",
       "DEV_CONNECTIONS_WORKOS_JWKS_URL": "https://api.workos.com/sso/jwks/<web-client-id>",
       "DEV_CONNECTIONS_WORKOS_AUDIENCE": "<same-auth-audience-as-Dev>",
       "DEV_CONNECTIONS_WORKOS_WEB_CLIENT_ID": "<web-client-id>",
       "DEV_CONNECTIONS_WORKOS_DESKTOP_CLIENT_ID": "<desktop-client-id>",
       "DEV_CONNECTIONS_WORKOS_API_KEY": "<service-only-WorkOS-key>",
       "DEV_CONNECTIONS_WORKOS_ORGANIZATION_ID": "<org-id>",
       "DEV_CONNECTIONS_GITHUB_APP_ID": "<app-id>",
       "DEV_CONNECTIONS_GITHUB_CLIENT_ID": "<same-GitHub-client-as-Dev>",
       "DEV_CONNECTIONS_GITHUB_CLIENT_SECRET": "<service-only-GitHub-secret>"
     }
   }
   ```

   Use the normal Dev WorkOS contract: distinct web/desktop `client_…` IDs,
   the same real member organization as the fixture, and the same GitHub App as
   Dev OAuth. Bootstrap generates database passwords and independent encryption,
   fingerprint and provisioner keys once, retaining them in the protected registry.
   No broker root keys/logins or provider seeds belong in the portable profile.
3. Add only this nonsecret opt-in to the hosted version-2 portable profile:

   ```json
   "connections": {
     "enabled": true,
     "cutover": "connect-once",
     "projectId": "<same-separate-project-uuid>"
   }
   ```

   Set `ZEROS_DEV_CONNECTIONS_OPERATOR_PATH` to the absolute private JSON path in
   the launcher environment. Every Archive/GC host needs that configuration too;
   it is deliberately excluded from workspace copying.
4. From the intended Mac checkout, run setup normally, then `pnpm electron:dev`.
   The `beforeDeploy` hook locks the protected registry, deploys Postgres,
   bootstraps roles/migrations, replaces bootstrap with runtime, checks exact-build
   `/healthz`, registers this generation and publishes its backend with only
   `DEV_CONNECTIONS_ORIGIN`, `AUDIENCE`, `GENERATION`, `GENERATION_CREDENTIAL`
   plus explicit enablement. The protected receipt is
   `connections/v1/<projectId>.json` in the separate registry.
5. Verify readiness reports `service=dev-connections`, `mode=runtime` and the
   captured backend digest. Inspect variable **names**, never values: runtime
   must lack `DEV_CONNECTIONS_ADMIN_DATABASE_URL` and
   `DEV_CONNECTIONS_MIGRATION_DATABASE_URL`; product must lack broker root keys.
   Confirm one broker and one Postgres service, persistent mount, one replica,
   initial 1-vCPU/1-GB ceilings and actual billed usage.
6. Sign in normally and connect GitHub/Claude/Codex/Cursor once, selecting agent
   models in organization Settings. Let the `dev:agents` monitor qualify each
   selected kind. Use `pnpm dev:agents --retry` only for a reviewed failed attempt.
   A restored connection is never proof of image qualification.
   Build a Cloud Computer image in the Dev organization screen. Wait for its
   exact-image native qualifications in `dev:agents`, then activate it and verify
   a newly created workspace uses that artifact. Base-image approval alone must
   not enable activation; the builder must not write qualification rows.
7. Start a second independently fresh Dev checkout/database and another Mac with
   normal sign-in. Verify restoration without reconnect and independent image
   qualification. Exercise concurrent Codex/GitHub renewal, tools/Git/gh, key
   rotation, broker outage, removal scopes, Archive and relaunch. Test release/
   local profiles with no flag. Retain sanitized IDs, readiness digests and
   qualification proofs, never credentials or raw provider output.
8. Run `pnpm dev:archive` for one generation. Confirm its tombstone precedes DB
   deletion and the other generation works. During an outage, compute cleanup
   continues while the DB/receipt remain. On the operator host, inspect
   `pnpm dev:gc --all --json`, then apply an exact eligible generation with
   `pnpm dev:gc --apply --owner OWNER --generation UUID`. Configure W4's scheduled
   GC host with the same private operator path. Keep the opt-in until all recorded
   revocations finish.

Unknown creates/uploads stop with durable intent. Inspect the exact receipt and
provider inventory; never delete a receipt, recreate a DB/volume, repeat a
dispatched upload or guess IDs. Source upgrades stage bootstrap/runtime again.
Completed bootstrap progress is journaled independently of Railway deployment
status. Once runtime intent for the exact source digest is recorded, retry
reconciles that runtime and its health instead of requiring the superseded
bootstrap deployment to remain active; a lost final receipt does not redeploy it.
Service-variable/key changes require explicit rotation; bootstrap cannot silently
overwrite the initial configuration fingerprint. Roll back only to code that
understands references; never reactivate former refresh owners.

For disaster recovery, stop the broker and disable ingress. Restore the encrypted
backup into a separate offline database, with roles and original key rings
restored separately. In the reviewed broker image, provide the owner URL only
to `node dist/dev-connections/index.js --quarantine-restored-backup`. Verify all
generations/connections revoked, no current material or dispatchable old attempts,
and retained fingerprints/tombstones. Remove owner authority before starting
runtime, register fresh generations, and reconnect providers. The test drill uses
a real PostgreSQL snapshot clone; qualify the actual backup transport separately.
