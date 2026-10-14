# Linux zeros-dev

The harness runs against Alpha's existing account, Computer, cloud workspace,
agent and terminal APIs. It creates no hosted development deployment. Run it
from Linux with `pnpm exec tsx scripts/zeros-dev/cli.ts`. The package alias and
retirement of the old hosted Dev tooling are a separate change. `electron:local`
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

Use `pnpm exec tsx scripts/zeros-dev/cli.ts --help` for the complete command
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
the existing status request with `setupProgress=true`; default desktop reads
keep their response shape. Deadline/failure evidence names `workspace_create_wait`,
`workspace_resume_wait`, `workspace_stop_wait` or `workspace_delete_wait` and, when
available, the last observed current-generation setup attempt, claim count,
state and closed error code. Unknown codes become `unknown`; raw logs and
provider fields are refused. An older CP or stale/malformed progress supplies
no setup evidence. The product's longer retry loop does not extend this wait,
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
serialized Alpha fixture and a fifteen-minute job limit. It uses the normal product
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

The execution step also receives the existing dedicated-test
`AGENT_RUNTIME_ANTHROPIC_API_KEY`, `AGENT_RUNTIME_CLAUDE_CODE_OAUTH_TOKEN`,
`AGENT_RUNTIME_OPENAI_API_KEY`, `AGENT_RUNTIME_CODEX_AUTH_JSON` and
`AGENT_RUNTIME_CURSOR_API_KEY`. These stay in memory, never in `.env.agent`.
API keys take precedence over native credentials to avoid rotating shared
test accounts unnecessarily. The normal product credential and org-connection
routes install fresh IDs for the run, select only the existing canary smoke
models, and disconnect/revoke exactly those IDs afterward. A foreign selection
is never overwritten, including during cleanup.

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
wake that settled as stopped is recorded and deleted; transient setup or
unconfirmed provider deletion reports `prior_cleanup`/`cleanup_pending`, and
no new workspace is allocated. Unknown creates/publications stay unknown;
there is no prefix scan or direct provider fallback. Do not delete artifacts
or change the fixture device to bypass this check. The owner must reconcile the
exact recorded operation through the normal product path when automatic
recovery cannot prove its outcome.

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
An unfinished cleanup or any failed stage keeps the run red.

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
pnpm agent:gh workflow run zeros-dev-e2e.yml --ref main
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

## Gate 0 rehearsal in Actions

The owner enables `ZEROS_DEV_GATE0_ENABLED=true` and dispatches the same trusted
main workflow with `profile=gate0`:

```sh
pnpm agent:gh workflow run zeros-dev-e2e.yml --ref main -f profile=gate0
```

Run it after the corrected runtime qualifies and the held incident workspace
has been released by its investigator. The rehearsal uses the same fixture
concurrency group, signed predecessor recovery, normal product routes and
Actions-only provider credentials as the hourly canary. It creates one new
allowlisted workspace, installs only the approved test account credentials and
retains every intent before execution. An uncertain predecessor blocks it.

The separate `gate0` job name keeps rehearsals out of hourly activation and
admission. The hourly profile retains its fifteen-minute job limit; the manual
profile allows 135 minutes, with an 8,000-second overall allowance starting
before installation. Computer preparation remains bounded at 300 seconds with
at most one build. Individual connect, create, stop and resume deadlines stay
unchanged, and cleanup retains its separate 140-second reserve.

The signed `hourly.rehearsal` proof covers these phases:

- `model_eligibility` compares installed native providers and the selected
  smoke models with the exact activated boot's funding-owner availability.
  Missing, stale or unavailable eligibility fails closed. This is the product
  input used by cloud model selection; native menu rendering and its reason/
  action presentation remain part of the owner's desktop check.
- `workload` spans at least sixty monotonic minutes. Thirteen sparse turns
  rotate Claude, Codex and Cursor using the canary's minimal models and normal
  Auto permissions. Each turn creates one small fixture file, verifies its
  contents through the terminal and hashes its durable history. Permission
  requests remain terminal; the harness never fabricates an approval.
- Three stop/resume cycles record stop, ready and usable timings, plus file
  and history continuity. Create and every wake require a successful setup
  observation with exactly one claim. `setup_retried` and
  `setup_observation_unavailable` retain the observed setup and keep the
  rehearsal red. Any unplanned transport loss during work is terminal.
- `detached_auth` refreshes through the existing session contract and records
  only verified remaining validity. A short grant gives `detached_auth_window`.
  A normal Codex turn runs a bounded 31-minute Python task. `detached_start`
  proves its exact durable dispatch and a live heartbeat before disconnect.
  `detached_wait` closes all device transport for at least thirty minutes,
  without CP polling, session refresh, actor retirement or a hidden client.
  The VM continues its ordinary authority checks against a healthy CP.
- `detached_history` reconnects to the same boot/funding/execution identity
  and requires the original terminal receipt, contiguous event replay,
  retained transcript prefix and a complete monotonic VM heartbeat journal.
  It never sends the task twice. Transcript data, prompts, file contents,
  runtime destinations and credential values stay out of public artifacts;
  receipts contain counts, durations and hashes.

Actual socket attempts and authenticated ready events supply separate direct
and relay counters. Closed authority reasons, losses and admission retries are
recorded without using throttled logs as a denominator. Missing observation
support remains unavailable. The first failed phase survives later disconnect,
cleanup or logout failures. The same signed receipt carries pending cleanup
to the next run.

Schedule this longer rehearsal before starting the clean 24-hour soak. It
occupies the single fixture for roughly 95–120 minutes and can delay an hourly
run beyond the unchanged two-hour freshness limit. It supplies no freshness
exemption. The owner still verifies native cached-chat presentation, menu
actions, the actual laptop-close experience and Beta Local behavior. A Linux
rehearsal does not measure a CP outage or arbitrary expired-session continuity.
UTC active windows and verified duration are available for the backend egress
correlation; they cover completed workload observations, not billable VM time.

Rollback disables `ZEROS_DEV_GATE0_ENABLED`. Keep this version of the receipt
reader and the signed predecessor until product cleanup completes; older strict
readers cannot interpret rehearsal fields. Local Personal, organization-local,
owner switching and Beta/Production behavior retain their existing paths.

## Collect a 24-hour evidence pack

The collector reads Actions only. Give it the fixture device's **public**
Ed25519 key and device UUID through the approved fixture inventory, plus an
Actions-read token in `GITHUB_TOKEN` or `GH_TOKEN`. It never reads `.env.agent`,
selects product credentials, dispatches work or contacts the CP/VM.

```sh
pnpm exec tsx scripts/zeros-dev/soak-cli.ts \
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
