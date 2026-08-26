# WorkOS authentication migration

Status: Phases 1, 2, and 3 repository implementation complete; not deployed.
The control plane, browser, and desktop repository can use either legacy Auth0
or the qualified WorkOS contract, but the running product still uses Auth0
until the coordinated Alpha reset and release gates in this document are
complete.

Retention: this is an active migration roadmap. Once Auth0 has been removed
from every release channel, fold the lasting contracts into the deployment and
architecture guides, then delete this file.

## Scope decision

This is a clean-slate identity cutover. Existing identity-provider users,
browser sessions, desktop sessions, and provider-subject bindings are not a
compatibility requirement. The operator may reset application identity data,
but only after selecting one exact deployment environment and taking a tested,
restorable backup. The repository must not contain an automatic broad database
wipe command.

Cloud workspaces remain deferred. This migration still establishes the stable
account and resource-server contracts they will consume later. It does not add
WorkOS Organizations, WorkOS authorization, or a cloud-workspace dependency.

## Current deployment inventory

| Surface                                      | Current authentication responsibility                                                                                                                       | Migration boundary                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Pages (`apps/web`)                | Starts Auth0 code+PKCE, exchanges codes, stores browser access/refresh tokens in Workers KV, proxies bearer requests, and brokers the desktop ticket.       | Becomes a stateless same-origin WorkOS facade. Railway performs exchange and session operations; Pages stops minting desktop credentials.        |
| Railway control plane (`apps/control-plane`) | Derives Auth0 issuer/JWKS settings, verifies access-token signature/issuer/audience, JIT-provisions the database user, and performs Postgres authorization. | Accepts explicit provider-neutral verification settings and owns WorkOS PKCE, sealed sessions, webhook verification, and management operations. |
| Railway Postgres                             | Owns `users.id`, `user_identities`, Personal/organization/team membership, invitations, GitHub state, feedback identity, and optional cloud rows.           | Also owns hashed browser credentials/state and serialized sealed-session refresh; migrations/schema remain the product authority.               |
| Electron main                                | Redeems the web ticket, keeps refresh material in `safeStorage`, refreshes through the web broker, and exposes only bounded session data to the renderer.   | Starts PKCE on the branded app host, receives the hosted callback through an exact-channel deep link, and keeps tokens/verifier out of renderer IPC. |
| Zeros engine                                 | Independently verifies Auth0 JWTs and uses the provider subject for owner/client comparisons and deferred cloud credential binding.                         | Pins the same WorkOS token contract; product/cloud ownership moves to internal account UUIDs or control-plane grants.                           |
| GitHub App flow                              | Separately authorizes repository access and binds its credential to the Auth0 subject.                                                                      | Remains separate from WorkOS social login and rebinds credential ownership to the internal account UUID.                                        |

The repository defines three isolated Cloudflare/Railway/Postgres channels and
guards their deployment variables. The initial Phase 0 repository audit had no
Railway, Cloudflare, Auth0, or WorkOS dashboard credentials in its cloud
workspace, so the deployment inventory below is from code/configuration only;
that audit did not query or change a live service. Later dashboard milestones
are recorded separately from the still-pending live contract observations.

Primary implementation traces inspected during the audit:

- web authorization and profile/session creation:
  `apps/web/functions/auth/{start,callback,logout}.ts`,
  `apps/web/lib/{oauth,session,control-plane-proxy}.ts`;
- desktop handoff, secure persistence, refresh, and logout:
  `apps/web/functions/handoff/*`,
  `apps/desktop/electron/ipc/commands/{auth-handoff,auth-session}.ts`;
- resource-server verification and JIT identity binding:
  `apps/control-plane/src/{auth,config}.ts` and
  `apps/control-plane/migrations/0001_init.sql`;
- engine admission and owner binding:
  `apps/desktop/src/engine/auth/verify-jwt.ts` and
  `apps/desktop/electron/sidecar.ts`; and
- GitHub, feedback, deployment, and cloud ownership call sites under
  `apps/control-plane/src/`, `apps/desktop/electron/`, `apps/web/`,
  `scripts/`, and `.github/workflows/`.

## Durable boundaries

- `users.id` is the Zeros account identifier. Product ownership, organization
  membership, billing, GitHub credentials, feedback contacts, audit data, and
  future cloud resources use this UUID, never a WorkOS `sub`.
- `user_identities(provider, provider_sub)` maps the WorkOS user to the internal
  account. A clean database creates this row just in time on the first verified
  request.
- A WorkOS `sub` may remain in verified session/authentication state so a token
  can be refreshed, revoked, or mapped. It is never the durable owner key of a
  Zeros product resource. Components that need the internal owner call
  `/v1/me` or consume a control-plane-minted grant after authentication.
- WorkOS performs authentication. Zeros Postgres remains authoritative for
  Personal, organizations, teams, roles, invitations, and row-level access.
- Railway is both the resource server and the server-side WorkOS broker. Normal
  `/v1` JWT verification remains local and does not require a WorkOS API key or
  network call; only explicit `/auth` exchange, refresh, logout, webhook, and
  management operations use the Railway-only provider credential.
- Railway/Postgres owns browser sessions. Cloudflare Pages is a stateless
  same-origin facade. Electron main owns the desktop public-client authorization
  flow and its PKCE verifier; neither the renderer nor desktop package receives
  a WorkOS API key.
- Web and desktop are different WorkOS Applications and must produce different
  WorkOS session IDs. Refreshing a web session is not a desktop sign-in.
- Rotating refresh tokens must not use eventually consistent Workers KV as
  their sole correctness store. If a server-mediated desktop fallback still
  needs one-time tickets, their consume operation must also be strongly
  consistent and atomic.
- Runtime configuration uses explicit issuer, JWKS, audience, and allowed
  client IDs. The control plane must not derive them from a vendor domain. This
  keeps the resource-server boundary suitable for a future Railway template.

### Account and credential lifecycle

Google and GitHub are credentials of one WorkOS User, not separate Zeros
accounts. WorkOS links credentials only after it can establish control of the
email address. Zeros therefore creates one `user_identities` row with
`provider='workos'` and the WorkOS User `sub`; it does not encode
`GoogleOAuth`/`GitHubOAuth` in the provider key or auto-link separate WorkOS
subjects merely because their email strings match.

Identity lookup is by verified subject. Email and profile changes may refresh
presentation/contact fields, subject to the existing case-insensitive email
uniqueness and collision rules. Deleting a WorkOS User does not cascade-delete
Zeros projects, organizations, audit history, or future cloud data. If a person
later appears with a new WorkOS subject but an email already owned in Zeros,
fail closed with an account-recovery path; do not silently transfer ownership
on email equality. Phase 1 implements that fail-closed collision behavior.

WorkOS publishes `user.updated` and `user.deleted` as server-side events. Phase
2 verifies their exact raw-body signature on Railway, reduces the payload to a
bounded lifecycle event, and records idempotent recovery status in Railway
Postgres. No event auto-links by email or cascade-deletes product data. A
distinct suspension event is not assumed without a qualified WorkOS contract.

References: <https://workos.com/docs/authkit/identity-linking> and
<https://workos.com/docs/events>

## Environment and application topology

Each Zeros channel receives an isolated WorkOS environment. Alpha and Beta may
use additional staging environments while they contain only test data;
Production uses a WorkOS production environment.

| Zeros channel | WorkOS environment  | Applications                             | API audience                    |
| ------------- | ------------------- | ---------------------------------------- | ------------------------------- |
| Alpha         | isolated staging    | `Zeros Web Alpha`, `Zeros Desktop Alpha` | `https://api-alpha.zeros.build` |
| Beta          | isolated staging    | `Zeros Web Beta`, `Zeros Desktop Beta`   | `https://api-beta.zeros.build`  |
| Production    | isolated production | `Zeros Web`, `Zeros Desktop`             | `https://api.zeros.build`       |

An environment's web application is the default application. Its issuer/JWKS
contract and both applications' `client_id` claims must be captured from real
tokens rather than inferred from documentation.

Staging environments are only for test data. Before Alpha or Beta admits real
external users, move that channel to its own production-class environment and
repeat every token and deployment gate. WorkOS supports additional staging and
production environments; if creation is not visible in the dashboard, the
operator must request it from WorkOS support rather than sharing a user/session
boundary between channels.

### Alpha dashboard setup

Phase 0 uses the existing Alpha origins and preserves the current Google/GitHub
sign-in surface:

| Setting                | `Zeros Web Alpha` (default)                                                             | `Zeros Desktop Alpha`                                           |
| ---------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Redirect URI           | `https://app-alpha.zeros.build/auth/callback` and `http://127.0.0.1:8788/auth/callback` | `https://app-alpha.zeros.build/auth/desktop/callback`            |
| Default sign-out URI   | `https://app-alpha.zeros.build/`                                                        | `https://app-alpha.zeros.build/`                                |
| Access-token duration  | 5 minutes                                                                               | 5 minutes                                                       |
| Maximum session length | 30 days                                                                                 | 90 days                                                        |
| Inactivity timeout     | 7 days                                                                                  | 30 days                                                        |
| Sign-in methods        | Google and GitHub only                                                                  | Google and GitHub only                                         |

The Desktop redirect is the HTTPS page users see on the Zeros app host. That
page immediately hands the short-lived, PKCE-bound authorization code to the
exact installed channel (`zeros-alpha://`, `zeros-beta://`, or `zeros://`). The
custom scheme is therefore an app handoff, not the redirect registered for new
WorkOS builds. Keep the legacy custom-scheme and wildcard loopback redirects
registered only until every older or qualification build that uses them has
been retired; do not select either for a new release.

The durations are the initial security/UX policy, not hidden code defaults.
Record the final dashboard values in the channel configuration inventory. Keep
WorkOS email verification enabled. Staging may use WorkOS's default Google and
GitHub credentials for contract testing; branded production login requires
Zeros-owned provider credentials in each production environment.

Do not enable “Return Google OAuth tokens,” “Return GitHub OAuth tokens,” or
extra provider scopes for authentication. Zeros's separate GitHub App flow
continues to own repository authorization; an identity login token must never
become a Git credential.

The web Application's API key and cookie password are server-only secrets. If
WorkOS requires the desktop Application's credential for session-management
calls, that credential also exists only in the server-side auth broker. The
desktop itself uses only its public client ID. The resource server uses only the
public verification values in the Railway table below. No API key, refresh
token, or cookie password is committed to Git or pasted into an issue/chat.

### Production domain decision

Zeros hosts every user-readable Zeros provider chooser and callback page on its
own `app*.zeros.build` origins. Railway names Google or GitHub directly, so the
browser only passes through WorkOS's standard authorization endpoint before
the selected provider; it does not render the WorkOS AuthKit chooser. The
operator has explicitly declined the optional paid custom-domain service; this
is not a release blocker in staging or production. WorkOS exposes two separate
custom choices if that decision changes later:

- an **AuthKit domain**, such as `auth.zeros.build`, changes the hosted sign-in
  UI hostname; and
- an **Authentication API domain**, such as `identity-api.zeros.build`, changes
  the hostname used by the SDK for Authentication API calls. If enabled, set
  the SDK's API hostname and recapture the exact issuer and JWKS contract from
  real tokens before release.

If custom domains are adopted later, use new hosts instead of immediately
reusing Auth0's `login.zeros.build`. Retaining the old DNS route keeps rollback
independent during the acceptance window. WorkOS requires these CNAME records
to be DNS-only, not proxied through Cloudflare. Repeat both token probes after
changing the Authentication API domain. WorkOS's standard production API
domains are valid and do not change the rest of this architecture.

References:

- <https://workos.com/docs/custom-domains>
- <https://workos.com/docs/custom-domains/authkit>
- <https://workos.com/docs/custom-domains/auth-api>

Official references:

- <https://workos.com/docs/authkit/environments>
- <https://workos.com/docs/authkit/applications>
- <https://workos.com/docs/authkit/sessions>

## Current-state audit findings

Phase 0 found the following Auth0-era behavior. None of it is silently accepted
as the WorkOS design:

| Severity | Finding                                                                                                                                                                                                                                                         | Required migration outcome                                                                                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | The web callback base64-decodes the Auth0 ID-token payload and uses its unverified profile/email claims to create the browser session. It does not verify the token signature, issuer, audience, or nonce.                                                      | Use the trusted `User` returned by the server-side WorkOS code exchange. Independently verify every bearer access token at the resource server.                                                                         |
| High     | Desktop mint calls the browser session's refresh grant. Under rotation, the returned refresh token replaces the browser token and is also placed in the desktop ticket; that is another token for the same provider session, not an independent device session. | Authenticate the desktop Application independently so web and desktop receive separate `sid` values and revocation boundaries.                                                                                          |
| High     | Browser session refresh, its best-effort lock, and desktop tickets live in Workers KV. KV can serve stale values for 60 seconds or more, while WorkOS documents a 30-second refresh-token replay grace period.                                                  | Use a WorkOS sealed session or strongly consistent coordinator for rotating browser state. Keep KV only for best-effort caching and abuse controls.                                                                     |
| High     | Desktop ticket redemption is a KV `get` followed by `delete`, so two requests can redeem the same ticket concurrently.                                                                                                                                          | Prefer direct desktop PKCE, which removes the ticket. Any fallback broker must use an atomic consume primitive such as a Durable Object.                                                                                |
| High     | Product ownership still leaks the Auth0 subject into desktop/engine owner checks, GitHub credential ownership, Intercom `external_id`, provider presentation, and deferred cloud credential hashes.                                                             | Resolve the verified WorkOS subject to `users.id` once, consume the UUID already returned by `/v1/me`, and use it for every product/integration owner. Provider subjects remain authentication bindings, not owner IDs. |
| Medium   | The operation named `auth_sign_out_everywhere` revokes one desktop refresh token and clears one local record. It does not enumerate or revoke the user's other sessions.                                                                                        | Make current-device and all-device logout separate operations; the latter lists and revokes every WorkOS session for the internal account's WorkOS identity.                                                            |
| Medium   | `/healthz` proves only database reachability, and no release check proves a real web or desktop token against the deployed issuer/JWKS/audience/client allowlist.                                                                                               | Keep health local, and add a secret-safe post-deploy synthetic authentication check per channel.                                                                                                                        |
| Medium   | The web package has route/host/proxy tests but no direct tests for OAuth start/callback, browser session rotation, handoff mint/redeem, or revoke.                                                                                                              | Add deterministic request-level tests before replacing each flow and retain negative/race cases as release gates.                                                                                                       |
| Medium   | The repository secret scanner recognized many vendor keys and `sk_live_` but had no explicit realistic-length rule for WorkOS staging/current keys.                                                                                                             | Closed in Phase 0 with an end-to-end scanner regression for `sk_test_...` and current `sk_...` forms. Auth SDK errors must still be scrubbed without logging request headers or sealed sessions.                        |

Cloudflare's consistency model and WorkOS's rotation behavior are documented at:

- <https://developers.cloudflare.com/kv/concepts/how-kv-works/>
- <https://workos.com/docs/authkit/session-resilience>

## Access-token contract

The control plane accepts only RS256 tokens that satisfy all of these checks:

- exact configured issuer;
- exact channel API audience;
- signature from the configured environment JWKS;
- unexpired `exp`, with `iat`, `sub`, `sid`, and `jti` present;
- `client_id` equal to that channel's web or desktop Application;
- `https://zeros.build/email` is a non-empty string; and
- `https://zeros.build/email_verified` is exactly `true`.

Profile strings are trimmed before use. The optional picture claim is retained
only when it is a bounded HTTPS URL without embedded credentials; an invalid
avatar is presentation loss, not an authentication failure.

### Why verified email is required, and where GitHub is adopted

The verified-email requirement is inherited from the Auth0 era and exists for
one reason: invitation acceptance binds an invite to the authenticated email as
its anti-takeover control (`apps/control-plane/src/routes.ts`). Because invite
links are deliberately shareable and acceptance runs in a system transaction
that bypasses row-level security, that email comparison is the only tenancy gate
on the accept path. A forgeable email would make it forgeable. A second, less
obvious reason: `users.email` is globally `UNIQUE`, so an unverified signup can
consume another person's address and lock them out of signup permanently.

WorkOS auto-verifies Magic Auth, Google OAuth, Apple OAuth and SSO, but **not
GitHub OAuth**. A GitHub user is therefore created with `email_verified: false`,
WorkOS refuses the first token exchange with `email_verification_required`, and
it emails a one-time code. Because Zeros drives WorkOS through its own UI rather
than AuthKit's hosted screens, no screen exists to collect that code, and the
verification grant (`urn:workos:oauth:grant-type:email-verification:code`) is
confidential-client only — the desktop public PKCE client cannot complete it.

Zeros resolves this by **adopting the provider's own verification**: the signed
`user.created` webhook marks a user created unverified as verified
(`adoptProviderVerifiedEmail`). This is a deliberate trust decision, not a
loophole:

- GitHub marks an address `Verified` only after the owner confirms it, so the
  assertion is equivalent in kind to the one WorkOS already trusts from Google.
- The predicate is safe *because* sign-in is restricted to Google and GitHub.
  Google users arrive already verified, so "unverified at creation" means
  GitHub. **Enabling password or Magic Auth sign-in would invalidate this and
  must be paired with a provider check**, otherwise a caller could self-assert
  an arbitrary address.
- Adoption happens through WorkOS's API on a signature-verified webhook. It is
  never driven by client input; an endpoint that marked caller-supplied
  addresses verified would be privilege escalation.
- Nothing downstream is relaxed. Every token still has to satisfy the full
  claim contract above, so the desktop retry can only succeed once WorkOS
  itself reports the address as verified.

The desktop retries the same authorization code once after a short delay
(`ADOPTION_RETRY_DELAY_MS`) to absorb the race between webhook delivery and the
code exchange. Losing that race costs one retry and then surfaces
`verification_required`; it never bypasses a check.

Prefer removing this adoption if WorkOS adds GitHub to its auto-verified
providers — GitHub already exposes `verified` through the granted `user:email`
scope.

The proposed WorkOS JWT Template is intentionally small:

```json
{
  "aud": "<exact channel API origin>",
  "https://zeros.build/email": {{ user.email }},
  "https://zeros.build/email_verified": {{ user.email_verified }},
  "https://zeros.build/name": "{{ user.first_name || '' }} {{ user.last_name || '' }}",
  "https://zeros.build/picture": {{ user.profile_picture_url }}
}
```

The WorkOS dashboard must validate and preview the final template. A real token
from both Applications must then pass the checked-in contract probe:

```bash
cd apps/control-plane

(
  read -r -s -p 'Fresh access token: ' AUTH_PROBE_ACCESS_TOKEN
  export AUTH_PROBE_ACCESS_TOKEN
  printf '\n'

  AUTH_PROBE_CLIENT_KIND='web' \
  AUTH_ISSUER='<exact iss claim, including trailing-slash behavior>' \
  AUTH_JWKS_URL='<exact environment JWKS URL>' \
  AUTH_AUDIENCE='https://api-alpha.zeros.build' \
  AUTH_WEB_CLIENT_ID='<alpha-web-client-id>' \
  AUTH_DESKTOP_CLIENT_ID='<alpha-desktop-client-id>' \
  pnpm auth:probe
)
```

Run the same command with a desktop token and
`AUTH_PROBE_CLIENT_KIND=desktop`. The probe prints only contract booleans and
expiry, never the token, subject, email, session ID, or client ID. Do not store
the token in a file, shell history, issue, chat, or CI log.

Official token references:

- <https://workos.com/docs/reference/authkit/session-tokens>
- <https://workos.com/docs/authkit/jwt-templates>
- <https://workos.com/docs/authkit/applications>

### Alpha live contract observation (2026-08-23)

Secret-safe qualification against the Alpha staging environment established
the following contract without recording tokens, identity fields, session IDs,
or full client IDs:

- The two supplied Application client IDs are distinct. Their public JWKS
  endpoints each returned one RS256 signing key with identical key material.
- Both the Web and independently authenticated Desktop access tokens passed
  `pnpm auth:probe` using the default Web Application's JWKS endpoint.
- The exact issuer for both Applications is
  `https://api.workos.com/user_management/<alpha-web-client-id>` with no
  trailing slash. The shared verification endpoint is
  `https://api.workos.com/sso/jwks/<alpha-web-client-id>`.
- Both tokens used the exact Alpha API audience and correct Application
  `client_id`, were signed with RS256, lived for 300 seconds, and contained
  non-empty `sub`, `sid`, and `jti` plus numeric `iat` and `exp`.
- The saved JWT Template rendered the namespaced email and verified-email
  claims, plus the optional name and picture claims. The trusted code-exchange
  User also reported a verified email. Neither flow returned Google or GitHub
  provider OAuth tokens.
- Desktop authorization and refresh succeeded as a public PKCE client without
  a Desktop API key. Web and Desktop produced separate sessions for the same
  WorkOS User. The Sessions API exposed 30-day Web and 90-day Desktop maximum
  session lengths.
- The Web Application's server credential listed both sessions, revoked the
  Desktop session, and then listed and revoked the remaining Web session. No
  Desktop credential was required. Refreshing the revoked Desktop session
  returned terminal `invalid_grant`; its already-issued access token continued
  to pass local cryptographic verification until expiry, as designed. The
  final active-session list was empty.
- The Desktop refresh returned a different refresh token and retained the same
  `sid`. The Web refresh returned the same refresh token; immediate reuse
  succeeded, and reuse after the documented 30-second grace window did not
  return `invalid_grant`. WorkOS's current primary references conflict here:
  Session Resilience describes rotation on every exchange, while Sessions and
  the emulator guide state that production may return the same token. Phase 1
  must therefore serialize refreshes and durably store every successful
  response even when the returned value is unchanged. Known transient failures
  preserve the existing session; terminal `invalid_grant` clears it.

References for the observed refresh-contract discrepancy:

- <https://workos.com/docs/authkit/session-resilience>
- <https://workos.com/docs/authkit/sessions>
- <https://workos.com/docs/cli/emulate>

Application redirects, default sign-out URIs, inactivity timeouts, and the JWT
Template source are Dashboard-only configuration and were not returned by the
public API. The successful loopback flows and real token claims qualify the
registered local redirects and rendered template, but the remaining
Dashboard-only values still require an operator check.

Operator screenshots on 2026-08-23 confirmed the Web Application's 30-day
maximum session length, 5-minute access-token duration, and 7-day inactivity
timeout, plus the Desktop Application's corresponding 90-day, 5-minute, and
30-day policy. Additional operator screenshots confirmed the configured Web
and Desktop default sign-out URI matches the Alpha application origin.

## Session architecture

### Browser

Use WorkOS authorization code plus PKCE. The code exchange's returned `User`
object is the trusted profile source; do not decode an unverified ID token.
Bind a cryptographically random `state`, PKCE verifier, and relative return path
inside short-lived server-side state; compare and consume it once at callback,
and never accept an arbitrary return origin. Represent the resulting session to
the browser with only a random `__Host-`-prefixed, `Secure`, `HttpOnly`,
`SameSite=Lax`, `Path=/` credential cookie. Keep rotating state in a WorkOS
sealed session under a strongly consistent server-side coordinator. Workers KV
may remain an abuse-rate-limit or cache layer, but not the authority for
refresh-token rotation. State-changing authenticated web routes retain explicit
same-origin/CSRF defenses; `SameSite` is defense in depth, not the only check.

### Desktop

Replace the browser-session mint with WorkOS's public-client authorization code
plus PKCE flow. Electron main generates and retains exact state plus the PKCE
verifier, then opens `${APP_ORIGIN}/auth/desktop`. That no-store Zeros page lets
the user choose Google or GitHub. Pages forwards only the allow-listed provider,
state, and S256 challenge to Railway; Railway creates a direct provider
authorization for the Desktop Application with the fixed registered HTTPS
redirect `${APP_ORIGIN}/auth/desktop/callback`.

After provider sign-in, the hosted callback strips its query from browser
history and opens the exact channel scheme with only the short-lived code and
state in the fragment. Electron main accepts it once, only for a pending exact
state, and exchanges the code with the Desktop Application's public client ID
and the verifier that never left main memory. It stores the new refresh token
in safe storage without exposing the code, verifier, access token, or refresh
token to renderer IPC. The callback is no-store, no-referrer, frame-denied, and
uses a per-response nonce CSP.

This flow creates an independent WorkOS desktop session, keeps every page a
user reads on the Zeros app host, and removes both the Cloudflare ticket/KV
consistency boundary and native loopback listener. Pages remains stateless and
holds no WorkOS key. Refreshing or copying the browser session is never a
fallback.

The stored desktop record evolves additively with internal account ID, WorkOS
session ID, and client kind. Existing persisted key names are not renamed merely
because identity data is disposable.

WorkOS may rotate a refresh token, and rotated tokens have a short replay grace
period. Persist every successful refresh response before another refresh even
when its token value is unchanged, serialize refreshes per session, retain
state on network, timeout, rate-limit, and supported server failures, and clear
state only on a terminal grant rejection.

Official native/public-client references:

- <https://workos.com/docs/reference/authkit/authentication/get-authorization-url>
- <https://github.com/workos/workos-node/blob/main/docs/V8_MIGRATION_GUIDE.md>

### Logout

Store the verified WorkOS `sid`. Browser logout clears the sealed cookie and
uses WorkOS's logout endpoint. Desktop current-device logout asks the
server-side auth broker to revoke the exact verified `sid`, then clears local
safe storage even if the network is unavailable. An explicit all-device
operation lists the user's active sessions and revokes each one through that
broker; revoking one refresh token must not be labelled “sign out everywhere.”

Local JWT verification cannot observe a session revocation until an already
issued access token expires. The five-minute access-token policy deliberately
bounds that replay window; cookie/local deletion ends the normal client session
immediately. A future operation that requires stronger immediate revocation or
step-up assurance must perform an explicit active-session/reauthentication
check instead of weakening ordinary requests with a WorkOS network dependency.

Alpha must prove that the web Application's server credential can list and
revoke sessions created by both Applications. If WorkOS scopes management calls
per Application, the broker must use the documented environment-wide
credential or both server-side credentials. Those credentials remain confined
to Railway's auth routes and are never required by ordinary resource requests.

Reference: <https://workos.com/docs/reference/authkit/session>

## Railway-template boundary

A future Railway template should deploy this same control plane and its
Postgres without embedding a Zeros-owned identity-provider secret. The person
installing the template supplies credentials for their own WorkOS environment;
the template may generate the cookie password. Public inputs are:

| Variable                 | Meaning                                      |
| ------------------------ | -------------------------------------------- |
| `AUTH_ISSUER`            | Exact trusted WorkOS issuer                  |
| `AUTH_JWKS_URL`          | Exact environment JWKS endpoint              |
| `AUTH_AUDIENCE`          | Public URL/identifier for this control plane |
| `AUTH_WEB_CLIENT_ID`     | Allowed web Application client ID            |
| `AUTH_DESKTOP_CLIENT_ID` | Allowed desktop Application client ID        |

`DATABASE_URL` remains a Railway reference to the template-owned Postgres.
`APP_ORIGIN` identifies the template owner's web origin. `WORKOS_API_KEY` and
`WORKOS_WEBHOOK_SECRET` are installer-supplied Railway secrets, while
`WORKOS_COOKIE_PASSWORD` is a unique generated 32-byte-or-longer Railway
secret. Template variables require descriptions; secrets are sealed or
generated; service-to-database traffic uses private references. A custom WorkOS
domain is optional—the standard WorkOS authorization endpoint is sufficient. A
template may use platform-provided HTTPS domains for both frontend and API, so
buying a custom domain is not a prerequisite. Those must remain separate
origins; two services in one Railway project can each use a generated Railway
domain.
The template sets `ZEROS_SELF_HOSTED=true`; official Zeros deployments leave
that variable unset so their exact channel, branch, audience, and app-origin
assertions remain fail-closed.

`/healthz` remains a local liveness/readiness check and must not depend on a live
WorkOS request. A post-deploy synthetic login/token request proves the external
authentication contract.

The hosted Alpha/Beta/Production audience contract is not, by itself, a safe
multi-instance self-hosting contract. A template must never accept a generic
Zeros access token and JIT-provision every valid WorkOS user: the same bearer
could then be replayed to every customer-owned instance. Before a public
template ships, add a separate instance-authorization layer with these
properties:

- each deployment generates a non-secret instance ID and a secret one-time
  bootstrap/pairing credential;
- an unclaimed deployment is deny-by-default and has no “first caller wins”
  path;
- claiming records the centrally resolved Zeros internal account UUID as the
  bootstrap owner, and later users require explicit membership/invitation;
- the client obtains a short-lived, signed grant bound to account UUID,
  instance ID, purpose, `jti`, and expiry; the template verifies a public key
  and exact instance audience, not a Zeros-owned WorkOS API key; and
- pairing, owner recovery, grant revocation, key rotation, and instance deletion
  receive their own threat model and release tests.

That grant can be introduced behind the provider-neutral principal boundary
without changing product ownership keys. Designing and shipping the public
template is deferred; Phase 0 deliberately records this gate so the current
hosted JWT audience is not later mistaken for customer-instance isolation.

Railway references:

- <https://docs.railway.com/templates/best-practices>
- <https://docs.railway.com/variables>
- <https://docs.railway.com/deployments/healthchecks>

## Estimated migration effort

The clean-slate decision removes user import, account pre-linking, dual-provider
verification, legacy-session adoption, and a zero-downtime user transition. It
does not remove the work needed to make web and desktop sessions correct.

| Workstream                                                    | Engineering effort                    | Main uncertainty                                                               |
| ------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| Phase 0 contract/account qualification                        | 1–2 days; repository portion complete | Real token shape, cross-Application session management, Alpha dashboard access |
| Provider-neutral control plane and identity ownership         | 2–4 days                              | Replacing provider-subject ownership without breaking GitHub/feedback paths    |
| Railway web login and sealed Postgres session                 | 3–5 days                              | SDK compatibility and multi-replica refresh race tests                         |
| Electron public-client hosted-callback login                  | 4–7 days                              | App lifecycle, deep-link/state races, secure persistence, logout/revocation    |
| Alpha reset, deployment, synthetic checks, and failure drills | 2–4 days plus 3–7 elapsed soak days   | External OAuth-provider configuration and real failure behavior                |
| Beta/Production promotion and Auth0 removal                   | 2–4 days plus channel soak            | Environment drift, production credentials, rollback rehearsal                  |

Expected total: **14–26 focused engineer-days**, normally **3–5 calendar weeks
for one senior engineer plus review**, followed by the chosen production soak.
The deferred cloud-workspace implementation is excluded; only its stable
internal-account boundary is included. The estimate moves down if the WorkOS
Node SDK and cross-Application revocation pass unchanged, and up if either
requires further provider-specific session coordination.

The future public Railway template's bootstrap and instance-bound grant system
is also excluded from the migration estimate. Its seam is defined above, but it
must be estimated and security-reviewed as a separate deliverable before the
template is offered to users.

## Clean reset and rollback

Before resetting one channel:

1. Resolve and record its exact Railway environment and database service.
2. Prove the other two `DATABASE_URL` values are different without printing
   credentials.
3. Take a volume/PITR backup and a portable logical dump, then perform a restore
   drill.
4. Record row counts for users, identities, organizations, memberships, teams,
   invitations, GitHub authorization data, feedback links, and cloud-workspace
   records.
5. Prefer provisioning a fresh channel database and running all migrations. If
   an in-place reset is necessary, review the exact foreign-key closure first;
   never improvise a partial user-table delete.
6. Switch Alpha first. Beta and Production remain unchanged until the prior
   channel passes its gates.

A Railway deployment rollback restores application image/configuration, not a
database reset. Keep the pre-reset database available until the channel is
accepted. Do not automatically delete WorkOS users during an application
rollback.

Railway reset/rollback references:

- <https://docs.railway.com/environments>
- <https://docs.railway.com/guides/postgres-backups-restores>
- <https://docs.railway.com/deployments/deployment-actions>

## Phase 0 gates

Completed in the repository:

- Current Auth0 call sites, persistent subjects, web/desktop handoff, engine
  verifier, environment guards, and deployment topology inventoried.
- Clean-slate migration and deferred cloud-workspace scope recorded.
- Internal UUID retained as the durable account boundary.
- Three-environment/two-Application topology selected.
- Provider-neutral Railway resource-server inputs selected.
- Checked-in token contract and safe live-token probe added.
- WorkOS API-key shapes added to the tracked-file secret scanner with an
  end-to-end regression test.

Dashboard milestones reported complete by the Alpha operator:

- Distinct `Zeros Web Alpha` and `Zeros Desktop Alpha` Applications exist in
  the Alpha staging environment.
- WorkOS's Google and GitHub demo credentials are enabled.
- Returning Google/GitHub OAuth tokens and additional provider scopes are
  disabled.
- The Alpha JWT Template validated and was saved with the exact Alpha audience.
- The hosted and local Web callbacks are registered.
- The legacy desktop custom-scheme redirect `zeros-alpha://auth/callback` and
  wildcard loopback redirect `http://127.0.0.1:*/auth/callback` were registered
  for the original qualification build.
- The Web Application session policy is 30 days maximum, 5 minutes per access
  token, and 7 days of inactivity.
- The Desktop Application session policy is 90 days maximum, 5 minutes per
  access token, and 30 days of inactivity.
- Both Applications use the Alpha application origin as their default sign-out
  URI.
- WorkOS standard API domains were selected; a paid custom domain is not
  required.

Phase 4 operator action: add
`https://app-alpha.zeros.build/auth/desktop/callback` to `Zeros Desktop Alpha`
before enabling the hosted-callback desktop build. Retain the two legacy
redirects only through the rollback window.

Completed live against Alpha staging:

- The supplied client IDs are distinct, and both public JWKS endpoints expose
  the same RS256 signing key.
- Real Web and independent Desktop tokens pass `pnpm auth:probe` with the exact
  issuer, shared JWKS, audience, and per-Application client claim.
- The JWT Template renders every required claim and both optional profile
  claims for the test identity.
- Desktop public-client PKCE, per-Application access/session lifetimes, distinct
  session IDs, refresh, terminal revocation, cross-Application management, and
  all-device revocation are qualified as described above.
- Transient refresh classification is qualified from WorkOS's current Session
  Resilience guidance. A live ambiguous timeout was deliberately not induced;
  deterministic network, timeout, `429`, and supported `5xx` tests are in the
  Phase 2 browser implementation. Phase 3 adds the corresponding desktop
  network/terminal/rotation state machine and safe-storage clearing. Both
  clients clear local state even when remote logout is unavailable.

Deferred operator actions required before the first Alpha deployment:

- Rotate the Alpha Web API key used during qualification, because it left the
  approved secret-injection path, then store the replacement only in the
  secret/configuration system and verify that a fresh workspace receives it.
  The operator deferred this rotation on 2026-08-23; the exposed credential
  must not be used for further qualification or deployment while this blocker
  remains.
- Record the exact issuer, JWKS URL, both Application IDs, and final session
  policies in the channel's secret/configuration inventory, not in Git, before
  deploying the Phase 1 integration.

With those operator actions explicitly deferred, Phase 0 discovery and live
contract qualification are complete. Phase 1 repository implementation was
unblocked to begin, but an Alpha deployment remains blocked until both actions
are closed.

## Phase 1 control-plane implementation

Implemented in the repository:

- `AUTH_PROVIDER` selects legacy `auth0` or `workos`. WorkOS mode requires an
  exact issuer, JWKS URL, audience, and distinct Web/Desktop Application IDs;
  it does not derive vendor URLs and does not accept a WorkOS API key.
- The Railway middleware verifies RS256 signature, exact issuer and audience,
  expiry, issued-at time, provider subject, session ID, token ID, allowed
  Application ID, and the saved namespaced verified-email JWT Template.
- A verified WorkOS subject binds to `user_identities(provider='workos',
provider_sub=...)`; `users.id` remains the canonical account and integration
  owner. `/v1/me` never exposes the provider binding.
- A new subject whose verified email is already owned fails with
  `account_exists`; Phase 1 never auto-links or transfers an account by email.
- Feedback identity now uses the internal account UUID. GitHub authorization
  rows already use that UUID. The deferred cloud v1 credential wire field
  `ownerSubjectSha256` intentionally retains its provider-subject meaning until
  a separately versioned cloud protocol migration.
- The clean-cutover reset command is a read-only plan by default, binds an
  explicit Alpha/Beta approval to a non-secret database fingerprint, requires
  backup confirmation, resets the whole `public` schema, replays migrations,
  and refuses Production. A fresh database remains the preferred path.

No live deployment or database reset is part of Phase 1 repository work. Alpha
deployment remains blocked on rotating the exposed qualification key and
recording the final public verification configuration. The deployed browser and
desktop still produce Auth0 credentials until the coordinated cutover.

## Phase 2 browser implementation

Implemented in the repository:

- `AUTH_PROVIDER` selects the legacy Auth0/KV browser path or WorkOS. Hosted
  Pages builds require an explicit selector and exact channel origins; WorkOS
  mode rejects retired Durable Object bindings/markers and any provider key,
  cookie password, signing secret, or client contract copied into Pages.
- The existing Railway control plane owns WorkOS independently for Alpha,
  Beta, and Production. Channel-local Postgres stores only SHA-256 digests of
  opaque browser credentials and OAuth state, plus the server-side PKCE
  verifier and WorkOS-encrypted sealed session. Access tokens are not database
  columns, and no WorkOS secret enters Pages or browser JavaScript.
- The browser receives only random 256-bit `__Host-zeros_auth_flow` and
  `__Host-zeros_session` cookies with `Secure`, `HttpOnly`, `SameSite=Lax`, and
  `Path=/`. Authorization state is exact, expires after ten minutes, and is
  claimed atomically once. Return destinations are stored as relative paths and
  revalidated against the exact application origin.
- The callback uses the trusted WorkOS code-exchange User and accepts only an
  explicitly verified email. Access tokens and sealed sessions are validated
  server-side before the session becomes active; none enter browser JavaScript.
- Near-expiry reads serialize refresh under PostgreSQL advisory/row locks and persist every
  successful rotation. Pre-rotation timeout, network, rate-limit, and supported
  server failures preserve the exact record. If rotation succeeds but a later
  local JWT verification is transiently unavailable, the replacement seal is
  persisted while the bearer is withheld. Terminal grant rejection deletes the
  database session.
- The dashboard proxy reuses the exact verified session snapshot, rejects a
  transient auth state with 503, refreshes once after an upstream 401, and
  releases unread response bodies before replay. WorkOS logout deletes local
  durable state before constructing the provider logout URL and always clears
  the browser cookie.
- The Auth0 desktop mint/redeem/refresh/revoke endpoints return
  `desktop_auth_migration_pending` in WorkOS mode. The signed-in browser never
  copies or refreshes its WorkOS credentials into a desktop ticket; Phase 3
  supplies the independent Desktop Application flow.
- `POST /auth/workos-webhook` verifies the exact raw payload with the
  channel-specific endpoint secret, accepts only `user.updated` and
  `user.deleted`, directly on Railway. Migration `0011` provides an
  RLS-protected idempotency/recovery ledger.
  Updates never transfer an occupied email; deletions soft-delete authentication
  while preserving organizations, memberships, audit history, and product data.
- Migration `0012` provides the RLS-protected browser flow/session table. The
  deployment runbook defines per-channel Railway, Postgres, Pages, and webhook
  boundaries. The standard WorkOS authorization endpoint remains selected; a
  paid custom WorkOS domain is not required and no AuthKit chooser is rendered.

The Phase 2 code is verified locally but not deployed or activated. The exposed
Alpha qualification API key must be rotated before it enters Railway. Because
Railway deliberately accepts one issuer at a time, browser activation waits for
the coordinated Phase 4 Alpha reset.

## Phase 3 desktop implementation

Implemented in the repository:

- Electron main generates 256-bit authorization state and a PKCE S256 verifier,
  keeps the verifier in main memory, and opens the channel's own app host. The
  hosted page offers direct Google/GitHub choices, then its fixed WorkOS
  callback hands only the short-lived code and state to the exact-channel deep
  link. State mismatch, cross-channel callback, replay, timeout, cancellation,
  provider error, and invalid callback inputs fail closed. No authorization
  code, state, verifier, or refresh token crosses renderer IPC.
- Cloudflare Pages validates and forwards only bounded provider/state/challenge
  inputs to Railway. It holds no WorkOS secret. The callback never server-renders
  the code, removes it from browser history before launching the app, disables
  storage/referrers/framing, and keeps a route-specific nonce CSP through global
  host middleware.
- The Desktop Application authenticates directly against WorkOS as a public
  client using only its public client ID. It never receives or embeds a WorkOS
  API key and never copies the browser Application's session. The returned
  bearer is verified against RS256, exact issuer, JWKS, channel audience,
  desktop `client_id`, session/token/time claims, and the namespaced verified
  email contract before installation.
- The independently authenticated bearer resolves `/v1/me` once, and the
  durable desktop record additively stores the internal Zeros account UUID,
  WorkOS session ID, desktop client kind, and authentication method. GitHub
  integration ownership now uses that internal UUID in WorkOS mode while
  Auth0-era records remain readable under the existing encrypted storage key.
- Access and refresh tokens remain together in Electron `safeStorage` and are
  never renderer-installable. Near-expiry refreshes are single-flight in one
  process, serialized across shared development worktrees, and committed with
  compare-and-swap. Network, timeout, `429`, and supported `5xx` failures retry
  the same refresh token with bounded exponential backoff inside WorkOS's
  replay grace. Every successful response is persisted, including an unchanged
  refresh token. A replacement returned before a transient local verification
  failure is retained while its bearer is withheld; only an explicit
  `invalid_grant` clears the stored session.
- A Railway revocation route verifies the desktop bearer before trusting `sub`
  or `sid`; new desktops call it directly and Pages retains a stateless
  compatibility pass-through for already-released builds. Current-device logout revokes that
  exact session. All-device logout paginates the WorkOS User's active sessions
  across both Applications and revokes each through the server-only Web API
  key. Local encrypted state clears even when that network operation is
  unavailable. A session minted but abandoned by cancellation, account lookup,
  or keychain failure is also best-effort revoked.
- The local engine consumes the same selected public verification contract and
  additionally pins the exact desktop client and required Zeros access-token
  claims. WorkOS management-key environment variables are stripped before the
  engine starts. Product-facing GitHub ownership uses the internal account UUID;
  provider-subject engine/cloud protocol fields remain the documented deferred
  compatibility boundary.
- Alpha/Beta/Production release jobs require an explicit provider. WorkOS mode
  bakes only the public Desktop Application ID, exact issuer/JWKS/audience, and
  rejects any channel-qualified WorkOS API-key variable from the desktop build.
  Auth0 remains selectable for rollback until Phase 5.

The Phase 3 code is locally verified but not activated. A packaged macOS
interactive login/keychain/logout drill is a Phase 4 Alpha acceptance gate and
cannot be claimed from this Linux repository environment. The exposed Alpha
server API key must still be rotated before Railway WorkOS mode is activated.

## Delivery phases after Phase 0

1. Provider-neutral account principal, WorkOS JWT verifier, internal account
   bindings, and clean database reset tooling/runbook. **Repository complete.**
2. WorkOS browser login, sealed/strong session state, proxy refresh, logout,
   and authenticated account-lifecycle ingestion. **Repository complete; not
   activated.**
3. Independent desktop public-client/hosted-callback flow, safe-storage refresh,
   and session revocation; use an atomic ticket only if the documented fallback
   is proven necessary. **Repository complete; not activated.**
4. Alpha reset and qualification, then exact-SHA Beta and Production promotion.
5. Remove Auth0 code, variables, callbacks, docs, privacy references, tests, and
   credentials; run every release, license, security, and platform gate.
