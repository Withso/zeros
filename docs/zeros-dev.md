# Linux zeros-dev

The harness runs against Alpha's existing account, Computer, cloud workspace,
agent and terminal APIs. It creates no hosted development deployment. Run it
from Linux with `pnpm exec tsx scripts/zeros-dev/cli.ts`. The package alias and
retirement of the old hosted Dev tooling are a separate change. `electron:local`
and `electron:alpha` retain their current launch paths.

## Alpha authentication boundary

The control plane registers `POST /auth/zeros-dev/session` only when its
authoritative deployment channel is Alpha, the checked-in cloud channel policy
allows Alpha, and `ZEROS_DEV_AUTH_ENABLED=true`. Other channels return 404,
including with stale settings and during database maintenance. VM engines do
not consult this policy. Ordinary Local and organization-local authentication
is unchanged.

The operator pins `ZEROS_DEV_AUTH_SUBJECT`, `ZEROS_DEV_AUTH_ACCOUNT_ID`,
`ZEROS_DEV_AUTH_EMAIL` and `ZEROS_DEV_AUTH_ORGANIZATION_ID` in the Alpha CP.
The account and verified WorkOS identity must already exist, have no staff
role, and belong to the active nonpersonal test organization. The route never
creates accounts, roles, memberships, credentials or entitlements. Requests
contain only a password, a UUID request ID, and Linux device intent. WorkOS must
issue the existing signed desktop contract; MFA, SSO-only, verification and
authentication-policy challenges cannot be continued or bypassed here.

Requests have a 4 KiB limit and a five-second response deadline. WorkOS bodies
are bounded at 128 KiB. The endpoint allows five attempts per source and twenty
globally per minute, with a process backstop and serialized database budgets.
Railway's trusted edge supplies `X-Real-IP`; other forwarded headers cannot
select a bucket. Missing or invalid peers share one bucket. Keep the API behind
that edge: the header alone is not peer authentication. The global cap also
applies when multiple edges or API replicas are involved.

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
connection. `org ensure` and `repo ensure` validate/adopt these prerequisites.
They do not create an org, change membership/funding, install a GitHub App or
write a recipe. `computer build` builds the existing draft using its normal CAS
revision and operation ID. A missing prerequisite fails explicitly.

```sh
pnpm exec tsx scripts/zeros-dev/cli.ts login
pnpm exec tsx scripts/zeros-dev/cli.ts github connect --repository OWNER/NAME --repository-id NUMERIC_ID
pnpm exec tsx scripts/zeros-dev/cli.ts org ensure
pnpm exec tsx scripts/zeros-dev/cli.ts repo ensure
pnpm exec tsx scripts/zeros-dev/cli.ts computer build --wait
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
agent observation at five, and an invocation at thirty. Standalone workspace
commands retain their run for iteration. `scenario run smoke --agent <agent>
--model <model>` creates a throwaway, verifies the repo through a terminal,
waits for an agent response, stops/resumes, repeats, then stops and deletes.
The resumed phase verifies its own small repository marker and continues the
same recorded conversation through the new admission.
`--build-computer` explicitly builds the configured draft first. The scenario
always attempts its recorded workspace's cleanup in `finally`, including after
SIGINT or a work deadline, with a separate thirty-second cleanup budget.
Cleanup that remains pending makes the scenario fail; its receipt is retained.

## Identity, evidence and cleanup

Run records are owned mode-0600 files under the canonical repository's private
`.context/zeros-dev/`, signed using the registered device key. They contain
operation IDs, exact resource bindings, payload hashes, source metadata and
closed results, not credentials or prompt/script content. Signatures detect
receipt corruption; product authorization remains mandatory. Writes preserve
the owned lock inode and refuse a changed saved receipt. Never copy only the
receipt to a different account/device to recover it.

`cleanup --run <run-uuid>` and `cleanup --all` preview the signed local allowlist;
`--apply` invokes ordinary product deletion. Names are only labels. Every write
rechecks org, creator, workspace, repository, generation and account binding.
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
emitted. Keep all live artifacts private and outside committed source.

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
state intact, and verified product deletion. If WorkOS cannot issue the existing
desktop contract, stop qualification; there is no alternative issuer, MFA/SSO
bypass or role seed. Every recoverable received grant stays under cleanup until
canonical persistence succeeds, including envelope, identity, verification and
save failures. Cleanup attempts normal current-session revocation; an attempt
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
