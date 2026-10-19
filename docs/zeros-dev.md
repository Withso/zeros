# Linux zeros-dev

The harness runs against Alpha's existing account, Computer, cloud workspace,
agent and terminal APIs. It creates no hosted development deployment. Run it
from Linux with `pnpm zeros-dev`; the direct entrypoint is
`pnpm exec tsx scripts/zeros-dev/cli.ts`. Retirement of the old hosted Dev tooling
is a separate change. `electron:local`
and `electron:alpha` retain their current launch paths.

## Alpha authentication boundary

The control plane registers `POST /auth/zeros-dev/session`, `/refresh` and
`/revoke` (all under `/auth/zeros-dev`) only when its
authoritative deployment channel is Alpha, the checked-in cloud channel policy
allows Alpha, and `ZEROS_DEV_AUTH_ENABLED=true`. Other channels return 404,
including with stale settings and during database maintenance. VM engines do
not consult this policy. Ordinary Local and organization-local authentication
is unchanged.

The operator pins `ZEROS_DEV_AUTH_SUBJECT`, `ZEROS_DEV_AUTH_ACCOUNT_ID`,
`ZEROS_DEV_AUTH_EMAIL` and `ZEROS_DEV_AUTH_ORGANIZATION_ID` in the Alpha CP.
The account and verified WorkOS identity must already exist, have no staff
role, and belong to the active nonpersonal test organization. The route never
creates accounts, roles, memberships, credentials or entitlements. Login requests
contain only a password, a UUID request ID, and Linux device intent. WorkOS uses
the configured confidential `AUTH_WEB_CLIENT_ID`, with its secret kept on the
control plane. The public desktop client cannot issue this password grant.
The signed token and recorded session keep their real `web` client kind; the
ordinary bearer contract already accepts that client on the device, GitHub,
Computer and runtime routes. Desktop PKCE, refresh and revoke checks remain
unchanged. MFA, SSO-only, verification and authentication-policy challenges
cannot be continued or bypassed here.

Login and revoke requests have a 4 KiB limit; refresh allows 70 KiB for a
refresh token of at most 64 KiB. All have a five-second response deadline. WorkOS bodies
are bounded at 128 KiB. The endpoint allows five attempts per source and twenty
globally per minute, with a process backstop and serialized database budgets.
Railway's trusted edge supplies `X-Real-IP`; other forwarded headers cannot
select a bucket. Missing or invalid peers share one bucket. Keep the API behind
that edge: the header alone is not peer authentication. The global cap also
applies when multiple edges or API replicas are involved.

Refresh and logout require a signed token for the pinned web account and the
exact session's committed zeros-dev issuance audit. An ordinary web session,
including another session for the same test user, cannot use these routes.
Only lifecycle proof may be expired: signature, issuer, audience, required
claims and `nbf` still validate, and expired tokens remain invalid on product
APIs. Refresh also requires the WorkOS refresh token and must return the same
SID; its audit commits before the rotated token is returned. An unknown or
withheld refresh retires the known session through the tombstone/outbox path.
Logout retires that one session; it has no global-signout option. Neither route
accepts a caller-selected subject, client, organization or session ID.

The attempt audit commits before the grant request; the exact session and its
success audit commit before tokens are returned. Reusing a recorded request ID
is refused even after the rate window. Failures emit fixed denial codes and
closed audit outcomes, never WorkOS diagnostics, passwords or token values.

If admission expires after WorkOS answers, a separate two-second, size-bounded
read extracts the returned session ID **only for cleanup**. It does not extend
the login deadline or authorize from unverified claims. Every recovered issued
SID goes to the local revoked-session tombstone and existing WorkOS revocation
outbox, and to immediate provider revocation. Cleanup is `retired` only when
both writes confirm; otherwise it is `pending`. Audit failures always withhold
the session. The existing outbox retries when the local transaction succeeded.

A disconnected, truncated, malformed or aborted provider response may contain
no recoverable SID. That outcome is `unknown_issuance`, not confirmed revocation.
The password grant is not replayed automatically. Operators must inspect the
dedicated test account's WorkOS session activity and retire unknown sessions
through the normal account session controls. The harness cannot promise
revocation when neither the provider response nor a local record identifies
the session. Database/provider unavailability can also delay revocation; no
unreturned grant becomes a successful login because cleanup failed.

## Credential storage

Owner-prepared fixture identifiers and Alpha/test secrets live only in the
canonical repository `.env.agent`, mode 0600. A linked checkout resolves the
Git common directory and ignores a copied worktree file. Passwords, tokens and
device private keys are never command-line arguments. The checked-in example
contains empty placeholders. `pnpm agent:check` redacts both stored envelopes
and decoded private key material.

The harness opens credentials and Git metadata once with `O_NOFOLLOW`, then
validates ownership, type, link count, size and mode on that descriptor before
reading it. A private lock serializes refresh rotation across checkouts; it
is never stolen by elapsed time. Atomic replacement uses a temporary 0600
sibling solely for the write/fsync/rename and retains no backup or second
session store. If a killed process leaves a lock, confirm there is no live
holder before manually removing that lock. A failed protected read releases
only the lock inode acquired by that operation.
Prompt and script inputs exclude the canonical credential path, including
parent-directory aliases, independently of the credential inode so an atomic
refresh cannot make credentials admissible as input.

Live qualification requires the owner-prepared fixed account/password, test
organization with entitlement and quota, authorized test repository and GitHub
App installation, and supported agent connections. Synthetic and loopback tests
do not prove those fixtures or a live WorkOS password-grant configuration.

## Commands and fixture preparation

Use `pnpm zeros-dev --help` for the complete command
surface. Commands have one live target: `https://api-alpha.zeros.build`.
There is no channel, origin, SQL, provider sandbox ID or credential argument.
The CLI never loads credentials from ambient environment variables. Set the
owner-prepared subject, account UUID, verified email, org UUID and password in
`.env.agent` first. `login`, `whoami`, `org ensure`, `health` (an alias for
`health cp`) and `github connect` work before repository pins exist.
`pnpm agent:check` reports a valid identity awaiting GitHub as a warning, without
logging in, refreshing or enrolling a device. Repository, Computer, workspace
and receipt-scoped health commands still require the complete fixture.

Run `github connect --repository OWNER/NAME --repository-id NUMERIC_ID` with the
owner-approved private fixture repository. These arguments are nonsecret
selection metadata; no installation UUID or credential is accepted on argv.
The command prints a `zeros.dev-github-authorization/v1` record containing only
the validated GitHub authorization URL, followed by closed completion metadata.
Send that URL to the owner while the command remains running. The owner signs
into their own GitHub account and authorizes the Alpha GitHub App. On the
**GitHub connected** page, they can close the tab without selecting **Open
Zeros**. They never sign into the fixture account or enter its password.

The CLI reuses the desktop OAuth client and polls the normal owner-bound
handoff every 25 seconds, allowing the 90-second completion grace after the
ten-minute authorization window. It then uses the fixture session's normal
catalog, source and connect routes. It requires one active organization
installation, a complete catalog, and the exact private repository name and
numeric ID. The **Zeros installation UUID** comes from that member's catalog
and must agree with the source and connect responses; a GitHub provider
installation number or another member's row is never substituted.

After rechecking the account, it atomically pins `ZEROS_DEV_REPOSITORY`,
`ZEROS_DEV_REPOSITORY_ID` and `ZEROS_DEV_GITHUB_INSTALLATION_ID` under the same
canonical lock used for token rotation. Matching pins may be confirmed again;
conflicting pins or an account/session change fail closed. The nonce and GitHub
tokens stay in process memory and are not written to `.env.agent`, receipts or
logs. If approval expires or the process exits before confirmation, rerun the
command to start another normal handoff; it cannot resume an abandoned nonce.

The normal product fixture needs the GitHub App installed and selected for the
repository before connect. It also needs one Computer draft repository matching that exact fixture, an
approved recipe, entitlement/quota and the chosen agent's supported account
connection. `org ensure` confirms membership. `repo ensure` checks the repository
grant from the **ready active Computer**, so it runs after the first successful
build. Neither command creates an org, changes membership/funding, installs a
GitHub App or writes a recipe. `computer build` builds the existing approved
draft using its normal CAS revision and operation ID. A missing draft fails
explicitly; repository pins alone do not approve a Computer configuration.

Before reporting success, `computer build --wait` reads the saved build's runtime
and base through its normal authorized product route and compares them with the
builder's current qualified selection. Success includes `runtimePin: "confirmed"`.
Use `--expect-runtime r1-<sha256>` to require a particular corrected runtime too.
A missing, unqualified or different tuple returns `runtime_pin_unconfirmed`;
another build ID or version returns `identity_changed`. This proof uses one
read-only database snapshot and takes no admission locks. It is an observation,
not a lease: subsequent publication or revocation can change selection. Old
build pins are never rewritten; deliberately build again if the selection moved.
The new route must be deployed before using this check. No database credential
is needed for it, and ordinary strict build-summary responses keep their shape.

For first setup, the fixture member opens the test organization's Settings →
Cloud Computer, selects only the fixture repository under **Repositories**, and
clicks **Save draft**. Use the approved install script (empty for a dependency-free
fixture) and leave **Environment** empty. Saving establishes fresh GitHub source
authorization for that exact repository; the proof created by `github connect`
expires after two minutes, while the connection itself persists. Then run the
commands below. A successful build activates automatically. The harness accepts
GitHub name casing differences in returned Computer/workspace rows, while still
requiring the exact repository ID, installation UUID, owner and workspace scope.

```sh
pnpm exec tsx scripts/zeros-dev/cli.ts login
pnpm exec tsx scripts/zeros-dev/cli.ts github connect --repository OWNER/NAME --repository-id NUMERIC_ID
pnpm exec tsx scripts/zeros-dev/cli.ts org ensure
# Save the approved Computer draft through the product once, as described above.
pnpm exec tsx scripts/zeros-dev/cli.ts computer build --wait
pnpm exec tsx scripts/zeros-dev/cli.ts repo ensure
pnpm exec tsx scripts/zeros-dev/cli.ts workspace create --wait
```

Creation and build output includes a run UUID. Pass that same UUID as `--run`
to `computer status|logs`, `workspace status|resume|stop|delete`, `agent send`,
`chat tail`, `terminal run` and health selectors. A new workspace command can
reuse a Computer run; the active successful build is still revalidated. Saved
create bodies and idempotency keys are replayed byte-for-byte after an unknown
response. Do not manufacture a new run to retry an unknown allocation.

`agent send --run <run-uuid> --agent claude|codex|cursor --model <model>
--prompt-file <file> --wait` creates a saved conversation and waits for its
native terminal event or durable command receipt. The printed prompt UUID is
accepted by `--prompt` for exact resubmission/reconciliation and by
`chat tail --run <run-uuid> --prompt <prompt-uuid>` for its latest 100 persisted
messages. Prompt text is at most 64 KiB and is never saved in evidence or run
receipts. A retry must retain the same agent, model and text digest. Permission
and question requests end CLI observation explicitly; the harness never
approves them. Use the desktop to resolve the control, then reconcile the same
prompt UUID. Closing CLI observation does not assert the underlying turn stopped.
To continue a settled conversation, pass `--continue <previous-prompt-uuid>`
with a new prompt UUID. Only that run's settled conversation, same agent and
same model can be selected; a foreign conversation cannot be attached by ID.

`terminal run --run <run-uuid> --script <file>` creates an ephemeral PTY through
the normal bridge, runs a script of at most 2 KiB, waits up to 60 seconds for
the real exit and closes that PTY. Output is bounded at 64 KiB and display at
16 KiB. An optional `--command <uuid>` binds a script attempt. A PTY has no
durable command receipt: interrupted/unknown scripts are never automatically
executed again. A second attempt requires a deliberate new command UUID.

Prompt and script inputs must be regular files owned by the invoking user,
without additional hard links or group/world write permission. The opened
descriptor supplies the bytes and metadata; aliases, credentials and files
replaced during the read are refused.

Lifecycle waits are bounded at three minutes, Computer builds at fifteen,
agent observation at five, and an invocation at thirty. A workspace wait uses
the existing status request with `setupProgress=true&setupEvidence=true`; default desktop reads
keep their response shape. Deadline/failure evidence names `workspace_create_wait`,
`workspace_resume_wait`, `workspace_stop_wait` or `workspace_delete_wait` and, when
available, the last observed current-generation setup attempt, claim count,
state and closed error code. Optional setup evidence retains the exact run/fence,
runtime ID, at most five claim clocks, engine creation/registration times and
closed reuse/readiness reasons in the signed receipt before fixture deletion.
Long histories retain the first failure and mark truncation. Nested attester
spans overlap setup spans; never add durations across their independent clocks.
Unknown codes become `unknown`; raw logs and provider fields are refused. An older
CP supplies ordinary progress; stale or malformed evidence is dropped independently.
The product's longer retry loop does not extend this wait,
and no new diagnostic request runs after its deadline. Standalone workspace
commands retain their run for iteration. `scenario run smoke --agent <agent>
--model <model>` creates a throwaway, verifies the repo through a terminal,
waits for an agent response, stops/resumes, repeats, then stops and deletes.
The resumed phase verifies its own small repository marker and continues the
same recorded conversation through the new admission.
`--build-computer` explicitly builds the configured draft first. The scenario
always attempts its recorded workspace's cleanup, including after
SIGINT or a work deadline, with a separate thirty-second cleanup budget.
Cleanup that remains pending makes the scenario fail; its receipt is retained.
If work and cleanup both fail, the result retains the first work failure and
setup observation while a separate cleanup event records the cleanup failure.

## Identity, evidence and cleanup

Run records are owned mode-0600 files under the canonical repository's private
`.context/zeros-dev/`, signed using the registered device key. They contain
operation IDs, exact resource bindings, payload hashes, source metadata and
closed results, not credentials or prompt/script content. Signatures detect
receipt corruption; product authorization remains mandatory. Writes preserve
the owned lock inode and refuse a changed saved receipt. Never copy only the
receipt to a different account/device to recover it.

Each run lock records its owner's PID, Linux boot ID, PID namespace and process
start identity before a command begins. On Linux, the next invocation can
recover a killed owner's lock only when that same host/namespace proves the
process is gone or its PID has been reused. A live owner or reclaimer stays
busy, regardless of age. Recovery retains the signed receipt and operation
keys; retry with the same run UUID. Different or unverifiable host identities,
non-Linux hosts, and old empty locks (including an interruption before owner
publication) require manual confirmation of the absent holder. No age-based
lock removal is allowed. This recovery applies only to run locks; the separate
canonical credential-file lock retains its existing manual recovery procedure.

`cleanup --run <run-uuid>` and `cleanup --all` preview the signed local allowlist;
`--apply` invokes ordinary product deletion. The current name must still match
the signed `zd-` name, in addition to the exact org, creator, workspace,
repository, generation and account binding; a name alone never authorizes cleanup.
If an accepted wake or stop remains unconfirmed but the workspace is now
`stopped`, `ready`, `busy` or `failed`, apply first saves that closed observed
outcome in the signed receipt. It does not claim the original intent succeeded.
Deletion then proceeds with its own saved key, reused after a lost response.
If setup is still transient, cleanup returns `cleanup_pending` immediately;
rerun the same command after the product reaches a settled state. Planning
neither changes the receipt's lifecycle history nor issues a deletion.
An unknown create response must first be reconciled with `workspace create
--run <same-uuid>`. A deleted row or HTTP 404 alone is not completion: cleanup
requires the provider-deleted observation and a complete pending-deletion view
with no remaining binding for that workspace. No direct Boat delete fallback,
foreign workspace scan or prefix-based cleanup exists. Durable test org/repo
and Computer fixtures are excluded.

### Compute retirement while storage is pending

Hourly and Gate 0 runs explicitly use a separate cleanup outcome,
`compute_retired_storage_pending`. Their authenticated product read is
`POST /v1/organizations/:org/cloud-workspaces/:workspace/deletion-retirement`,
with only the recorded generation and original accepted delete key. The
control plane must confirm the exact owner, creator, creation time, name,
workspace, delete intent and every persisted generation; admission, access
and compute settlement must be fenced. Fresh authenticated provider receipts
must prove sandbox absence and storage-only retention. The read never changes
lifecycle, provider deletion, capacity accounting or record-purge gates.

The signed run retains that complete observation and keeps
`deletionConfirmed=false`. Each `storage_pending` event and the public v2
artifact's `cleanup` summary retain the pending count, generations, reserved
storage and original deletion time. This is compute retirement, not physical
erasure or measured disk usage. Ordinary CLI cleanup still waits for physical
deletion. A positive physical completion receipt can retire carried work after
content purge; a missing row or 404 cannot.

Actions also emits one `Zeros dev cleanup backlog` warning from the final signed
summary whenever storage remains pending, including on a green run. It reports
the last confirmed counts, reserved storage, oldest delete, unconfirmed workspace
count and admission limits. Product failures keep their original result; the
warning does not turn unknown compute into an admissible backlog.

Before allocation, the runner rereads every carried retirement and compares it
with the complete organization workspace and pending-deletion inventories. It
does this again after Computer preparation. Proof must remain within 60 seconds
of observation through the inventory reads. A deleting inventory row can retain
its old CPU/memory allocation; only the fresh retirement response proves zero
compute, while inventory must still match every generation and its disk
reservation. Live, foreign, failed, unknown, renamed, changed-generation,
truncated or unaccounted work blocks allocation. The fixture's normal product
entitlement, funding and provider-capacity checks still apply.

Admission reserves one new slot within a maximum of eight pending workspaces
and `8 × 70,225 MiB` of reserved storage. Original accepted deletion age is
bounded at eight hours, allowing the provider's six-hour upload fence plus two
hours of reconciliation. New observations or provider estimates never reset
that clock. `cleanup_backlog_exceeded` blocks another allocation; old debt is
never evicted to make room. The signed artifact carries at most nine run
records, including a failed current attempt, within its existing 1 MiB bound.
Boat's [14-day stopped-disk retention](https://docs.boat.dev/snapshots) does not
extend this eight-hour limit or prove a requested deletion completed. Automatic
snapshots are included in Boat's pricing; the reserved MiB limit still bounds
cleanup debt and unavailable capacity, rather than estimating a storage bill.
Readers retain v1's physical-deletion success rule; new writers emit
`zeros.dev-hourly/v2` so the two outcomes cannot be confused.

### Handing released local evidence to Actions

Actions never discovers local runs by name. Once the investigator releases
the evidence and normal product deletion has been accepted, the owner can
export up to four explicit local run UUIDs using the **same fixture and
enrolled device key** used by Actions:

```sh
pnpm exec tsx scripts/zeros-dev/cli.ts cleanup handoff --runs <uuid>,<uuid> --output /absolute/private/fixture-cleanup.b64
gh secret set ZEROS_DEV_CLEANUP_HANDOFF_B64 --repo Withso/zeros < /absolute/private/fixture-cleanup.b64
```

The export authenticates the original local receipts and performs only the
retirement reads above. It writes one exclusive mode-0600 file in an owned
directory and prints only its digest and count. The signed manifest contains
exact cleanup bindings and original receipt digests, with no password, device
private key, provider credential, transcript or prompt. Do not hand off an
active or evidence-held run. Missing retirement proof refuses the export.

The optional Actions secret is a cleanup-only handoff, separate from the
fixture secret. Imports cannot build, allocate, wake, stop, issue agent grants,
connect a runtime, clean local credentials or supply a successful hourly
result. Actions refreshes proof before admitting another workspace. It carries
the consumed manifest digest and run UUIDs even after physical deletion, so an
unchanged secret cannot resurrect work. A different manifest or a collision
with existing intent is refused. Export the intended bootstrap set together;
the owner may remove the secret after its consumption is checkpointed.
Use a secret even though the projection contains no provider credentials:
Actions prints step environment values before the process can add masks.
For an existing variable, upload the same verified private file as the secret,
then remove the variable; never regenerate a consumed manifest. GitHub secrets
cannot be read back: compare the locally verified digest with the consumed
handoff digest in the device-signed Actions receipt. Do not print the base64
value or put it in an argument. A module startup failure precedes masking and
may leave no receipt; retain that first failure and require explicit reviewed
recovery instead of silently skipping its predecessor.
The local and Actions invocations still share fixture funding, Computer state
and provider capacity, so keep live fixture work serialized by the operator.

### Recovering a failed Actions DELETE

A failed DELETE cannot be repaired by retrying a different key inside the
canary or marking the old lifecycle intent successful. The operator first
reviews an exact stopped-only product deletion plan and issues its approved
request through `cloud-workspace-deletion:manage`. Retain that approval UUID
and reuse the same `operator-delete:<approval>:<workspace>` key after a lost
response. If the request was accepted before the CP successor-linkage fix was
deployed, replay that same approved request against fixed CP to reconcile its
linkage. Request acceptance, a stopped workspace, a 404 or provider absence
alone is insufficient to restart Actions.

Once the exact successor has positive product retirement proof, use the
existing fixture account and enrolled device to export one cleanup-only append:

```sh
pnpm exec tsx scripts/zeros-dev/cli.ts cleanup recovery \
  --artifact /absolute/private/failed-receipt.json --run <failed-run-uuid> \
  --workflow-run <original-workflow-id> --workflow-attempt <original-attempt> \
  --expect-source <original-source-sha> --approval <approved-operator-uuid> \
  --output /absolute/private/fixture-recovery.b64
gh secret set ZEROS_DEV_CLEANUP_HANDOFF_B64 --repo Withso/zeros < /absolute/private/fixture-recovery.b64
```

The input must be the original device-signed failed Actions artifact, mode
0600, with the selected primary run's unresolved DELETE. The command verifies
its exact workflow execution, fixture/device/repository, workspace/generation
and fresh successor retirement. It neither enrolls a device nor edits local
run receipts or issues a lifecycle request. Its exclusive mode-0600 output is
the separately signed `zeros.dev-cleanup-recovery/v1` envelope. Success prints
only `state: "ready"`, its SHA256 and `runCount: 1`; raw base64 and credential
material are never printed. Normal fixture authentication and refresh still
apply to the retirement read.

The append binds the original artifact bytes and run digest, failed DELETE
key, exact source execution and approved operator key. It contains custody,
not a cached retirement observation. It also binds the already-consumed local
handoff, so replacing the secret does not lose those earlier cleanup receipts.
The first Actions import requires that exact restored source artifact. Missing
or changed source bytes refuse before login. Actions checkpoints the append
before product work, then reads fresh retirement for the approved key during
`prior_cleanup` and again during complete fixture inventory/capacity checks.
It never falls back to issuing DELETE. Build, wake, stop, runtime connection,
agent grants and native tasks remain forbidden for a recovered run.

The old failed lifecycle intent and original failure evidence remain intact.
Storage-only retirement still means `deletionConfirmed=false`; physical purge
and every provider, generation, funding and backlog fence remain in force.
The signed Actions artifact carries the optional `cleanupRecovery` reference,
including after physical completion, so the unchanged secret cannot resurrect
the workspace. One chain consumes one exact recovery envelope; substitution
or a second recovery is refused. Preserve the original failed artifact and
soak window; recovery does not turn either into a pass. An interruption before
the append checkpoint remains closed and requires operator reconciliation.
Update collectors to this receipt reader before emitting recovery-bearing
artifacts; older signed receipts keep their original serialized interpretation.

Output is JSONL. `zeros.dev-evidence/v1` contains closed phases, outcomes,
durations and error codes. `zeros.dev-context/v1` distinguishes the local source
revision/dirty state from the deployed Alpha source. Explicit chat/terminal/
Computer-log display uses `zeros.dev-content/v1`, redacts configured secrets,
URLs, token shapes and terminal controls, and is separate from evidence.
Provider error bodies/stacks and arbitrary extra diagnostic fields are never
emitted. Keep interactive live artifacts private and outside committed source.
Connection failures add a closed `runtime` observation to evidence, the command
result and the signed hourly receipt. It names the failing phase (workspace
read, identity, admission, handshake or workspace list), the failure class and
the HTTP status when available. For example, an admission HTTP 500 reports
`{phase:"admission",class:"admission_unavailable",status:500}`. Unknown causes
stay `unknown`; this does not attribute a server error to a provider or the VM.
The first observation survives cleanup/logout failure. The shared desktop
access client retries only HTTP 503 with the exact
`cloud_runtime_temporarily_unavailable` code, `provider_endpoint` phase,
`retryable:true` and an integer `Retry-After` of 1–300 seconds. It makes at most
three requests with fresh device proofs, inside the original 15-second admission
deadline and caller budget. A delay that cannot fit ends the attempt; it is
never clamped or used to extend the deadline. Session, runtime and Stop fences
remain in force. Unknown faults, `service_busy`, auth/integrity refusals and
unconfirmed cleanup are terminal for this policy.

`runtime_admission` pending events retain the first typed failure and every
executed retry, with a separate `retryCount`. `sequence` distinguishes admission
calls within one connection, including refreshes. The successful connection
event or failed result retains the first admission observation too. A recovered
connection can pass while its first failure and retry costs stay visible in
the signed receipt. Connection timings include proofs, waits and all retries;
the CLI adds no second retry loop. Native aborts at the HTTP boundary report
`deadline`, retaining the last
validated setup attempt and claim count during workspace waits.
Use the updated CLI for subsequent receipt reads: older strict CLI versions
cannot interpret the new wait phases or setup/runtime/admission observations. Existing receipts
without those optional observations remain readable.

## Read-only diagnostics and qualification

- `health cp` reads the fixed public Alpha release identity, including its
  closed 503 readiness result. `--expect-source <sha>` refuses a different
  deployed commit. Testing an older deployed Alpha does not test an unmerged
  checkout.
- `health vm --run <uuid>` reads the normal CP workspace/provider observation;
  it reports its availability, not a new native probe or proof of freshness.
  It does not request admission or wake the VM. Agent/PTY commands acquire
  admission only when the product reports `ready` or `busy`.
- `health db --run <uuid>` uses only the separately provisioned
  `ZEROS_DEV_ALPHA_READONLY_DATABASE_URL`. Provision it for the Alpha database;
  never reuse CP/migration/admin credentials. It requires a verified TLS
  PlanetScale PostgreSQL connection, rejects effective write/owner/admin/
  bypass-RLS authority, uses a read-only transaction, short query deadlines and
  the fixed actor/org/workspace/generation/repository scope. There is no
  `app.system` or role switch. RLS-hidden or unavailable rows are
  **unconfirmed**, not evidence of absence. Generation and active engine
  runtime IDs are separate; `--expect-runtime <r1-sha256>` asserts the active
  engine pin, not an admission lease UUID or current publication default.
- `health cp-logs --run <uuid>` uses the existing Alpha Railway project token,
  confirms the token's Alpha environment, singleton service, exact Alpha API
  domain and deployment binding, then selects at most 100 log rows from that
  workspace's last fifteen minutes. Only severity counts leave the boundary;
  no log message, variable query, deployment mutation or broad account scan is
  exposed. An empty sample is not proof that the backend had no activity.

The Linux runtime reuses desktop device enrollment/signing, admission brokerage,
direct/relay choice, handshake/reconnect/boot fencing, native command receipts,
event replay and PTY framing. Renderer/native defaults stay in `ws-client.ts`;
the injected core does not read a desktop channel in a VM. Local Personal and
organization-local workspaces retain their existing offline/native behavior.
Changing the configured account/org/device retires CLI authority; no source
credential or infrastructure token is injected into a VM or template.

The required live qualification is a normal owner-prepared WorkOS password
grant, each selected agent's completed prompt, terminal exit, stop/resume with
state intact, and verified product deletion. If WorkOS cannot issue the pinned
web bearer contract, stop qualification; there is no alternative issuer, MFA/SSO
bypass or role seed. Every recoverable received grant stays under cleanup until
canonical persistence succeeds, including envelope, identity, verification and
save failures. Cleanup attempts the fixture's current-session revocation; an attempt
does not confirm provider retirement. A malformed response with no recoverable
grant reports `auth_unknown_issuance`. If a save confirmation fails, the harness
clears only that same session through its owned file lock when its inode checks
still permit it. A storage or revocation outage requires the same operator
session inspection and recovery described above. Enrollment after persistence
is a recoverable device step, without another password grant. Beta/Production,
macOS engine smoke and live provider success cannot be inferred from Linux
fixtures.

Rollback disables `ZEROS_DEV_AUTH_ENABLED` on Alpha and revokes the dedicated
test sessions/devices through existing account APIs; retain audit/history and
cleanup receipts. The old hosted Dev implementation and its billable resources
remain intact until its inventory is complete and exact cleanup is approved.

## Hourly E2E in Actions

`zeros-dev-e2e.yml` runs on main, hourly at minute 23 or by dispatch, with one
serialized Alpha fixture. Its explicit profiles have separate coverage and
deadlines; the dispatch default is `infrastructure`. It uses the normal product
API and the desktop's RuntimeClient. Local Personal, organization-local and
Beta/Production paths are not selected.

The owner prepares the fixture through the ordinary setup above, then stores
`ZEROS_DEV_FIXTURE_B64` as an Actions secret. It is base64-encoded JSON with
exactly these canonical keys: `ZEROS_DEV_PASSWORD`, `ZEROS_DEV_WORKOS_SUBJECT`,
`ZEROS_DEV_ACCOUNT_ID`, `ZEROS_DEV_EMAIL`, `ZEROS_DEV_ORGANIZATION_ID`,
`ZEROS_DEV_REPOSITORY`, `ZEROS_DEV_REPOSITORY_ID`,
`ZEROS_DEV_GITHUB_INSTALLATION_ID`, and `ZEROS_DEV_DEVICE_PRIVATE_KEY_B64`.
Use the already-enrolled device for this fixture; keep its key stable across
hourly receipts. Transfer the envelope through the approved secret-store path,
without printing it or placing it in arguments, source or artifacts. Access and
refresh tokens and infrastructure credentials are excluded. Each ephemeral
runner creates its own canonical mode-0600 `.env.agent` and retires its session.

This repository's Actions logs and hourly receipt artifacts are public.
Initialization registers stdout-only `::add-mask::` commands for the decoded
fixture values, device private-key envelope and fields, and native auth tokens
before validating or writing the fixture. Both raw and JSON-escaped values are
masked. Mask commands never enter the evidence writer or signed receipt.

The owner chose infrastructure automation plus a separate owner §7 agent/UI
test. This workflow receives **no `AGENT_RUNTIME_*` credentials** and never asks
for new API keys. Full `hourly` and `gate0` agent installation currently refuses
with `release_checks_unavailable`; do not enable hourly until the separately
reviewed v4 release-check runner supplies real agent coverage. Its future
authority comes from existing Settings **Use for release checks** consent in
the designated owner's organization, without copying credentials or lending
owner authority to the fixture. Current runtime qualification is credential-free
compatibility smoke, not model-turn evidence. Exact older signed credential
debt remains cleanable without new material; foreign selections stay untouched.

Before enabling `ZEROS_DEV_E2E_ENABLED=true`, configure the required status and
owner-reviewed repair procedure in [CI](ci.md#hourly-zeros-dev-merge-requirement).
The first actual successful main lifecycle activates the gate automatically;
a skipped job cannot activate it. The fixture needs a ready active Computer
and its approved draft. The canary reads that build's persisted pin and the
builder's newest qualified runtime/base in the `computer_selection` phase.
If the tuple moved, `computer_build` makes at most one normal, idempotent build
from that draft and proves the resulting pin against the captured tuple. An
unchanged tuple needs no build. It never rewrites a saved pin or builds onto
an unqualified publication.

`runtime_selection_unavailable` means no qualified selection was available;
`runtime_selection_changed` means the captured selection moved or its base
changed during this run. These are closed prerequisite/race outcomes, separate
from lifecycle failures; neither can produce a green receipt. A newer publication
still qualifying does not displace an older qualified selection. The canary
checks the exact active build and tuple again before allocation and after the
lifecycle, and never loops on rebuilds. A build timeout retains the signed build
intent for normal product status/reconciliation; it does not assert cancellation.

Each run restores its exact signed predecessor artifact before doing work.
Skipped attempts can be crossed only when job metadata proves the product step
never ran. An old rerun is refused if a newer run may have touched the fixture.
Missing, expired, foreign or corrupt executed-run artifacts stop allocation.
The runner first cleans its signed leftovers through product deletion. A failed
wake that settled as stopped is recorded and deleted. Exact compute-retired,
storage-pending predecessors follow the bounded contract above; transient
setup or missing retirement proof reports `prior_cleanup`/`cleanup_pending`,
and no new workspace is allocated. Unknown creates/publications stay unknown;
there is no prefix scan or direct provider fallback. Do not delete artifacts
or change the fixture device to bypass this check. The owner must reconcile the
exact recorded operation through the normal product path when automatic
recovery cannot prove its outcome.

The startup repair includes one explicit owner-reviewed prestart incident in
`scripts/zeros-dev/prestart-recovery.mjs`. Its immutable source failed module
transformation before the entrypoint could initialize a product client. The
planner may cross **only that run, attempt, source and job**, after GitHub reports
the exact failed execution/upload steps and no matching artifact. It carries
`prestartRecovery` into the signed receipt and successor chain. Any mismatch or
other missing receipt still blocks. This record grants neither cleanup authority
nor a pass, and the original failed run stays red. Review this record with the
owner's startup-fix merge; there is no reset variable, generic error-text bypass,
deleted history or fabricated old receipt.

The fixture device that signed run 11's receipt was lost with its host. On
2026-10-16 the owner approved a password reset, a new device enrollment and one
reviewed chain restart, pinned in `scripts/zeros-dev/chain-restart.mjs`. When
the first receipt-bearing predecessor is **exactly** that run, attempt, source,
artifact ID and digest, the planner returns a bootstrap plan carrying
`chainRestart` instead of `previous`. Any other run that shares one of those
identifiers fails closed with `chain_restart_mismatch`. The workflow still
restores the retired receipt, and the runner checks its pinned `receipt.json`
SHA-256 without importing or authenticating it. A credential that still uses
the retired device ID is refused with `chain_restart_device_retired` before any
checkpoint. The first new-chain receipt signs the record. Later runs chain to
that receipt normally and never apply the restart again. Its carried workspaces
are dropped from the chain but not from the product account: `prior_cleanup`
keeps reporting `cleanup_pending` until the owner deletes every old fixture
workspace through the product. Before the first restart run, replace the
fixture secret with the new device and delete any cleanup handoff signed by the
retired device. A run refused before its first checkpoint uploads no receipt,
and the planner cannot cross that run.

The planner reads one page of the newest 100 runs of this workflow on main and
refuses with `artifact_invalid` when its walk leaves that page. The restart
therefore applies only while run 11 stays within those 100 runs. Dispatch the
first restart run promptly after the merge and the secret replacement. If it
must wait, disable the workflow so skipped scheduled runs stop accumulating,
and re-enable it just before dispatching.

Never rerun run 38737559526 or any run created before this change merged. A
rerun executes its original commit, whose planner chains to run 11. With the
new device, that run fails authentication before its first checkpoint and
leaves a failure the planner cannot cross. Keep `ZEROS_DEV_E2E_ENABLED`,
`ZEROS_DEV_INFRASTRUCTURE_ENABLED` and `ZEROS_DEV_GATE0_ENABLED` unset or false
until the change is on main and the fixture secret holds the new device. Use
the `infrastructure` profile for the first restart run, because its budget
tolerates setup time.

Before the first restart run, confirm through the product that every workspace
listed in run 11's receipt is deleted and that no `zd-` cloud agent credential
remains. The restart drops the carried runs whose cleanup would otherwise have
deleted and revoked them.

Soak reports trust one device public key. A soak window that spans the restart
reports its pre-restart attempts as incomplete.

`chainRestart` appears only in the first new-chain receipt. The old chain's
`prestartRecovery`, `handoff` and `cleanupRecovery` records are not carried.
This is safe because the planner never walks past the first receipt it finds.

After that, the scenario creates one `zd-` workspace, proves its Git checkout
and writes a harmless marker, sends one minimal prompt to each agent, then
stops and resumes. It checks the marker and hashes of the three durable chat
histories after reconnecting. It sends no second prompt on an uncertain turn.
Computer preparation, including its optional build, is capped at 300 seconds.
The lifecycle then gets up to 350 seconds, individual prompts up to 60 seconds.
A separate 140-second cleanup reserve protects credential revocation from a
work timeout, SIGINT or SIGTERM. All phases share an 850-second overall budget
that starts before dependency installation; the Actions job allows 15 minutes
for that budget, logout and receipt upload. Setup overhead reduces the remaining
overall allowance and cannot extend a phase.
Cleanup passes only with physical deletion or the authenticated compute-retired,
storage-pending outcome above. Unconfirmed cleanup or any failed stage keeps
the run red; retained storage remains visible after a successful lifecycle.

The signed `zeros-dev-receipt-<workflow-run-id>-<attempt>` artifact contains
closed phases, timings, setup attempt/claim/error observations and exact cleanup
intents. Every saved intent is checkpointed before its product mutation with
atomic replacement, so interruption leaves the last valid signed record.
Only `receipt.json` is uploaded, with 90-day retention. Agent output, prompts,
terminal output, tokens and credential values are excluded. The first failure
survives later disconnect or cleanup failures, which have separate events.
UTC `activeWindows` and monotonic durations cover completed, verified connected
work only; they are not a measurement of total VM billable time.

Agents can dispatch and inspect the canary with the normal release automation
identity; neither operation needs provider keys in the checkout:

```sh
pnpm agent:gh workflow run zeros-dev-e2e.yml --ref main -f profile=hourly
pnpm agent:gh run list --workflow zeros-dev-e2e.yml --branch main --limit 5
pnpm agent:gh run view <workflow-run-id> --json status,conclusion,jobs,url
pnpm agent:gh run download <workflow-run-id> --name zeros-dev-receipt-<workflow-run-id>-<attempt> --dir <private-scratch>
```

Downloaded hourly receipts contain the public metadata listed above, including
resource IDs and idempotency keys. Disabling the schedule after activation does
not reset the gate: skipped or stale completed runs remain a refusal for cloud
changes. A newer run in progress leaves the latest completed result in force,
including its two-hour freshness limit.
To roll back enforcement, the owner removes the required status and reverts its
CI/wrapper gate, then disables the canary. Preserve signed cleanup receipts and
complete product cleanup before rotating the fixture device or retiring its
dedicated credentials. No successful live run or 24-hour soak is implied by
the synthetic workflow tests.

## Infrastructure rehearsal and soak in Actions

Owner option B separates infrastructure measurement from the owner's real
agent/UI §7 test. Enable `ZEROS_DEV_GATE0_ENABLED=true` and dispatch:

```sh
pnpm agent:gh workflow run zeros-dev-e2e.yml --ref main -f profile=infrastructure
```

First migrate `ZEROS_DEV_CLEANUP_HANDOFF_B64` from a variable to an Actions
**secret**, following the cleanup handoff instructions above. Reuse the same
verified manifest; do not regenerate it after consumption. Delete the old
variable. Secret masking is installed by Actions before it logs the step
environment; JavaScript also masks it before fixture initialization. No raw
manifest, password, key or token is evidence. Keep `ZEROS_DEV_E2E_ENABLED`
disabled while automated agent coverage is unavailable.

After the owner reviews the startup incident record, the planner preserves it
as `prestartRecovery`; no rerun or manual deletion of the failed attempt is
needed. It still authenticates/imports any real preceding signed receipt and
the cleanup-only local handoff. An unknown fixture workspace blocks admission.

The `infrastructure` job shares the fixture lock and exact cleanup allowlist.
It refreshes the qualified Computer at most once, creates one workspace, checks
terminal/file continuity across three stop/wake cycles, and requires one setup
claim for create and each wake. It then starts an ordinary resident shared PTY
task. Intent, exact session, run/fixture, boot/writer/funding scope, nonce and
program hash are signed before installation/allocation; uncertain starts are
never repeated. The helper detaches its observers before the client disconnects.

At each of the five connection points (create, three wakes, and detached
reconnect), a separate, bounded native SDK probe runs before the legacy workload
connection. It uses `CloudSdkRuntimeBroker`, `CloudSdkDeviceStream`,
`CloudSdkSocket` and the shared `RuntimeClient` with the fixture's enrolled
device. The SDK socket receives native authority directly in this headless
process; the app supplies the same existing IPC functions at its renderer
composition boundary. The probe advertises `platform: linux` and
`appVersion: zeros-dev`. It is source-level native conformance, not evidence
that a particular Mac installation or packaged renderer ran the path.

A completed or flag-disabled probe writes four closed `zeros.dev-evidence/v1`
phases, correlated by `sdk.probeId`, with finite monotonic `durationMs`. A failed
probe retains its attempted phases and first closed failure:

| Phase | Positive evidence |
| --- | --- |
| `sdk_device_session` | Fixture/workspace/device checks and a validated native-issued session/ticket |
| `sdk_device_stream_ready` | Exact-session native `ready` with `sdk.organizationCoverage: enabled` for the fixture org |
| `sdk_runtime_connect` | Native S3 admission with current workspace/generation/boot/capability binding |
| `sdk_runtime_ready` | Direct SDK authentication, exact-boot `ENGINE_READY`, shared handshake read, and final scope recheck; `sdk.route: direct` |

Session timing includes fixture/workspace/device validation. Stream timing starts
after session issuance; runtime-ready timing includes the final workspace/device
recheck. These measurements do not represent UI paint or first prompt latency.
The stream URL comes only from the CP advertisement, currently the Alpha API
origin. No ticket, capability, proof, cursor, URL or raw server error enters
evidence. The probe never marks a catalog snapshot current or publishes presence.

Generic route-absent 404s and the SDK's explicit disabled 403s produce
`outcome: skipped`, `sdk.skip: legacy_discovery`. An unavailable session skips
its dependent phases with `session_unavailable`; native legacy admission
(including old boot metadata) skips runtime readiness with `runtime_legacy`.
An explicit own-org stream disable or stream close 4404 uses
`organization_disabled` or `stream_disabled`. Missing own-org proof, auth
denials, specific workspace 404s, transient errors, malformed responses and
wrong scope fail. A relay winner cannot satisfy direct readiness. When only
`device_stream` is enabled, session and stream can pass while runtime phases
skip. Each probe starts fresh discovery, so later flag changes cannot reuse an
earlier negative decision.

The ordinary infrastructure result may pass with SDK skips while flags are off.
Full Step 3 source conformance requires all four phases to be `ok` for all five
probe IDs; legacy `runtime_connect`/`runtime_transport` rows cannot supply it.
This short probe does not prove renewals, long-lived stream continuity, polling
replacement, presence parity, relay, accepted-work Send or Mac UI behavior.
All probe sockets, renewal timers and native handles close before returning.
The existing native workload and detached proof remain separate. New evidence
fields are optional for old signed receipts and introduce no parsing defaults.

`detached_wait` measures 31 monotonic minutes with all client transports closed,
without CP polling, token refresh or actor retirement. Auth headroom is verified
before detach. Reconnect must reach the same boot, authority, writer, funding,
root and original terminal. `detached_native_proof` checks untruncated bounded
terminal replay, the retained first row and all 32 uniquely numbered, fsynced
file/output rows, 45–90-second gaps, over 30 minutes of VM work and an unchanged
program. The task retains its original 40-minute expiry; finish waits at most
120 seconds. A replacement, missing/duplicate output or truncated replay fails.
Public PTY replay has no event cursor: this is **native terminal/task output
coverage**, never an agent transcript or cloud-event completeness claim.

The original closed failure is checkpointed before bounded PTY/product cleanup.
Scope changes forbid killing a successor PTY. Normal workspace deletion remains
the fallback; compute retirement may pass with storage pending and
`deletionConfirmed=false`, under the existing backlog limits. The final
Computer pin is rechecked. Phases, UTC endpoints, measured active/detached
durations and actual transport/retry counters remain in the signed artifact.

Failed `detached_start` and `detached_native_proof` events may carry
`nativeProof: { predicate }`, from the strict allowlist in
`scripts/zeros-dev/native-proof-observation.ts`. It distinguishes unavailable
PTY admission, wrong reattach/cwd, exit, replay metadata, row identity/sequence,
heartbeat/duration and file checks without raw output or provider text. The
first predicate is saved before cleanup and retained in the signed/public
result through later cleanup or logout failures. Proof requirements, original
deadlines and no-restart behavior are unchanged. `pty_create_unavailable` means
the bridge returned no usable reply; it does not identify the reason. An
unchanged boot/writer does not exclude a checkpoint admission fence. Correlate
the predicate with lifecycle/checkpoint evidence. Legacy signed receipts remain
readable without defaults or rewrites; absent diagnostics remain unavailable.

The distinct `zeros.dev-infrastructure/v1` artifact and
`zeros.dev-infrastructure-result/v1` result require these coverage values:
`agents`, `accountModels`, `agentHistory` and `detachedAgent` are all
`not_covered_owner_section7` — **not covered (owner §7 test)**. Infrastructure
cannot set `hourly.complete`, activate/pass `zeros/dev-e2e`, fill an hourly soak
slot or claim full Gate 0. The owner separately verifies an hour of Claude,
Codex and Cursor work (§7.1), usable-account model menus (§7.2), cached chat
during wakes (§7.3), and a long agent task with complete transcript (§7.4).

The job allows 65 minutes, with a 3,800-second overall budget starting before
dependency installation. Computer preparation keeps its 300-second bound;
connect/create/stop requests keep their 30-second bounds, workspace observation
180 seconds, and cleanup a separate 140-second reserve. The normal run is
shorter than an hour; queued schedules remain serialized and never reset the
budget. Missing telemetry remains unavailable.

After the first infrastructure rehearsal, enable
`ZEROS_DEV_INFRASTRUCTURE_ENABLED=true` for the minute-23 schedule. This selects
infrastructure even if the old hourly opt-in was set, without an hourly pass.
Keep Alpha source/runtime fixed during the owner's 24-hour infrastructure soak.
Collect with `--profile infrastructure` below. Disable the infrastructure flag
to stop the schedule and the Gate 0 flag to stop manual rehearsals. Keep signed
cleanup debt and this reader until retirement finishes. The v4 release-check
bridge stays on branches during the soak and lands afterward.

## Full agent Gate 0 rehearsal contract

The `gate0` agent profile remains unavailable pending the v4 release-check
runner; selecting it currently refuses with `release_checks_unavailable`.
Existing signed `hourly.rehearsal` fields remain readable and strict. A future
bridge must compose independently named fixture lifecycle and owner-context
agent results, retain their original deadlines and first failures, and prove
one hour of real three-agent work, account-usable models, cached chat continuity
and a detached long agent task with complete transcript. An automation permit
cannot substitute for human-session expiry behavior or live model-menu UI
checks. Infrastructure/native proof never fills those agent fields.

## Collect a 24-hour evidence pack

The collector reads Actions only. Give it the fixture device's **public**
Ed25519 key and device UUID through the approved fixture inventory, plus an
Actions-read token in `GITHUB_TOKEN` or `GH_TOKEN`. It never reads `.env.agent`,
selects product credentials, dispatches work or contacts the CP/VM.

```sh
pnpm exec tsx scripts/zeros-dev/soak-cli.ts --profile infrastructure \
  --end <completed-UTC-hour> \
  --device-id <fixture-device-uuid> \
  --public-key <Ed25519-base64url-public-key> \
  --output <absolute-new-file-in-owned-directory>
```

`--end` must be an elapsed UTC hour boundary; the report covers its previous
24 hours. The output must be new, in an owned directory without symlink aliases
or group/world write permission. It is created exclusively at mode 0600 and
written through its verified descriptor. A write failure can leave a private
partial file; use a new output path on retry. Existing outputs are never
overwritten or deleted.

`zeros.dev-soak/v1` verifies trusted-main producers, exact attempt/job/artifact
identity, artifact SHA256 and the pinned device signature. The collection has
a three-minute budget, four listing pages and 200 attempts. Each UTC hour needs
completed hourly evidence; missing, unfinished, expired or unverifiable evidence
stays incomplete. Work finishing after the selected window cannot backfill it.
Every earlier attempt is retained, so a green rerun does not erase a red run.
Manual rehearsals have their own proof and cannot fill an hourly slot.

`--profile infrastructure` selects the independently signed infrastructure
profile and emits `zeros.dev-infrastructure-soak/v1`. Every selected hour needs
an executed infrastructure run with valid native proof and cleanup; hourly and
full Gate 0 runs cannot fill its slots. Every red attempt remains red after a
successful retry. Agent/UI exclusions are mandatory in this report. A passing
infrastructure window is the owner's option B soak, not a full agent/hourly
result. Omit the flag or use `--profile hourly` only for the full hourly scope.

The pack includes phase distributions, the first failed stage/code, setup and
connection diagnostics, UTC active windows, direct/relay counts and distinct
admission retry counts. Repeated cumulative observations are deduplicated by
run, connection and call. Missing legacy counters have unavailable coverage and
null rates. `status=passed` confirms the signed hourly window and its available
harness measurements; the raw rates remain in the pack for SLO assessment.
Idle database transactions, CPU, actor-confirm latency, CP egress and native
UI/Beta checks stay explicitly unverified for the backend and owner evidence
to complete. Exit status is zero only for a passed window; a closed JSON summary
names incomplete collection without leaking API bodies or token values.
