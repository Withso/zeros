# WorkOS Hosted AuthKit architecture and rollout

Status: foundation implemented; Alpha qualification in progress. Repository
implementation, dashboard configuration, deployment, and real Alpha acceptance
are separate release gates; this document never treats a local test pass as a
production approval.

Retention: keep this document while Auth0 compatibility exists. After every
supported release uses WorkOS, move the durable contracts into the permanent
architecture and deployment guides, remove Auth0 code/configuration in a
separate rollout, then delete this migration document.

## Decision

Zeros uses [WorkOS Hosted AuthKit](https://workos.com/docs/authkit/hosted-ui) as
the only interactive authentication surface. Zeros does not render password,
one-time-code, email-verification, MFA, social-provider, or account-linking
forms. Hosted AuthKit owns those ceremonies, including verification,
localization, and recovery; provider-side bot controls remain subject to the
explicit policy below.

The intended Alpha methods are Google, GitHub, and WorkOS Magic Auth (the
hosted six-digit, single-use email code). Email + Password is not part of the
Zeros launch contract and should remain disabled unless a later product and
threat-model decision adds it. WorkOS sends the authentication emails; Zeros
does not retrieve, store, log, proxy, or deliver Magic Auth codes.

Radar is explicitly deferred because it is a paid feature. Leave it disabled;
the foundation must remain secure without it. If it is purchased later, begin
in observation/log mode, inspect detections and false positives, and approve a
separate enforcement change. No Zeros authorization decision may depend on
Radar being present.

Every authorization URL uses `provider=authkit`. Browser, Pages, desktop, and
deep-link callers cannot select a WorkOS connection, organization, or social
provider. Legacy `provider`, `connection`, and `organization` query parameters
are deliberately ignored during the rolling transition; they never reach the
WorkOS SDK.

This removes the former custom Google/GitHub chooser and the application-owned
GitHub email-verification continuation. There is no anonymous endpoint that
accepts pending WorkOS credentials or infers verification from webhook timing.
If Hosted AuthKit has not completed verification, Zeros receives no usable
session. A defensive desktop error mapping remains so an unexpected
`email_verification_required` response fails closed.

WorkOS authenticates people and is authoritative for WorkOS identities,
credentials, provider sessions, collaborative-organization objects, native
invitation delivery, and the provider-side membership lifecycle. Zeros
Postgres remains
authoritative for durable product account IDs, Personal, billing and
entitlements, child teams, team membership, workspace/repository access,
product permissions, audit history, and all cloud resources. Zeros also keeps
the locally enforced projection and desired state for WorkOS organizations,
memberships, and invitations, plus every non-SCIM product-access grant. A
non-directory WorkOS membership can converge an existing locally authorized
member but cannot create Zeros access by itself; SCIM remains the explicit
enterprise provisioning exception. Provider objects are never queried on every
API request; signed events and a durable repair stream converge the projection.

This split is intentional: WorkOS can revoke authentication or enterprise
membership, while a WorkOS outage cannot make Zeros forget who owns product
data. Authorization still fails closed when the local account/session or
organization membership is inactive.

## Reviewed implementation phases

The foundation landed as one reviewed PR so schema, server, web, desktop,
tests, and runbooks could not be promoted in incompatible combinations. Live
Alpha qualification then found three integration defects that could only be
fixed after that merge; each corrective patch received its own green review
and was promoted in order. The phases below remain logical gates, not
independently supported partial designs:

1. **Contracts and schema.** Preserve stable Zeros UUID ownership; add identity
   and session lifecycle, WorkOS organization/membership projections, durable
   command/event outboxes, authorization/data revisions, reviewed recovery,
   and security-notification outboxes with forward-only migrations.
2. **Hosted authentication.** Make Hosted AuthKit the one Web/Desktop entry;
   implement browser server-side code+PKCE and opaque host-only cookies;
   implement Electron public-client code+PKCE, exact-channel deep links,
   pinned JWT verification, and OS-protected persistence.
3. **Account safety.** Register every WorkOS session, reject email-based
   ownership transfer, disable a deleted provider identity without deleting
   product data, and expose a fresh-auth, staff-reviewed recovery flow with
   immutable audit/security notifications.
4. **Collaborative identity.** Mirror every non-Personal Zeros organization to
   one WorkOS organization; serialize organization, membership, invitation,
   and revocation commands; consume signed WorkOS events; and repair missed
   webhooks through the cursor-based Events API.
5. **Immediate authorization changes.** Publish durable security revisions to
   one authenticated SSE stream per active client. Use launch/reconnect/focus/
   wake snapshots only after stream silence; never add a universal 30-second
   authentication poll.
6. **Product enforcement and UX.** Gate cloud create/wake on an active WorkOS
   organization link, preserve cleanup during provider incidents, refuse local
   edits to directory-managed memberships, and give recovery/conflict/outage
   states distinct bounded UI on web and desktop.
7. **Qualification and promotion.** Run the complete repository, migration,
   database, Electron, packaging, security, license, and build suites; deploy
   the same SHA to Alpha Railway and Pages; configure WorkOS; execute the real
   web/macOS matrix; observe; then promote unchanged to Beta/Production.

Every phase retains its regression tests in the same PR. A failure in any gate
blocks merge; rollback changes provider/configuration atomically and never
reinterprets product ownership.

## Durable identity boundary

- `users.id` is the durable Zeros account ID. Product data never uses a WorkOS
  subject as its owner key.
- `user_identities(provider, provider_sub)` maps a verified WorkOS `sub` to one
  Zeros account. The mapping key is `provider='workos'`, not the Google or
  GitHub credential used at sign-in.
- Identity lookup and ownership changes are subject-based. Email is profile
  data, not an ownership key. A new subject colliding with an existing email
  fails closed for operator-reviewed recovery; it never transfers ownership.
- Google and GitHub login identities can belong to one WorkOS User through
  WorkOS identity linking. Zeros does not implement parallel email-based
  linking. WorkOS documents why unverified identities must never be linked:
  [Identity linking](https://workos.com/docs/authkit/identity-linking).
- `user.updated` refreshes bounded profile data. `user.deleted` disables the
  identity and Zeros account, revokes all known browser/desktop sessions and
  cloud endpoint grants, and removes collaborative access. Personal and all
  product data remain preserved for reviewed recovery or retention policy.
- The independent Zeros GitHub App remains the sole owner of repository
  authorization. WorkOS login must not request extra GitHub scopes or return
  provider access/refresh tokens.

## Account deletion, replacement, and recovery

Deleting a WorkOS User is an authentication revocation, not a product-data
deletion. The signed `user.deleted` event moves the subject mapping to
`provider_deleted`, moves the Zeros account to `identity_disabled`, tombstones
its provider memberships, revokes sessions/grants, emits durable security
events, and queues a bounded notification email. Product rows continue to use
the unchanged Zeros UUID.

If someone later signs in with a newly created WorkOS User that has the same
email, Zeros does **not** relink it. A recent provider authentication creates a
24-hour recovery request and displays only its public `ZR-…` locator. An exact
`support_admin` operator must reauthenticate within five minutes, verify the
evidence out of band, and approve the exact request. A `developer` is not a
recovery operator, and a `support_admin` does not receive developer-only app
surfaces. Approval supersedes the deleted identity,
binds the new subject to the original UUID, increments the account revision,
audits the operation, and sends a notification. It does not silently restore
collaborative memberships; those must be re-provisioned by the organization or
enterprise directory.

An active account reached through a different WorkOS subject returns
`account_exists`; email alone is never enough to merge it. Browser and desktop
render fixed guidance for `account_exists`, `reauthentication_required`,
inactive accounts, and reviewed recovery. Raw provider/database messages are
discarded.

### Recovery-operator bootstrap and revocation

`users.staff_role` is deliberately not writable by `zeros_app`; neither an API
route nor compromised application code can grant staff authority. Use the
database-owner command from a controlled Railway shell or an equivalent
operator workstation. Never persist these one-shot variables on the service.

Set `DATABASE_URL` plus these target-bound inputs:

- `CONTROL_PLANE_STAFF_CHANNEL` — `development`, `alpha`, `beta`, or
  `production`; it must match `RAILWAY_ENVIRONMENT_NAME` when Railway supplies
  one.
- `CONTROL_PLANE_STAFF_SUBJECT_USER_ID` and
  `CONTROL_PLANE_STAFF_EXPECTED_EMAIL` — both must resolve to the same exact
  Zeros account.
- `CONTROL_PLANE_STAFF_ACTOR_USER_ID` — the accountable human operator's Zeros
  UUID. A second person is preferred for Production bootstrap.
- `CONTROL_PLANE_STAFF_ROLE` — `support_admin`, `developer`, or `none` for
  revocation.
- `CONTROL_PLANE_STAFF_REASON` — a 16–512 character audit reason.

Run the read-only plan first:

```sh
pnpm --dir apps/control-plane staff:manage
```

The plan prints no database URL or email. It returns an approval string bound
to the database fingerprint, deployment channel, actor, subject, current role,
next role, and a hash of the reason. Copy that exact value into
`CONTROL_PLANE_STAFF_APPROVAL`, then execute:

```sh
pnpm --dir apps/control-plane staff:manage --execute
```

Production additionally requires
`CONTROL_PLANE_STAFF_PRODUCTION_CONFIRMED=true`. Execution re-locks and
revalidates the target, rejects a stale plan, increments `auth_revision`, emits
`account.authorization_changed`, and appends the owner-only
`staff_role_changes` record in the same transaction. The ordinary application
role can neither mutate the staff column nor forge that evidence.

## Organization management synchronization

Every collaborative Zeros organization owns exactly one WorkOS Organization,
correlated by `external_id=<zeros organization UUID>`. Personal deliberately
has no WorkOS Organization. Zeros-originated changes commit product state and a
command in the same PostgreSQL transaction; a leased worker then converges the
provider operation. Commands are at-least-once, aggregate-ordered, retry with
bounded backoff, recover from provider-accepted/lost responses by listing the
provider object, and dead-letter rather than guessing after a terminal error.

Signed webhooks are the low-latency path. The WorkOS Events API is the durable
repair path and advances a stored cursor only after an event is applied,
ignored by policy, or safely quarantined for forward-incompatible payloads.
Projection timestamps reject stale updates. Successful local removal writes a
terminal membership tombstone, and an event arriving while a membership
command is queued/processing may update the provider projection but cannot
overwrite the locally enforced desired state. Invitation replacement is
serialized by organization plus a hash of normalized email. If an invitation
event arrives after WorkOS accepts a command but before the exact provider ID
is committed locally, it is retained as ignored and replayed immediately after
that exact ID is correlated; replay never falls back to email matching.

The invitation command asks WorkOS to send one seven-day native branded email,
including the authenticated inviter when available. Each WorkOS Application's
custom User Invitation URL points to the exact channel's `/invite`; WorkOS
appends `invitation_token`. Web and Desktop carry that opaque value only to the
authenticated Zeros acceptance endpoint. Railway resolves it through the
WorkOS API, then requires the returned pending object to match the exact stored
provider invitation ID, linked WorkOS organization, recipient email, and role.
A WorkOS organization invitation is intentionally not passed into AuthKit's
authenticate call: WorkOS documents that a corporate-domain invitation may be
accepted by a different address on the same domain. Hosted AuthKit performs the
normal identity ceremony, while Zeros' authenticated acceptance endpoint keeps
the stricter exact-recipient product-authorization boundary. This assumes normal
AuthKit registration remains available; an invite-only registration rollout
would require a separately reviewed design that preserves this exact check.
A command/email race is retryable only while the matching local outbox command
is queued or leased. A Dashboard-created invitation with no Zeros record fails
closed. The locally generated token remains a compatibility/copyable-link
capability: it cannot be consumed until the exact provider ID is correlated,
and every attempt re-fetches that WorkOS invitation by ID and requires it to
remain pending with the exact organization, recipient, and role before applying
the same exact-recipient check. A direct WorkOS revoke therefore fails closed
even if its webhook or Events API repair has not reached Railway yet.

Consuming either supported invitation capability retires every pending WorkOS invitation for the
exact organization/email pair before creating or updating the coarse WorkOS
membership. Removing a member uses the same ordering key: pending invitations
are revoked before the membership is deleted. Revoke and delete commands always
reconcile their captured provider ID with the current provider listing, so a
duplicate invitation, a lost-response replacement, or a membership created
after the local transaction cannot escape cleanup. If provider-side invitation
acceptance wins between listing and revocation, the event invalidates the
still-pending local invitation rather than marking product access accepted.
An unsolicited non-SCIM active membership is projected for audit/repair but is
not materialized into `organization_members`. The serialized membership command
then enforces Zeros' current desired state. This closes both the old-invite
re-add race and WorkOS's documented same-corporate-domain invitation allowance.

For an existing WorkOS user, sending a provider invitation also creates a
`pending` organization membership. Revoking that invitation does not activate
the membership, and WorkOS requires a pending membership to be deleted before
an active membership can be created. The command worker therefore observes the
provider after a failed create, recovers an already-active membership, or
deletes non-directory-managed pending memberships and creates the active
replacement. WorkOS lists only active memberships by default, so every
reconciliation listing explicitly requests `active`, `inactive`, and `pending`
statuses. A delayed deletion event for the replaced pending object is keyed
to that exact WorkOS membership ID and cannot remove the newer active object.

Directory-managed (`directory_managed=true`) memberships materialize with
`membership_source='scim'`. Zeros refuses local role changes and removals for
them because directory group assignment takes precedence and would otherwise
create split-brain access. Enterprise administrators must make those changes
in their identity provider.

The subscribed management event set is:

- `user.created`, `user.updated`, `user.deleted`;
- `session.created`, `session.revoked`;
- `organization.created`, `organization.updated`, `organization.deleted`;
- `organization_membership.created`, `.updated`, `.deleted`; and
- `invitation.created`, `.accepted`, `.revoked`, `.resent`.

`user.created` is recorded/ignored for JIT product provisioning: only a
verified Zeros API request creates the durable product account. Events are
idempotent by WorkOS event ID.

## Revocation without polling

Zeros does not call WorkOS every 30 seconds. Railway verifies ordinary access
tokens locally and checks the Postgres account/session/membership projection.
Security-relevant transactions increment monotonic revisions, append a durable
`security_events` row, and wake connected clients through PostgreSQL
`LISTEN/NOTIFY` (the notification is only a wake-up; rows are replayable).

The browser maintains one authenticated EventSource and the desktop main
process maintains one bounded SSE connection. Account revocation broadcasts to
every session for that account; a session revocation is replayed only to the
client whose verified `sid` exactly matches the event. This keeps ordinary
device logout device-scoped, while explicit all-device logout revokes each
provider session. Organization authorization/data events refresh scoped state.
Browser section snapshots and in-flight loads are generation-bound by exact
organization/section key; an invalidation detaches an older request, and every
waiter follows the replacement request instead of publishing stale member or
invitation data.
Launch performs a snapshot. Focus, visibility, macOS wake/unlock, and reconnect
request another snapshot only when the stream is absent or has been silent for
at least 60 seconds. A provider/network timeout preserves the last confirmed
state; a terminal 401/403 clears only the exact expected session using
compare-and-set. Every protected API request remains the final enforcement
boundary, so a disconnected client cannot use stale UI to regain access.

## Trust boundaries

| Component             | Authentication responsibility                                                                                                              | Secrets permitted                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| WorkOS Hosted AuthKit | Credentials, social login, email verification, MFA, account linking, recovery, bot controls                                                | WorkOS-managed credentials and provider secrets                              |
| Railway control plane | Browser PKCE exchange, sealed browser sessions, refresh serialization, logout/revocation, webhook verification, JWT/resource-server checks | WorkOS API key, cookie password, webhook secret                              |
| Railway Postgres      | Single-use browser flow state, serialized sealed sessions, internal identity mapping and authorization                                     | Short-lived PKCE verifier and sealed session; no browser access-token column |
| Cloudflare Pages      | Stateless same-origin routing and exact-channel HTTPS desktop callback                                                                     | No WorkOS API key, cookie password, refresh token, or client secret          |
| Electron main         | Public-client PKCE, exact-channel deep-link validation, WorkOS token exchange/verification, OS-protected persistence                       | Public client ID, in-memory verifier, encrypted session material             |
| Renderer              | Starts/cancels sign-in and receives bounded session/UI state                                                                               | No verifier, authorization code, refresh token, API key, or client secret    |

WorkOS API calls are isolated to explicit authentication and management
operations. Ordinary `/v1/*` requests verify JWTs locally against pinned JWKS;
they do not call WorkOS and do not need its API key.

## Browser flow

1. The signed-out hub links only to `/auth/start?return=<safe-relative-path>`.
   Pages discards every other authorization selector and forwards the request
   to the matching Railway channel.
2. Railway generates 256-bit random browser credential, OAuth state, and PKCE
   verifier values. Only SHA-256 digests of the browser credential and state
   are indexed in Postgres. The verifier is retained in the expiring flow row
   because it is required for code exchange.
3. Railway sets a `Secure`, `HttpOnly`, host-only, `SameSite=Lax`
   `__Host-zeros_auth_flow` cookie and redirects to Hosted AuthKit with
   `provider=authkit`, S256 PKCE, the Web Application client ID, and the exact
   HTTPS callback. `Lax` is limited to this short-lived cross-site callback
   ceremony.
4. Hosted AuthKit completes the entire login, verification, MFA, recovery, and
   linking ceremony before returning a code.
5. Railway atomically claims the ten-minute flow using both cookie and state,
   exchanges the code, requires a verified WorkOS user, authenticates the
   sealed session, and promotes the same row to a browser session.
6. Railway rotates to the `Secure`, `HttpOnly`, host-only, `SameSite=Strict`
   `__Host-zeros_session` cookie on a no-store, no-referrer `200` completion
   document. That document immediately performs a same-site navigation to the
   previously bounded relative return path, with a manual-link fallback. A
   `3xx` is intentionally not used here: browsers retain the cross-site AuthKit
   context across redirect hops and withhold Strict cookies until a same-site
   document initiates the next navigation.
7. Pages obtains a short-lived access token from Railway only while proxying
   an authenticated request. It never persists provider tokens.

Browser refresh is serialized under PostgreSQL advisory and row locks so
rotating refresh material cannot race across Railway replicas. A transient
provider/network error retains the last valid sealed-session snapshot for a
bounded retry; a terminal provider result deletes the local session.

## Desktop flow

1. Electron main creates a 256-bit state suffix and PKCE verifier, retains the
   verifier only in the pending in-memory flow, and opens
   `${APP_ORIGIN}/auth/desktop` in the system browser.
   The OS browser-launch acknowledgement is bounded to five seconds because
   some shell/browser combinations open successfully without settling the
   promise. The main-owned ten-minute PKCE deadline remains authoritative;
   a late launch failure closes that exact attempt and surfaces a retryable
   signed-out state.
2. Pages immediately forwards the bounded state and S256 challenge to
   Railway. `/auth/desktop/start` remains as a compatibility entry point for
   older pages/releases, but no longer honors a provider selector.
3. Railway validates the exact channel scheme in state, fixes the redirect to
   `${APP_ORIGIN}/auth/desktop/callback`, selects the Desktop Application
   client ID, and redirects to Hosted AuthKit.
4. The HTTPS callback emits only a short-lived authorization code, state, or
   bounded provider error to the exact installed channel:
   `zeros-alpha://`, `zeros-beta://`, or `zeros://`.
5. Electron validates state with a timing-safe comparison and exchanges the
   code directly with WorkOS using PKCE. It verifies RS256, exact issuer,
   audience, Desktop Application `client_id`, required token identifiers,
   namespaced email, and `email_verified=true` before persistence.
6. Electron resolves the internal Zeros account and stores session material
   through OS-protected `safeStorage`. If account resolution or persistence
   fails after WorkOS created a session, it attempts to revoke that session.

The custom scheme is a Zeros handoff after WorkOS returns to HTTPS. It is not a
new-build WorkOS redirect URI. Authorization codes are short-lived and bound
to the verifier that never enters the browser, Pages, callback URL, renderer,
or logs.

The current Electron design applies to macOS, Windows, and Linux. Each packager
must register only its release channel's scheme and must pass the same hostile
deep-link regression suite. Platform packaging checks remain mandatory; a
successful macOS smoke test is not evidence for Windows or Linux registration.

## Environment and Application topology

Authentication data is isolated by release channel. Never share a Production
user/session boundary with Alpha or Beta.

| Zeros channel | WorkOS environment                     | Current Applications                               | Audience                        |
| ------------- | -------------------------------------- | -------------------------------------------------- | ------------------------------- |
| Alpha         | isolated staging/test-data environment | `Zeros Web Alpha` (default), `Zeros Desktop Alpha` | `https://api-alpha.zeros.build` |
| Beta          | isolated staging/test-data environment | `Zeros Web Beta` (default), `Zeros Desktop Beta`   | `https://api-beta.zeros.build`  |
| Production    | isolated production environment        | `Zeros Web` (default), `Zeros Desktop`             | `https://api.zeros.build`       |

WorkOS Applications share the environment's user base while keeping client
IDs, redirect URIs, sessions, and credentials separate. See
[Applications](https://workos.com/docs/authkit/applications). The default Web
Application establishes the environment issuer/JWKS contract; every token is
still admitted only when its `client_id` belongs to the configured Zeros
application allowlist.

Future clients follow the same rule:

| Platform                | Recommended WorkOS boundary                                                                                                                          | Client treatment                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Browser                 | One Web Application per release channel                                                                                                              | Server-brokered code + PKCE; secret only on Railway                               |
| macOS / Windows / Linux | Separate Desktop Application when platform policy or callback registration diverges; current Electron releases share the channel Desktop Application | Public client, system browser, PKCE, exact-channel app link                       |
| iOS                     | One iOS Application per release channel                                                                                                              | Official AuthKit iOS SDK, system authentication session, PKCE, universal/app link |
| Android                 | One Android Application per release channel                                                                                                          | Official AuthKit Android SDK, system browser/custom tab, PKCE, verified app link  |

Before adding mobile or platform-specific desktop client IDs, extend the
backend verifier from the current Web/Desktop pair to an explicit
platform-to-client-ID allowlist. Do not reuse the Web client ID and do not put a
WorkOS API key or cookie password in any distributed application.

## Redirect matrix

Register these exact HTTPS redirects:

| Channel    | Web Application                               | Desktop Application                                   | Post-callback app handoff     |
| ---------- | --------------------------------------------- | ----------------------------------------------------- | ----------------------------- |
| Alpha      | `https://app-alpha.zeros.build/auth/callback` | `https://app-alpha.zeros.build/auth/desktop/callback` | `zeros-alpha://auth/callback` |
| Beta       | `https://app-beta.zeros.build/auth/callback`  | `https://app-beta.zeros.build/auth/desktop/callback`  | `zeros-beta://auth/callback`  |
| Production | `https://app.zeros.build/auth/callback`       | `https://app.zeros.build/auth/desktop/callback`       | `zeros://auth/callback`       |

Do not register wildcard production redirects. Localhost redirects belong only
to disposable development/testing Applications. Retain legacy redirects only
for the measured support/rollback window, then remove them in a recorded
dashboard change.

## Token contract

Capture the contract from real tokens in each environment; do not derive it
from a dashboard domain or assume two Applications emit identical claims.

Zeros currently requires:

- `alg=RS256`;
- exact `iss` from `AUTH_ISSUER`;
- exact API `aud` from `AUTH_AUDIENCE`;
- signature from the exact `AUTH_JWKS_URL`;
- non-empty `sub`, `sid`, and `jti` plus numeric `iat` and `exp`;
- `client_id` equal to the configured Web or Desktop Application ID for that
  path;
- non-empty `https://zeros.build/email`; and
- `https://zeros.build/email_verified` equal to boolean `true`.

Optional presentation claims are
`https://zeros.build/name` and `https://zeros.build/picture`. Authorization
never depends on them.

The Alpha contract previously qualified with a shared environment issuer/JWKS,
distinct Web/Desktop `client_id` values, RS256, namespaced claims, and
five-minute access tokens. Re-run the contract probe after every Application,
JWT-template, session-policy, custom-domain, or WorkOS-environment change.
Recorded initial session policy was 30-day maximum / 7-day inactivity for web
and 90-day maximum / 30-day inactivity for desktop; the dashboard remains the
authority and must be re-audited before deployment.

## WorkOS dashboard checklist

Perform this independently for Alpha, Beta, and Production and record the
result without copying secrets into tickets or repository files.

1. Confirm the exact environment and make its Web Application the default.
2. Create/verify separate Web and Desktop Applications and record their public
   client IDs.
3. Register only the channel's exact redirects and default sign-out URI.
4. Enable Hosted AuthKit, Google, GitHub, and Magic Auth. Keep email
   verification and WorkOS-managed authentication email enabled. Keep
   email-and-password authentication disabled unless a later product decision
   adds it. Configure MFA/recovery policy in Hosted AuthKit, not in Zeros code.
5. Keep WorkOS's native **user invitation** email enabled. Under the exact
   channel Application's redirect settings, set **User Invitation URL** to
   `https://app.zeros.build/invite`,
   `https://app-beta.zeros.build/invite`, or
   `https://app-alpha.zeros.build/invite` as appropriate. WorkOS appends
   `invitation_token`; the page offers the exact Desktop channel or the
   Railway-owned browser state/PKCE flow, stores the token only in tab-scoped
   `sessionStorage`, and strips it from the address bar before sign-in. Create
   organization invitations through Zeros, not manually in the WorkOS
   Dashboard. Keep Magic Auth, verification, recovery, and other WorkOS
   authentication emails enabled. See WorkOS
   [Invitations](https://workos.com/docs/authkit/invitations),
   [Applications](https://workos.com/docs/authkit/applications), and
   [Custom Emails](https://workos.com/docs/authkit/custom-emails).
6. Configure Zeros-owned Google/GitHub OAuth credentials before Production.
   Provider tokens and extra provider scopes must remain disabled. Follow the
   WorkOS [GitHub OAuth setup](https://workos.com/docs/integrations/github-oauth)
   and equivalent provider guidance.
7. Install the exact JWT template required above. Reject any template that
   drops the boolean verified-email claim or changes audience.
8. Set and record Web/Desktop access-token and session durations. Review
   [Sessions](https://workos.com/docs/authkit/sessions) and
   [session resilience](https://workos.com/docs/authkit/session-resilience).
9. Create a webhook endpoint on the channel API origin at
   `/auth/workos-webhook`, subscribed to the complete management event set in
   this document. Store its signing secret only in Railway. Confirm the Events
   API repair worker uses the same event set and environment.
10. Apply branding, support/contact, legal, and localization settings. Keep the
   Zeros signed-out page a launch surface, not a second login UI.
11. Confirm Radar remains disabled and record that state. Do not change its
    enforcement behavior as part of this rollout.
12. For Production, evaluate an AuthKit custom domain as a branding and
    anti-phishing improvement. A separate Auth API custom domain is not needed
    by this design; keep API/JWKS configuration pinned to the qualified WorkOS
    endpoints unless a reviewed migration changes it. See
    [custom domains](https://workos.com/docs/custom-domains) and
    [Auth API custom domains](https://workos.com/docs/custom-domains/auth-api).

## Runtime configuration

Railway receives:

```text
AUTH_PROVIDER=workos
APP_ORIGIN=<exact channel app origin>
AUTH_ISSUER=<qualified exact issuer>
AUTH_JWKS_URL=<qualified exact JWKS URL>
AUTH_AUDIENCE=<exact channel API audience>
AUTH_WEB_CLIENT_ID=<channel Web Application client ID>
AUTH_DESKTOP_CLIENT_ID=<channel Desktop Application client ID>
WORKOS_API_KEY=<channel environment server key>
WORKOS_COOKIE_PASSWORD=<unique random 32+ character value>
WORKOS_WEBHOOK_SECRET=<channel endpoint signing secret>
```

`WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`, and `WORKOS_WEBHOOK_SECRET` are
Railway-only secrets. Rotate each independently per channel. A cookie-password
rotation invalidates outstanding browser sealed sessions, so schedule and
communicate it as a forced browser sign-in.

WorkOS mode does not require `ZEPTOMAIL_TOKEN` or `EMAIL_FROM` for organization
invitations; the WorkOS invitation command owns the one delivery. Those
variables remain optional for Zeros-specific recovery/account-lifecycle
security notifications and the Auth0 rollback path. WorkOS custom email
branding/domain configuration is not a generic transactional email API, so a
separate provider is still required if those product notifications must be
delivered. Security notifications use the durable outbox with a stable client
reference, and operators must monitor failures rather than treating an HTTP
timeout as proof that a message was not accepted.

Pages receives only `AUTH_PROVIDER=workos`, `APP_ORIGIN`, and the matching
`CONTROL_PLANE_URL`. Electron compiles only public verification/configuration
values: provider, app origin, desktop client ID, issuer, JWKS URL, and audience.

## Rollout and rollback

1. Snapshot current dashboard/application settings and deployed SHAs.
2. Configure Hosted AuthKit, Applications, redirects, JWT template, sessions,
   social credentials, and webhook in Alpha.
3. Deploy the backward-compatible Railway slice first. Old provider query
   parameters remain accepted but inert; the old verification endpoint is
   absent.
4. Deploy Alpha Pages, then an Alpha desktop build from the same qualified
   commit. Set `AUTH_PROVIDER=workos` only when all three surfaces have their
   complete configuration.
5. Run automated repository/emulator checks and the manual Alpha matrix below.
6. Hold an observation window, audit provider and Zeros session/revocation
   events, then repeat in Beta from the exact promoted SHA.
7. Promote the exact Beta SHA to Production with Production autodeploy still
   disabled. Do not recreate configuration ad hoc during promotion.
8. Retain Auth0 code/configuration only for the declared rollback window. Its
   removal is a later, separately reviewed change.

Rollback is an atomic provider/configuration rollback across Railway, Pages,
and the desktop release. Do not restore the deleted verification bypass or mix
WorkOS-issued sessions with Auth0 verification. Existing WorkOS sessions may
be revoked during rollback; internal product ownership remains safe because it
uses Zeros account UUIDs.

## Verification strategy

Automated tests cover:

- Hosted AuthKit is always selected for Web and Desktop Applications;
- legacy/hostile provider, connection, and organization selectors are inert;
- browser flow/state credentials, return-path bounds, one-time claims,
  promotion, cookie properties, refresh serialization, and logout;
- desktop state/channel/PKCE/deep-link validation and fail-closed persistence;
- removal of the anonymous verification endpoint and pending-token handling;
- JWT signature/issuer/audience/client-ID/verified-email contracts; and
- WorkOS's official local emulator performing Hosted AuthKit authorization,
  PKCE exchange, JWT-template rendering, sealed-session authentication, and a
  wrong-verifier rejection.

Use the emulator for deterministic integration and failure tests. WorkOS
recommends a smaller real-staging suite for final compatibility. Do not automate
the real Hosted UI as the primary E2E suite: provider UI and WorkOS Radar/bot
controls are deliberately dynamic. See
[Testing AuthKit](https://workos.com/docs/authkit/testing).

Manual Alpha acceptance must verify:

- first-time and returning sign-in for every enabled method;
- verification, denied/cancelled login, recovery, and MFA when enabled;
- one WorkOS User when the same verified person uses Google and GitHub;
- separate Web/Desktop session IDs and correct `client_id` claims;
- browser refresh under concurrent requests and provider outage behavior;
- desktop sign-in, restart restore, refresh, logout, all-session revocation,
  cancellation, timeout, and malformed/wrong-channel deep links;
- invalid Magic Auth code rejection, correct code, expiration, replay
  rejection, persistence, and logout on both browser and desktop;
- Google and GitHub first/returning login plus WorkOS identity-linking behavior;
- user profile update/deletion, session revocation, organization/member/invite
  webhook idempotency, reordering, lost-response recovery, and Events API
  repair;
- one and only one native WorkOS invitation email, proving there is no Zepto
  duplicate and `invitation_token` accepts through exact server-side
  correlation, strict state/PKCE on web, and the exact release-channel deep
  link on desktop;
- WorkOS User deletion while browser and desktop are open, proving both clients
  terminate and that a recreated same-email identity enters reviewed recovery;
- organization member removal/role change while both clients are open, proving
  only organization-scoped access changes and Personal remains usable;
- directory-managed membership refusal, last-owner safety, and cloud
  create/wake denial after access or provider-link loss;
- stream interruption/provider outage, proving last confirmed UI is retained
  but protected APIs still deny stale access;
- Pages contains no WorkOS secrets and response headers prevent auth callback
  caching/referrer leakage; and
- macOS smoke checks plus separately recorded Windows/Linux packaging checks
  before claiming those platforms are qualified.

### Alpha evidence record — 2026-08-28–29 (Asia/Kolkata)

This record distinguishes real-provider evidence from deterministic automated
coverage. It is not a Production approval.

Verified against the deployed Alpha Web and signed macOS Alpha application:

- Hosted AuthKit launched from both clients with distinct Web/Desktop
  applications and exact callbacks.
- Magic Auth rejected an invalid/stale code, accepted the current Zoho-delivered
  code, restored the resulting Personal organization, persisted across browser
  reload and a full desktop quit/relaunch, and logged out correctly.
- Desktop browser-sign-in cancellation and the ten-minute Zeros handoff expiry
  returned to a retryable signed-out state; late callbacks were refused.
- Google and GitHub completed provider authentication. Where a newly created
  WorkOS identity collided with preserved Zeros ownership, the client entered
  reviewed recovery instead of silently relinking by email.
- Web and Desktop registered different WorkOS session IDs. Device logout revoked
  only the initiating session; global logout revoked both, and an already-open
  browser consumed the security stream and signed out without reload.
- A real Alpha organization invitation opened the installed macOS application,
  prefilled the bounded join credential, accepted successfully, and appeared in
  the owner's member list. The exact merged-SHA link contained no scheme query;
  the page selected the Alpha application from its deployment origin. Removing
  the member updated the owner's open browser through SSE and the desktop kept
  its authenticated Personal account.
- The exact merged-SHA retest exposed a provider-lifecycle defect: WorkOS left
  the existing user's invitation-created membership `pending`, and the active
  membership command dead-lettered. The corrective convergence and cross-object
  event-ordering regressions are implemented; a live post-deployment retest is
  still a promotion gate.
- A later live email retest exposed a separate entry defect: WorkOS's native
  invitation authenticated successfully but returned to a callback without
  Zeros-created state. The callback correctly failed closed. The replacement
  design keeps WorkOS delivery, points its custom Invitation URL at the bounded
  Zeros landing, and resolves `invitation_token` server-side against the exact
  local authorization record. A post-deployment browser/Desktop retest remains
  a release gate; this historical failure is not relabeled as passing evidence.
- The deployed control-plane health endpoint, exact release version, Personal
  bootstrap, secure browser cookie relay, strict same-site completion, and
  session-revocation persistence were inspected after promotion.

Deterministic repository/emulator coverage additionally verifies JWT and client
binding, PKCE and wrong-verifier refusal, callback/deep-link validation,
concurrent refresh serialization, provider failures, WorkOS event
idempotency/reordering/repair, account-deletion projection, reviewed recovery,
organization/member/invite convergence, directory and last-owner safeguards,
tenant RLS, cloud create/wake denial, SSE replay, and stream-outage behavior.
The database-backed control-plane suite passes every forward migration path,
including the owner-only support-operator bootstrap and revocation path.

Still required before Alpha can be called fully qualified:

- Explicitly approved deletion of the disposable WorkOS test user while Web and
  Desktop are open, followed by recreated-identity recovery. The destructive
  provider deletion is intentionally not inferred from general test approval.
- Selection and owner-mediated bootstrap of a dedicated `support_admin`, then a
  live two-person recovery approval and immediate revocation of that temporary
  authority.
- A clean first-time and returning Google/GitHub identity-linking exercise for
  the same person; existing preserved identities currently exercise the safer
  recovery path instead.
- The corrective merged-SHA native invitation retest proving there is exactly
  one WorkOS email, browser and Desktop both accept its token, WorkOS reports
  the member `active`, provider invitation/pending-membership artifacts are
  retired after acceptance and removal, and no command dead-letters. A live WorkOS/security-
  stream interruption drill also remains; automated race/outage coverage is not
  relabeled as live evidence.
- Windows and Linux release qualification on those operating systems. macOS
  evidence and CI packaging do not qualify another platform.

MFA is currently disabled in the Alpha Hosted UI, so the conditional MFA item
is not applicable to this Alpha configuration. Radar remains disabled by the
explicit product decision above.

## Primary references

- [Hosted AuthKit](https://workos.com/docs/authkit/hosted-ui)
- [Modeling your app](https://workos.com/docs/authkit/modeling-your-app)
- [Authorization URL and PKCE](https://workos.com/docs/reference/authkit/authentication/get-authorization-url)
- [Email verification](https://workos.com/docs/authkit/email-verification)
- [Identity linking](https://workos.com/docs/authkit/identity-linking)
- [Applications](https://workos.com/docs/authkit/applications)
- [Invitations](https://workos.com/docs/authkit/invitations)
- [Invitation API](https://workos.com/docs/reference/authkit/invitation)
- [Custom emails](https://workos.com/docs/authkit/custom-emails)
- [Branding](https://workos.com/docs/authkit/branding)
- [Sessions](https://workos.com/docs/authkit/sessions)
- [Session resilience](https://workos.com/docs/authkit/session-resilience)
- [Events](https://workos.com/docs/events)
- [Organization memberships](https://workos.com/docs/reference/authkit/organization-membership)
- [Directory Sync](https://workos.com/docs/directory-sync)
- [Magic Auth](https://workos.com/docs/authkit/magic-auth)
- [Radar](https://workos.com/docs/authkit/radar)
- [Testing AuthKit](https://workos.com/docs/authkit/testing)
- [WorkOS Node SDK](https://github.com/workos/workos-node)
- [WorkOS changelog](https://workos.com/changelog)
