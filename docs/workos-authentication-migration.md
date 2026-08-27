# WorkOS Hosted AuthKit architecture and rollout

Status: repository implementation complete; dashboard configuration, channel
deployment, and real Alpha acceptance remain pending.

Retention: keep this document while Auth0 compatibility exists. After every
supported release uses WorkOS, move the durable contracts into the permanent
architecture and deployment guides, remove Auth0 code/configuration in a
separate rollout, then delete this migration document.

## Decision

Zeros uses [WorkOS Hosted AuthKit](https://workos.com/docs/authkit/hosted-ui) as
the only interactive authentication surface. Zeros does not render password,
one-time-code, email-verification, MFA, social-provider, or account-linking
forms. Hosted AuthKit owns those ceremonies, including verification, Radar/bot
protection, localization, and recovery.

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

WorkOS authenticates people. Zeros Postgres remains authoritative for product
accounts, Personal workspaces, organizations, teams, roles, invitations,
billing metadata, GitHub repository authorization, audit history, and future
cloud resources.

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
- `user.updated` refreshes bounded profile data. `user.deleted` soft-deletes
  the authentication row only. Neither event cascades into product data.
- The independent Zeros GitHub App remains the sole owner of repository
  authorization. WorkOS login must not request extra GitHub scopes or return
  provider access/refresh tokens.

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
3. Railway sets a `Secure`, `HttpOnly`, host-only `__Host-zeros_auth_flow`
   cookie and redirects to Hosted AuthKit with `provider=authkit`, S256 PKCE,
   the Web Application client ID, and the exact HTTPS callback.
4. Hosted AuthKit completes the entire login, verification, MFA, recovery, and
   linking ceremony before returning a code.
5. Railway atomically claims the ten-minute flow using both cookie and state,
   exchanges the code, requires a verified WorkOS user, authenticates the
   sealed session, and promotes the same row to a browser session.
6. Railway rotates to the `Secure`, `HttpOnly`, host-only
   `__Host-zeros_session` cookie and redirects only to the previously bounded
   relative return path.
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
4. Enable Hosted AuthKit and the intended authentication methods. Keep email
   verification enabled; configure MFA/recovery policy in Hosted AuthKit, not
   in Zeros code.
5. Configure Zeros-owned Google/GitHub OAuth credentials before Production.
   Provider tokens and extra provider scopes must remain disabled. Follow the
   WorkOS [GitHub OAuth setup](https://workos.com/docs/integrations/github-oauth)
   and equivalent provider guidance.
6. Install the exact JWT template required above. Reject any template that
   drops the boolean verified-email claim or changes audience.
7. Set and record Web/Desktop access-token and session durations. Review
   [Sessions](https://workos.com/docs/authkit/sessions) and
   [session resilience](https://workos.com/docs/authkit/session-resilience).
8. Create a webhook endpoint on the channel API origin at
   `/auth/workos-webhook`, subscribed only to `user.updated` and
   `user.deleted`. Store its signing secret only in Railway.
9. Apply branding, support/contact, legal, and localization settings. Keep the
   Zeros signed-out page a launch surface, not a second login UI.
10. For Production, evaluate an AuthKit custom domain as a branding and
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
- user profile update and deletion webhook idempotency/conflict handling;
- Pages contains no WorkOS secrets and response headers prevent auth callback
  caching/referrer leakage; and
- macOS smoke checks plus separately recorded Windows/Linux packaging checks
  before claiming those platforms are qualified.

## Primary references

- [Hosted AuthKit](https://workos.com/docs/authkit/hosted-ui)
- [Modeling your app](https://workos.com/docs/authkit/modeling-your-app)
- [Authorization URL and PKCE](https://workos.com/docs/reference/authkit/authentication/get-authorization-url)
- [Email verification](https://workos.com/docs/authkit/email-verification)
- [Identity linking](https://workos.com/docs/authkit/identity-linking)
- [Applications](https://workos.com/docs/authkit/applications)
- [Sessions](https://workos.com/docs/authkit/sessions)
- [Session resilience](https://workos.com/docs/authkit/session-resilience)
- [Testing AuthKit](https://workos.com/docs/authkit/testing)
- [WorkOS Node SDK](https://github.com/workos/workos-node)
- [WorkOS changelog](https://workos.com/changelog)
