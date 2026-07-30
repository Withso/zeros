# GitHub Auth Mechanics — The Rules We Must Design Within

*Part 03 of the Zeros GitHub Integration Report · July 2026*

This is the reference an engineer implements the three-method picker from without re-opening
GitHub's docs. Everything here is either a quoted GitHub rule, a `path:line` fact about the
Zeros repo, or an explicitly-flagged gap. External claims are tagged **verified** (primary
source, re-checked by an independent fact-checker), **likely** (strong but single-source), or
**unverified** (stated, never confirmed). Where a fact-checker tightened a claim, the tightened
version is what appears below.

## The short version

- **GitHub App vs OAuth App is a choice of *registration*, and a GitHub App gives you two
  credentials, not one.** An *installation access token* (server-to-server, 1 hour, per-repo
  scopable, acts as the app's bot) and a *user access token* (user-to-server, 8 hours + a
  6-month refresh token, acts as the human). A desktop coding agent needs both.
- **`client_secret` is still `Required` on `POST /login/oauth/access_token`, even with PKCE.**
  GitHub added PKCE on 2025-07-14 (S256 only, optional) but staff state flatly: "we don't have
  a 'public client' concept yet… all of them require access to the client secret." Device flow
  is the *only* secret-free GitHub flow. That single sentence is why a backend is unavoidable.
- **1 hour is not configurable and 8 hours is a promise you must keep.** A 6-hour agent run
  outlives an installation token five times over; the refresh token is *single-use with no
  grace period*, so it must be durably persisted before the old pair is discarded.
- **The 2026 installation-token format change already breaks Zeros' log redaction.** New
  tokens are `ghs_APPID_JWT`, ~520 variable-length chars containing dots. Zeros'
  `(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}` rule at `packages/core/src/scrub.ts:81` matches
  **nothing** on that shape, and the JWT rule at `:75` also misses because of a `\b` after an
  underscore. Verified by executing both regexes. Conductor shipped the same fix in 0.76.1.
- **403 means at least six things and 404 usually means "your token can't see this."** Zeros'
  `isAuthError()` (`src/engine/git/github.ts:390`) returns true for 401 **or** 403 and both
  callers then delete the credential. Per-repo installation scoping *generates* 403s and 404s
  by design, so shipping the App on today's classifier signs users out constantly.
- **SAML SSO fails three different ways: 403 with `X-GitHub-SSO`, a bare 404, and a 200 with
  silently missing organizations.** The third is the user-hostile one — a successful response
  that omits the user's work org, which Zeros' owner picker would cache as truth.
- **A fine-grained PAT cannot read the Checks API at all.** Zeros' `getPrChecks`
  (`src/engine/git/github.ts:1341`) is permanently broken for that credential — 39 endpoint
  categories in GitHub's fine-grained allow-list, no `checks`. "Connected" must therefore be
  per-capability, not one green tick.
- **`x-access-token` is a convention GitHub ignores** (but it must be non-empty). `Contents:
  read` fetches, `Contents: write` pushes, and **`Workflows: write` is required for any push
  touching `.github/workflows/`** — a coding agent will hit this.
- **Loopback with an ephemeral port is legal on GitHub**, contrary to a widely-quoted reading
  of its docs: the port-exact-match rule applies to non-loopback URIs. But PKCE does *not*
  defend loopback against a local malicious process, and macOS gives `zeros://` no arbitration
  at all — so neither redirect option is a security boundary, and the code exchange must
  happen server-side regardless.
- **Two of the six permissions Zeros will need are missing from the spec's App permission
  table** (`Issues` for PR comments, `Administration` for "Publish to GitHub"). Both are
  flagged for part 10 rather than quietly assumed.

---

## 1. Five credential types, one text field today

Zeros currently has exactly one durable auth artefact: a bare token string in Electron
safeStorage under account `github_oauth`, wired at `electron/main.ts:1116-1131`. Any of the
five credentials below can be pasted or adopted into it, and nothing records which one it is.
That is the root defect the three-method picker exists to fix.

| | GitHub App **installation** token | GitHub App **user** token | OAuth App token | Classic PAT | Fine-grained PAT |
|---|---|---|---|---|---|
| Prefix | `ghs_` | `ghu_` (refresh `ghr_`) | `gho_` | `ghp_` **unverified** | `github_pat_` **unverified** |
| Minted by | app private key (JWT) → REST | browser/device flow + `client_secret` | browser/device flow | human, in the web UI | human, in the web UI |
| Lifetime | **1 hour**, not configurable | **8 h**, refresh **6 mo** | none by default | 1–366 days or none | 1–366 days or none |
| Per-repo scoping | ✓ installation grant, further narrowable at mint | installation grant ∩ user access | ✗ | ✗ (all repos in all your orgs) | ✓ single owner only |
| Permission model | app permissions, down-scopable per mint | intersection: app ∩ user | classic scopes | classic scopes | granular permissions |
| Acts as | the app's bot (`<slug>[bot]`) | **the human** | the human | the human | the human |
| Git-over-HTTPS | ✓ | ✓ | ✓ | ✓ | ✓ |
| Primary rate limit | 5,000/hr **scaling to 12,500** (15,000 GHEC) | 5,000/hr **shared** with every other app acting for that user | 5,000/hr shared | 5,000/hr | 5,000/hr |
| Needs a client secret | private key instead | ✓ (unless device flow) | ✓ (unless device flow) | ✗ | ✗ |
| Zeros can hold it on the Mac | **never** | yes (safeStorage) | yes (today's path) | yes | yes |

Sources: [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
[user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens),
[App vs OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps),
[PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens),
[rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). All **verified**
except the two prefix cells: `gho_`/`ghu_`/`ghr_`/`ghs_` are each attested in GitHub docs quoted
in our evidence base, but `ghp_` and `github_pat_` were not re-checked in this pass, and the
`Ov23li…` (OAuth) vs `Iv1.`/`Iv23li…` (App) *client-id* prefix convention is **unverified with
conflicting sources** — do not sniff prefixes to infer credential type. The whole point of
persisting `authMethod` is that the credential shape is not a reliable discriminator.

### The distinction that trips people

"GitHub App" and "OAuth App" are two kinds of *registration*. The registration decides which
token types exist:

- An **OAuth App** produces exactly one thing: a user token carrying classic scopes. It is
  authorized, never installed. Its token "identifies the app as the user who granted the
  token, such as @octocat" (**verified**).
- A **GitHub App** is *installed* on an enterprise, organization, or user account, and at
  install time the installer selects which repositories it may touch. It can additionally be
  *user-authorized*. So: "GitHub Apps must be installed, and can additionally be
  user-authorized" — a desktop coding agent typically needs both legs (**verified**, corrected
  from a looser original phrasing).
- Attribution is **per token type, not per app type**. An installation token's requests "are
  attributed to the app" and appear as the bot; a user token's requests are attributed to the
  user, with the app's identicon badge beside the avatar (**verified**).
- An installation grants repository access; an *authorization* grants nothing by itself. "An
  app does not need to be installed in order for a user to authorize the app" (**verified**),
  which produces the state Zeros must render distinctly: **connected but installed nowhere** —
  a successful sign-in with zero visible repositories.
- Since the [2025-07-01 enterprise-level access release](https://github.blog/changelog/2025-07-01-enterprise-level-access-for-github-apps-and-installation-automation-apis/),
  install targets are enterprise / organization / user, and the repository-selection step
  applies only to org and user installs: apps installed on an enterprise "can only manage the
  enterprise itself, and are not granted organization or repository permissions"
  (**verified**). Enterprise installations also **cannot subscribe to webhooks at all**.

Zeros today is on the weakest rung of this ladder: a classic OAuth App, client id
`Ov23lityKSllg4mxOQCl` baked in at `src/engine/git/github.ts:90`, requesting
`["repo","read:org"]` at `src/engine/git/github.ts:319`. `repo` is full read/write on every
repository in every organization the user can reach. The comment block at
`src/engine/git/github.ts:62-90` correctly explains why the baked-in *client id* is safe —
it is an identifier, and RFC 8252 §8.5 says statically-distributed secrets "should not be
treated as confidential secrets" (**verified**). That reasoning survives the redesign intact
and should be preserved verbatim.

---

## 2. Installation access tokens — the cloud-workspace primitive

This is the only credential type in GitHub that a *server* can mint, narrow to one repository,
narrow to one permission, and hand to a machine with no human present. Everything in the cloud
half of the design rests on it.

### 2.1 Minting

Two steps, both **verified**:

1. Build an **RS256 JWT** signed with the App's private key. Claims: `iat`, `exp` (maximum
   **10 minutes** in the future), `iss` = the App's **client ID** *or* application ID — either
   is accepted, client ID is *recommended* (added in the 2024-05-01 changelog; app ID is not
   deprecated). Source: [generating a JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app).
2. `POST /app/installations/{installation_id}/access_tokens` with that JWT as the bearer.
   "The installation access token will expire after 1 hour." The REST reference restates it:
   "Installation tokens expire one hour from the time you create them."

The 1-hour lifetime is not configurable. A widely-repeated claim that "GitHub has declined to
make it configurable" was **refuted** in our verification pass as unsupported by its citation —
the honest statement is that no configuration knob is documented, not that GitHub has ruled one
out. Design as though it is fixed at 1 hour; do not tell customers GitHub refused.

Because the private key is required, **the desktop binary and the sandbox can never mint**.
That is a hard architectural boundary, not a preference.

### 2.2 Down-scoping at mint time — the exact rules

| Body param | Rule |
|---|---|
| `repositories` | repository **names**. Up to **500**. |
| `repository_ids` | repository **IDs**. Up to **500**. |
| — | `repositories` and `repository_ids` are **mutually exclusive** — send one, never both. |
| `permissions` | a subset of the app's granted permissions |
| all three | **never wider than the installation grant**: a minted token "cannot be granted permissions that the app was not granted" and "cannot be granted access to repositories that the installation was not granted access to" |
| omitted | you get everything the installation was granted |

All **verified**. Two operational caveats that matter and are easy to miss:

- **500 is an upper bound, not a guarantee.** When you scope `permissions` *and* the app is
  installed on a subset of an org's repos, GitHub applies a token "complexity" limit and can
  reject with `Too many repositories for installation` — the error reports the real maximum —
  at a count well below 500. Mitigations: request fewer permissions, request fewer repos,
  install org-wide, or request an unscoped token (**verified**).
- A [2026-05-15 changelog](https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/)
  adds a per-request installation-token override header. We read the headline, not the body
  (**unverified**) — read it in full before finalising the mint path; it may simplify
  multi-installation handling.

For Zeros' cloud sandboxes this yields exactly the credential the founder's brief demands:
`repository_ids: [R]`, `permissions: { contents: "write", workflows: "write" }`, 1 hour. A
fully-compromised rented VM cannot reach another repository or open a PR. That is strictly
impossible with a PAT or a `gh` token, and it is the strongest single argument for making the
App the recommended method.

Vercel — the compute provider Conductor uses — independently reaches the same conclusion:
its [private-repo sandbox guide](https://vercel.com/kb/guide/sandbox-private-github-repositories)
documents three token types and **recommends GitHub App installation tokens for multi-tenant
platforms** (citing the 1-hour lifetime, installation scoping and higher rate limits) and
fine-grained PATs for individuals, via
`Sandbox.create({ source: { type: 'git', url, username: 'x-access-token', password: TOKEN } })`.
`Contents: Read` alone suffices for the App path; the fine-grained-PAT path additionally needs
`Metadata: Read` (**verified**). Vercel documents nothing about whether the token persists in
the sandbox's git remote for later pushes — verify empirically before relying on push-back.

### 2.3 The new stateless format — and the bug it already causes in Zeros

Per the [2026-04-24 changelog](https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/),
GitHub began a staged rollout on **2026-04-27** (completing late June 2026) changing newly-minted
installation tokens from a ~40-character opaque string to a **stateless `ghs_APPID_JWT` form of
roughly 520 characters, variable length, containing dots**. The `ghs_` prefix is retained; the
embedded JWT is signed by a GitHub-internal issuer and **must not be validated by clients**.
Lifetime, endpoint and minting flow are unchanged. The change applies to GitHub Enterprise Cloud
and Data Residency; **GHES is unaffected**. A [2026-05-15 changelog](https://github.blog/changelog/2026-05-15-github-app-installation-tokens-per-request-override-header/)
adds a temporary `X-GitHub-Stateless-S2S-Token: enabled|disabled` request header on the
access-tokens POST so you can force either format and test both. All **verified**.

The implementation rule is blunt: **treat the token as opaque, size every field for ≥600
characters, and delete every length or character-class assumption.**

Zeros already fails this in the one place that matters most. `packages/core/src/scrub.ts` is the
repo's log/telemetry redactor. Two of its rules are supposed to catch GitHub tokens:

```
:75   /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g   → "[jwt]"
:81   /\b(?:sk-…|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}|…)\b/g          → "[api-key]"
```

I executed both against a plausible new-format token (`ghs_1234567_eyJhbGciOiJSUzI1NiJ9.<~400
chars>.<60 chars>`) and against an old-format one:

| Token shape | `:81` api-key rule | `:75` JWT rule |
|---|---|---|
| `ghs_` + 36 alphanumerics (old) | ✅ redacted | not applicable |
| `ghs_APPID_JWT` (new) | ❌ **no match** | ❌ **no match** |

Two independent reasons, both mechanical. The `:81` character class `[A-Za-z0-9]` excludes `_`,
`-` and `.`, so matching stops at the underscore after the app id — fewer than the required 16
characters, so the alternative fails outright. And `:75` requires a word boundary before `eyJ`,
but the preceding character is `_`, which is itself a word character, so there is no boundary and
no match. **A new-format installation token appearing in any error message, stack trace or
telemetry payload is logged verbatim today.**

This is not hypothetical: Conductor hit it and shipped the fix. The "New in 0.76.1" addendum on
their [0.76.0 changelog page](https://www.conductor.build/changelog) (2026-07-16) reads
"GitHub App installation tokens in the new JWT format are now fully redacted from logs"
(**verified**; note there is no standalone 0.76.1 entry — the note is a trailing section on the
0.76.0 page). Their log redaction also replaces matches with `[REDACTED_GITHUB_TOKEN]`,
`cond_[REDACTED]` and `sk-[REDACTED]`, per our first-hand teardown of the 0.77.5 install.

The fix is a rule that does not try to model the token's interior — e.g. `gh[psuor]_[A-Za-z0-9_.\-]{20,}`
without trailing `\b`, plus a bare-JWT rule that does not require a preceding word boundary.
Ship it **before** the first installation token is minted, not after.

One related field to check for the same class of assumption: the PAT input placeholder at
`src/zeros/panels/github-section.tsx:241` is `ghp_xxxxxxxxxxxxxxxxxxxx`. Cosmetic, but it is the
UI telling users which of the five credential types Zeros expects, and it is wrong for four of
them. `setToken()` itself imposes no length or shape check (`src/engine/git/github.ts:258-276`) —
only non-empty — so storage is genuinely format-agnostic. That part is fine.

### 2.4 Rate limits for installation tokens — the exact scaling rule

The scaling rule is quoted constantly and mis-stated almost as often. The verbatim current text
([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
**verified**):

> For installations that are **not** on a GitHub Enterprise Cloud organization or enterprise,
> the rate limit for the installation will scale with the number of users and repositories.
> Installations that have more than 20 repositories receive another 50 requests per hour for each
> repository. Installations that are on an organization that have more than 20 users receive
> another 50 requests per hour for each user. The rate limit cannot increase beyond 12,500
> requests per hour.

Four precision points that change how you plan:

1. The **+50/repo and +50/user scaling applies only to non-GHEC installations.** GHEC
   organizations and enterprises get a **flat 15,000/hr** and do **not** scale — and are not
   subject to the 12,500 cap.
2. The ">20 repositories" test is on the **installation's** repository count, not the
   organization's.
3. The per-**user** bonus is explicitly limited to installations on an **organization**.
   Personal-account installations scale by repositories only.
4. Since 2025-07-01, apps installed at the **enterprise** level also get 15,000/hr (and 10,000
   GraphQL points/hr) from a budget separate from org or user installations.

Contrast the user-to-server side: a GitHub App user token shares the human's 5,000/hr, and the
docs are explicit that it "is combined with any requests that another GitHub App or OAuth app
makes on that user's behalf **and any requests that the user makes with a personal access
token**" (the final clause is usually truncated away). Requests made on a user's behalf by an
app owned by a GHEC org get 15,000/hr instead — and, per a sentence added 2026-01-13,
"requests made by a higher-limit app reduce the remaining budget available for lower-limit
authentication methods." All **verified**.

**The consequence for Zeros:** a GitHub App buys *no primary-quota advantage at all* for
user-scoped calls. A user running Zeros alongside another agent tool can be throttled by the
other tool. The quota win exists only on the installation leg — which is another reason to route
cloud-workspace PR polling through installation auth rather than the user token.

### 2.5 What installation tokens are and are not subject to

| Constraint | Installation token | Evidence |
|---|---|---|
| Org **IP allow list** | **restricted**, "including the Actions `GITHUB_TOKEN`" — *except* installation tokens where the app is installed on a **user account** | **verified**, [org IP allow lists](https://docs.github.com/en/enterprise-cloud@latest/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/managing-allowed-ip-addresses-for-your-organization) |
| Org **SAML SSO** authorization | **not documented either way** | **unverified** — see §7.4 |
| Repos not in the grant | 404 Not Found, not 403 | **verified** |
| Org-wide list endpoints | partial **200** — "only the repositories that the app installation can access" | **verified** |
| Installation deleted | `POST /app/installations/{id}/access_tokens` → **404** `{"message":"Not Found"}` | **verified** |
| Installation suspended | API calls → **403** with a suspension message | **verified** |

Two asymmetries worth internalising:

- **The App IP allow list does not help the desktop.** "The addresses in the IP allow list of a
  GitHub App only affect requests made by installations of the GitHub App. The automatic
  addition of a GitHub App's IP address to an organization's allow list does not allow access to
  a GitHub user who connects from that IP address" (**verified**,
  [App IP allow lists](https://docs.github.com/en/apps/maintaining-github-apps/managing-allowed-ip-addresses-for-a-github-app)).
  So for an IP-allow-list org: the *cloud* leg can be made to work if Zeros declares a stable
  egress CIDR **and** the org owner enables "Enable IP allow list configuration for installed
  GitHub Apps"; the *desktop* leg, coming from the user's home IP, stays blocked. Never promise
  enterprise customers that installing the App fixes desktop access behind an org IP allowlist.
- **The inverse asymmetry on org-owned public repos:** `ghs_` installation tokens are reported
  blocked with 403 where a user PAT or OAuth token succeeds (community Discussion #191185) —
  which is what breaks `GITHUB_TOKEN`-based CI and `gh` attestation flows (**likely**).

Org allow-list entries added by an app are labelled "Managed by the NAME GitHub App" and
"cannot be edited, deleted, or disabled". As of GA 2026-06-08 coverage extends to repositories
owned by enterprise managed users, including forks (**verified**).

### 2.6 Suspension is asymmetric

Whoever suspended must unsuspend. An app owner suspends via JWT `PUT /app/installations/{id}/suspended`
and can unsuspend; an account owner who suspends in the UI **cannot** be unsuspended by the app
owner, and vice versa (**verified**,
[suspending an installation](https://docs.github.com/en/apps/maintaining-github-apps/suspending-a-github-app-installation)).
Conductor models this: `suspendedAt` is an explicit field in the installation schema embedded in
their runtime binary (first-hand teardown). "Suspended by your org owner" must therefore be a
terminal state in the health readout with copy that says it is unfixable from inside Zeros —
not a Reconnect button that can never work.

### 2.7 Endpoints that require the private key (so: backend only)

Every endpoint that answers *"which installation covers this repo/org/user"* is documented as
"You must use a JWT to access this endpoint" (**verified**, [REST apps](https://docs.github.com/en/rest/apps/apps)):

- `GET /repos/{owner}/{repo}/installation`
- `GET /orgs/{org}/installation`
- `GET /users/{username}/installation`
- `GET /app/installations`
- `GET /app/installation-requests`

This is a decisive constraint: **the engine can never resolve repo → installation itself.**
The client-side path with only a user token is `GET /user/installations` → then
`GET /user/installations/{installation_id}/repositories` per installation (30/page default, 100
max). For a user with 1 personal + 3 org installs and ~250 total repos that is roughly
**1 + ~6 ≈ 7 REST calls**, all ETag-cacheable (**verified**). Cheap enough to do at connect time
and keep fresh with conditional requests; too expensive to do on every render.

`GET /app/installation-requests` deserves a warning: GitHub's REST reference lists it under
user-access-token auth, but developers reported 401s with user and OAuth tokens for ~20 months
and the working solution (posted 2025-03-05) was an **app JWT** (**likely**). Documented auth
and working auth disagree. Treat pending-request enumeration as best-effort backend-only garnish;
the reliable signals are the `installation` webhook and a periodic `GET /user/installations` poll.

### 2.8 GitHub's own installation-token reliability

Two dated incidents, both **likely** (status-page aggregators, not GitHub's own postmortems):

- **2026-05-23, 06:00–19:12 UTC**: 1–5% of app installation token authentication requests failed
  (avg 2.3%, peak ~5.4%), "including failures in Git operations and API calls using app
  installation tokens"; cause a caching proxy component.
- **2026-02-17, 17:07–19:06 UTC**: token verification lookups intermittently failed producing
  401s, from replication lag in the token-verification database cluster.

This is the strongest available argument against Zeros' current auto-clear-on-401 behaviour.
During the February incident, Zeros as written would have silently signed out a chunk of its
users. **Require N consecutive auth failures plus a successful control request before clearing
anything.**

---

## 3. User access tokens — 8 hours, 6 months, and the refresh contract

This is the credential the Mac holds under the App method. It is the one that must read as the
human when Zeros opens a PR or posts a comment.

### 3.1 The numbers and the toggle

- "The user access token expires after **eight hours**, and the refresh token expires after
  **six months**" — `expires_in: 28800`, `refresh_token_expires_in: 15897600` (the docs note
  the latter "will always be 15897600 (6 months)"). **verified**.
- The setting is App settings → **Optional Features** → "User-to-server token expiration",
  with Opt-in / Opt-out. **"When you create your app, expiration of user access tokens is
  enabled unless you opt out"** — expiring tokens are the *default* for newly created Apps.
  GitHub labels it "currently an optional feature and… subject to change" and "recommends that
  you opt in." **verified**.
- If disabled, `expires_in` / `refresh_token` / `refresh_token_expires_in` "will be omitted"
  and the tokens do not expire. **verified**.
- Flipping expiration **on** does not retroactively expire already-issued tokens: "If you opt
  into user access tokens that expire after you have already generated user access tokens, the
  previously generated user access tokens will not expire." **verified**.
- The numeric table lives on both [refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
  and [generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app);
  the latter is the better citation for the exact values.

The spec turns this on. Correct: silently opting *out* to dodge the refresh work is possible and
throws away the entire security argument for the App.

### 3.2 The refresh request, exactly

```
POST https://github.com/login/oauth/access_token
  client_id=<app client id>
  client_secret=<app client secret>
  grant_type=refresh_token
  refresh_token=<ghr_…>
```

Precision points, all **verified**:

- GitHub formally describes these as **query parameters**, though it accepts them in the query
  string, a form-encoded body, or a JSON body. Do not read the docs as prescribing a form body.
- `client_secret` is **"Required unless the user access token was generated using the device
  flow"** (carve-out introduced 2024-02-08 via github/docs PR #32628, unchanged as of July 2026).
  This is load-bearing: after a *device-flow* grant, refresh needs no secret and the engine could
  in principle refresh locally. After a *web-flow* grant it must proxy through `backend/`.
- PKCE parameters are **not** part of the refresh request.
- A refresh returns **both** a new access token and a new refresh token.
- **Refresh-token use is single-use with no grace period.** The moment a refresh succeeds, both
  the old refresh token *and* the old access token stop working. The new pair must be durably
  persisted **before** the old one is discarded, or a crash between the two forces a full
  re-authorization.
- The 6-month window is **not a calendar re-auth ceiling**. Each refresh mints a new refresh
  token, so an app that refreshes at least once every six months maintains access indefinitely.
  The practical re-consent trigger is **six months of app inactivity** — which for Zeros means
  "laptop closed for half a year." Design that as a normal state with normal copy, not an error.
- Revocation: `DELETE /applications/{client_id}/token`. **verified**.

### 3.3 The permission intersection, and the state it creates

"A user access token only has permissions that both the user and the app have… if the app was
granted permission to write the contents of a repository, but the user can only read the
contents, then the user access token can only read the contents." GitHub actually frames it as
**three** constraints rather than one intersection (**verified**, corrected): the app can reach
only resources (a) the user has access to, (b) it has permission to access, and (c) in an account
where it is installed.

That third clause is the trap. Because authorization and installation are independent, the UI
must distinguish:

| State | How you detect it | Copy |
|---|---|---|
| Not connected | no credential | "Connect" |
| Connected, installed nowhere | user token works, `GET /user/installations` empty | "Connected to *login* — no repositories yet. Install the Zeros app." |
| Connected, installed on some | installations non-empty, `repository_selection: selected` | "3 of 12 repositories" |
| Connected, installed everywhere | `repository_selection: all` | "All repositories accessible." |
| Install requested, pending owner approval | pre-install record + `setup_action=request` | "Waiting on an owner of *org* to approve" |
| Suspended | 403 + suspension message | terminal, no retry affordance |
| SSO-blocked | 403 + `X-GitHub-SSO`, or partial 200 | per-org authorize link |

Conductor's runtime binary models exactly this data — `{ installationId, accountLogin,
accountType, targetType, suspendedAt, createdAt, repositoryCount, repositoryNames[] }` — which
is what powers the screenshot's "All repositories accessible." line and could equally render
"3 of 12" (first-hand teardown). `repositoryCount` + `repositoryNames[]` is the minimum shape.

### 3.4 Attribution under a user token

"If your app posts a comment on behalf of a user, the GitHub UI will show the user's avatar photo
along with the app's identicon badge as the author of the issue" (**verified**; the sentence ends
"as the author of the issue", not just "as the author"). This is the right behaviour for Zeros:
PRs and comments read as the human, with a visible badge saying a tool did it.

Revocation by the user fires the `github_app_authorization` webhook — which an App receives by
default and **cannot unsubscribe from** — after which the token returns 401 Bad Credentials
(**verified**). That webhook is arguably the one Zeros most wants: it is how you learn you were
revoked, so the panel can show "disconnected" rather than failing on next use.

---

## 4. Personal access tokens — two products behind one text field

`Personal Access Token` is one radio button covering two credentials with materially different
behaviour. The UI must not pretend otherwise.

| | Classic PAT | Fine-grained PAT |
|---|---|---|
| Authorization model | classic **scopes** (`repo`, `read:org`, `workflow`, …) | granular **permissions** |
| Blast radius | "access to all repositories within the organizations that you have access to, as well as all personal repositories" | "Each token is limited to access resources owned by a **single** user or organization" |
| Multiple orgs at once | yes | **no** |
| Expiry | 1–366 days or none | 1–366 days or none, subject to org/enterprise max-lifetime policy |
| Org approval | org can require approval | **"Require administrator approval" is the DEFAULT** at the org tier |
| Under SAML SSO | must be individually authorized **per org after creation** | "authorized during token creation, before access to the organization is granted" |
| Checks API | read works (write is App-only, always was) | **inaccessible entirely** |
| Outside/repository collaborator | works | **cannot be used** |
| Public repos not owned by you | write works with `repo` | no write |
| Packages, user-account Projects | works | no access |
| Status July 2026 | discouraged, **not deprecated**, no announced sunset | GA since 2025-03-18 |

All **verified** against [managing your PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
(page last updated 2026-07-08) and the [org PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization)
page. Two refinements worth carrying:

- The "1–366 or `none`" range is documented as the `expires_in` URL query parameter for prefilled
  token-creation links (default 30 days if omitted, or less under a lifetime policy). The web UI
  itself offers presets, a custom date and "No expiration", with the note "Infinite lifetimes are
  allowed but may be blocked by a maximum lifetime policy."
- "Require administrator approval" is the default at the **organization** tier, with two carve-outs:
  tokens created by org owners themselves skip approval, and if the parent enterprise sets an
  approval policy the org cannot override it (enterprise-tier default is "allow organizations to
  configure their own requirements").
- The November 2025 "classic token creation disabled" changelog covers **npm registry tokens
  only** and does not apply to GitHub PATs. Do not cite it as a PAT sunset.

### 4.1 The Checks hole, precisely

This is the concrete breakage in this repo. `getPrChecks` calls `checks.listForRef`
(`src/engine/git/github.ts:1341`). GitHub's machine-generated fine-grained-PAT endpoint
allow-list (`src/github-apps/data/fpt-2026-03-10/fine-grained-pat.json` in github/docs, API
version 2026-03-10) has **39 endpoint categories and no `checks` category** — the Checks API is
entirely inaccessible to fine-grained PATs (**verified**).

The common framing "classic works, fine-grained breaks" needs one correction: "Write permission
for the REST API to interact with checks is only available to GitHub Apps. OAuth apps and
authenticated users can view check runs and check suites, but they are not able to create them."
So classic `repo` never allowed *creating* check runs either. The actual regression when a user
moves from classic to fine-grained is loss of **read** access (**verified**).

Product consequence: a user who selects PAT mode and pastes a fine-grained token gets a working
PR list and a **permanently broken checks column**, with no error that names the cause. This is
precisely why the health readout must be per-capability. Zeros' current single validation —
`users.getAuthenticated()` at `src/engine/git/github.ts:206`, `:248`, `:269` and `:344` — passes
for a classic PAT with *no scopes at all*, a fine-grained PAT with *zero repository permissions*,
and a token expiring tomorrow. Nothing anywhere in the repo reads the `x-oauth-scopes` response
header (grep: zero hits).

### 4.2 The single-owner constraint the current model cannot express

A fine-grained PAT targets one resource owner. A user with repos across a personal account and
two orgs needs **three tokens**. Zeros' single-slot `setToken()` (`src/engine/git/github.ts:258`)
cannot represent that. Two honest options: state plainly in the UI that "PAT mode supports one
owner", or key PATs by owner. Silently accepting the second paste and overwriting the first is
the one thing that must not happen.

Also: a pasted fine-grained token may sit in **pending approval** at the org. It looks valid
(`/user` succeeds, a login comes back) and 404s on every org repo.

---

## 5. `gh CLI auth` — what the user is actually selecting

Picking "gh CLI auth" is not picking "no credential". It is picking **GitHub's own classic OAuth
App**, with all of that shape's capabilities and all of its failure modes.

From `cli/cli` trunk, `internal/authflow/flow.go` (**verified** against trunk on 2026-07-29,
latest release v2.96.0 of 2026-07-02):

```go
var (
  oauthClientID     = "178c6fc778ccc68e1d6a"                    // The "GitHub CLI" OAuth app
  // This value is safe to be embedded in version control
  oauthClientSecret = "34ddeff2b558a23d38fba8a6de74f086ede1cc0b" // gitleaks:allow — gh's own value, published in cli/cli
)
```

- Token type: `gho_` user token from a **classic OAuth App**.
- `minimumScopes = {"repo", "read:org", "gist"}` is a **floor**, not the set: the request is
  `append(minimumScopes, additionalScopes...)`, the default interactive HTTPS path also asks for
  `workflow` (when `gh` is being set up as the credential helper), and `admin:public_key` is
  added if you let it upload an SSH key. A typical `gh auth status` shows
  `gist, read:org, repo, workflow`.
- `CallbackURI` is `http://127.0.0.1/callback` for github.com and `http://localhost/` for
  Enterprise "for legacy registration reasons" (in-code comment cites cli/cli PRs #222, #650).
- `flow.DetectFlow()` "tries to perform Device flow first and falls back to Web application
  flow", and `ClientSecret` is documented as "Only applicable in web application flow" — so on
  github.com the callback URI and secret are **dead weight**, exercised only on the
  web-flow fallback (e.g. older GHES). Confirmed by maintainer mislav in cli/cli discussion
  #6291: "we are using the OAuth Device Flow mode of authentication, where there is no final
  redirect to localhost."
- Storage: the system credential store by default since v2.28 (April 2023), falling back to a
  plaintext file if no credential store is usable.
- `gh auth login` warns verbatim: "Take care when passing a fine-grained personal access token
  to `--with-token` as the inherent scoping to certain resources may cause confusing behaviour
  when interacting with other resources. Favour setting `GH_TOKEN` for fine-grained personal
  access token usage."

### 5.1 gh CLI auth is two independent things

This is the distinction Zeros' current UI collapses:

1. **`gh auth token`** — an API credential. Zeros' `detectGhCli()`
   (`src/engine/git/github.ts:232-256`) runs it with a 5-second timeout, verifies via `/user`,
   and **persists it into the token store as a side effect** (`:249`).
2. **`credential.https://github.com.helper`** — a git-config entry, of the form
   `!/usr/bin/gh auth git-credential` (plus `credential.https://gist.github.com.helper`),
   written by `gh auth setup-git` (**likely**; the manual documents the command but not the
   written value — the form is consistently reported by community sources).

Either can exist without the other. A user who ran `gh auth login` but never
`gh auth setup-git` has (1) and not (2): the API works and `git push` fails. That is one of the
two mechanisms behind the "green Connected, failing push" bug, and it is why the gh-CLI row
needs **two** health checks, not one.

### 5.2 Why it must stay a co-equal method

Since 2025-12-01 (GA), org owners can "prevent repository admins from installing GitHub Apps on
the repositories they manage", and org policy can separately disable app access requests. With
both set, GitHub's own docs warn, "users with repository admin access will be blocked from both
installing apps and requesting installations." A further "control who can request apps" preview
shipped 2025-12-22. **verified**
([changelog](https://github.blog/changelog/2025-12-01-block-repository-admins-from-installing-github-apps-now-generally-available/),
[org limits doc](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/limiting-oauth-app-and-github-app-access-requests-and-installations)).

There exists a real and increasingly common org configuration in which the Zeros GitHub App can
be **neither installed nor requested**. The three-radio design is therefore not parity theatre;
it is a correctness requirement.

### 5.3 Bundle it, or at least stop treating absence as a dead end

Conductor ships the real GitHub CLI inside the app bundle: `Resources/bin/gh`, 53 MB
(first-hand teardown). They never have a "GitHub CLI not found" state. Zeros' `detectGhCli()`
treats `ENOENT` as "gh unavailable" and the panel then shows a dead end
(`src/zeros/panels/github-section.tsx:225-228`). Electron does repair PATH before spawning the
engine (`hydrateShellPath` at `electron/main.ts:1093`), so Homebrew-installed `gh` and
`git-credential-*` helpers *are* resolvable — the credential gap is not a PATH problem. But a
user with no `gh` at all currently gets no path forward from that copy.

---

## 6. Git over HTTPS with a token

Everything Zeros needs at the transport layer, in one place.

### 6.1 The credential itself

> You can also use an installation access token to authenticate for HTTP-based Git access. Your
> app must have the Contents repository permission. You can then use the installation access
> token as the HTTP password… `git clone https://x-access-token:TOKEN@github.com/owner/repo.git`

**verified** ([authenticating as an installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)).
The same trick works for user tokens and PATs.

Four rules:

| Rule | Confidence |
|---|---|
| `x-access-token` is a **readability convention** — GitHub ignores the username field when a valid token is the password | **verified** (GitHub's PAT docs say outright "the username is not used to authenticate you"; community discussion [#173881](https://github.com/orgs/community/discussions/173881) confirms it for `ghs_`) |
| It must nonetheless be **non-empty** — an omitted username yields an invalid-credentials error | **verified** |
| `Contents: read` suffices for clone/fetch; **`Contents: write` is required for push** | **verified** |
| Pushing any change under **`.github/workflows/`** additionally requires the **`Workflows`** permission | **verified** ([choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)) |

The `Workflows` rule is not an edge case for this product. A coding agent asked to "fix CI" edits
`.github/workflows/*.yml` and then pushes. Without that permission the push fails at the *remote*,
after the commit, with a message the current classifier does not match. Emit `Workflows: write`
in the App registration and surface the failure as "your Zeros installation cannot push workflow
changes", not as `GIT_COMMAND_FAILED`.

Do **not** bake the token into the remote URL. A 1-hour token embedded in `remote.origin.url`
goes stale within the hour, leaks into `.git/config`, into every `git remote -v`, into shell
history and into every log line that echoes the remote, and survives as garbage after expiry
(**verified** guidance, consistent across GitHub's docs and every reference implementation we
inspected).

### 6.2 Owning git's credential resolution

The mechanism the credential broker depends on, verified rather than assumed:

- `-c credential.helper=` with an **empty value resets the helper list**
  ([gitcredentials(7)](https://git-scm.com/docs/gitcredentials), git ≥ 2.9). Verified empirically
  on **git 2.50.1**: it clears both `credential.helper` and URL-scoped
  `credential.<url>.helper` from user config, and it bypasses `GIT_ASKPASS` when the helper
  returns both username and password. This is what stops a user's stale `osxkeychain` or `gh`
  helper from silently winning.
- The override covers **credential helpers only**. `url.<base>.insteadOf`, `http.proxy` and
  `http.extraHeader` from user config still apply, and `-c` propagation has known gaps for
  **git-lfs** and **recursive submodules** (**verified**).
- Host-scoping (`credential.https://github.com.helper=…`) is a **security requirement**, not
  tidiness: an unscoped helper offers the GitHub credential to every remote, including an
  attacker-controlled one reached through a malicious repo's `.gitmodules`.
- `GIT_TERMINAL_PROMPT=0` converts a hang into a fast, classifiable failure. Verified
  empirically in the audit sandbox: with a controlling tty, no helper and no askpass,
  `git ls-remote` printed `Username for 'http://…':` and **hung until killed** (rc=124); with no
  tty it exited immediately with `fatal: could not read Username for '…': No such device or
  address`; with `GIT_TERMINAL_PROMPT=0` it exited immediately with a clean error.
  `GIT_TERMINAL_PROMPT` appears **nowhere** in `src/`, `electron/`, `backend/` or `docs/`.

### 6.3 The git credential protocol has expiry built in — use it

Under-used and directly relevant to a 1-hour token (**verified**,
[git-credential](https://git-scm.com/docs/git-credential)):

| Attribute / behaviour | Since | Meaning |
|---|---|---|
| `password_expiry_utc=<unix seconds>` | git **2.40** | `git credential fill` ignores an expired password when reading from helpers (`credential.c`: `if (c->password_expiry_utc < time(NULL))`), so it moves on rather than using a stale token |
| `oauth_refresh_token` | git **2.41** | carried through; git has no special behaviour for it |
| `wwwauth[]` | git **2.41** | one-way informational attribute |
| `erase` on 401 | long-standing | after a 401 on a supplied credential, git calls `credential_reject()`, invoking **every** helper with `erase` |
| `capability[]=state` + `continue=1` | git **2.46** | lets a helper be consulted **again** after a subsequent 401 on an already-authenticated request (`http_auth.multistage` → `HTTP_REAUTH`) — this is *not* gated on `capability[]=authtype`, which is a separate 2.46 capability for Bearer/NTLM-style `authtype`/`credential`/`ephemeral` values |

Caveat: as of July 2026 **Git Credential Manager has not implemented `state[]`/`continue`**
(git-credential-manager issue #2057, opened 2025-09-26, still a request), so the re-consult path
cannot be assumed available in a user's installed helper. For Zeros' own helper it is available
and worth using — but the belt-and-braces answer is the broker's proactive T−60s refresh plus a
`/report-failure` route, which does not depend on any git version.

Emitting `password_expiry_utc` from the Zeros helper is close to free and buys a real property:
git itself declines to reuse an expired installation token instead of issuing a doomed request.

### 6.4 The magic username differs per provider

Only GitHub ignores the username. This is the fact that makes the broker — not a shared `PR`
type — the durable multi-provider abstraction, because it is the one thing that genuinely differs
per provider *and* per credential kind at the git layer.

| Provider / credential | git username | Confidence |
|---|---|---|
| GitHub, any token | `x-access-token` (any non-empty; ignored) | **verified** |
| GitLab **OAuth** token | **`oauth2`** — mandatory, the real username fails (gitlab-org/gitlab#349461) | **verified** |
| GitLab **PAT** | any non-blank | **verified** |
| Bitbucket Atlassian **API token** | `x-bitbucket-api-token-auth` (or the exact case-sensitive username) | **verified** |
| Bitbucket repo/project/workspace token | `x-token-auth` | **verified** |

Two dates that make this urgent rather than theoretical: Bitbucket **app passwords were fully
removed on 2026-07-28** — one day before this report — so anything written against them is
already dead; and Atlassian API tokens with scopes (`read:repository:bitbucket`,
`write:repository:bitbucket`) are the replacement. (Our evidence base contains one internal date
conflict here: a second source in the same set gives 2026-06-09 for app-password disablement.
The 2026-07-28 date is the one carried by the authoritative spec; the discrepancy is noted for
part 10 and does not affect any GitHub mechanic.)

### 6.5 Commit attribution — the token is not the author

The most likely source of "why does my git history say Zeros" complaints, and GitHub's own docs
do not cover it. The corrected, **verified** position:

- **Commits pushed with an installation token are NOT attributed to the bot by virtue of the
  token.** The token is only a push credential. GitHub links a commit to a profile purely by
  matching the **author/committer email**.
- Auto-attribution to `<slug>[bot]` happens only for commits created through the **REST/GraphQL**
  APIs (Contents API create/update, the Git Database blob→tree→commit→ref flow, GraphQL
  `createCommitOnBranch`). Those are additionally **server-signed** and show Verified — but only
  when the request "contains no custom author information, custom committer information, and no
  custom signature information". Known exceptions: Contents API file **DELETE** produces an
  unsigned commit (community #180621, Nov–Dec 2025), and `POST /repos/{owner}/{repo}/git/tags`
  with tagger info produces unsigned tags.
- **Zeros pushes real local commits over git, not via the Contents API**, so none of that signing
  applies. Nobody should expect a green Verified badge from App mode.
- If you ever *do* want the bot identity, the email form is
  `{BOT_USER_ID}+{login}@users.noreply.github.com`, where `BOT_USER_ID` is the `id` from
  `https://api.github.com/users/<app-slug>%5Bbot%5D` (URL-encoded brackets; unencoded brackets
  404 — the cause of actions/create-github-app-token#172). Verified live July 2026:
  `dependabot[bot]`=49699333, `renovate[bot]`=29139614, `claude[bot]`=209825114. Read the `login`
  from that response rather than string-building `<slug>[bot]`, because it is not always the slug
  (app slug `copilot-swe-agent` has login `Copilot`, id 198982749). Attribution matches on the
  **numeric id only** — the text after `+` is cosmetic.
- Using the **App ID** instead of the bot user id is a genuine hazard, not a cosmetic slip: App
  IDs are small sequential integers that collide with real human account ids (Dependabot's app id
  29110 = user `wherewegonow`; the Claude app's 1236702 = user `herbalnerds`), so a collision with
  an account whose noreply address is active would attribute your agent's commits **to an
  unrelated person**.

**Decide this explicitly.** The spec's answer — pass `gitIdentity: { name, email }` into cloud
sandboxes so commits are attributed to the human, with the `[bot]` identity appearing at most as
the PR author when Zeros opens a PR on the user's behalf — is the right one, and Conductor does
the same (`gitIdentity` is an explicit field in their sandbox-creation payload, first-hand
teardown). Note the adjacent cautionary tale: VS Code's `git.addAICoAuthor` default flip to
`"all"` in v1.117 (2026-04-22) silently injected `Co-authored-by: Copilot <copilot@github.com>`
onto hand-written commits, produced a public backlash on consent and repo provenance, and was
narrowed in 1.118 and reverted to `off` in 1.119 (2026-05-06) with a commitment to require
explicit consent (**likely**). Do not write trailers users did not ask for.

---

## 7. Device flow — supported for Apps, off by default, and now an attack surface

### 7.1 Mechanics

Device flow **is** documented for GitHub Apps, not only OAuth Apps (**verified**,
[generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)):

| Step | Endpoint | Notes |
|---|---|---|
| 1 | `POST https://github.com/login/device/code` | returns `device_code`, `user_code`, `verification_uri`, `expires_in` (default **900 s / 15 min**), `interval` (default **5 s**) |
| 2 | user enters the code at `https://github.com/login/device` | **50 verification-code submissions per hour per application** (browser side, not polling) |
| 3 | `POST https://github.com/login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` | only `client_id`, `device_code`, `grant_type` are required; **no client secret**; optional `repository_id` narrows the resulting user token to a single repository |

- **"Before you can use the device flow, you must first enable it in your app's settings."** The
  checkbox is App settings → *Identifying and authorizing users* → **Enable Device Flow**
  (for OAuth Apps it lives on the OAuth app's own settings page). Since the
  [2022-03-16 changelog](https://github.blog/changelog/2022-03-16-enable-oauth-device-authentication-flow-for-apps/)
  it must be manually enabled for all OAuth and GitHub Apps, and "the OAuth Device Authorization
  flow API endpoints will respond with status code 400 to Apps that have not enabled this
  feature". **A 400 `device_flow_disabled` is the most likely day-one failure.** Put the checkbox
  in the app-registration runbook.
- When device flow is used instead of the web application flow, **the callback URL field is
  ignored**.
- Error codes: `authorization_pending`, `slow_down`, `expired_token`, `unsupported_grant_type`,
  `incorrect_client_credentials`, `incorrect_device_code`, `access_denied`, `device_flow_disabled`.
  `slow_down` adds 5 seconds to the **last** interval, so consecutive `slow_down`s compound
  (5 → 10 → 15 s) and the client must carry the adjusted value forward. The correct wire value for
  expiry is `expired_token`; the OAuth Apps page's narrative prose contains a long-standing typo
  rendering it `token_expired`.
- **PKCE is not used by the device flow.** Do not add `code_challenge` parameters to it.
- On GHES the host is `http(s)://HOSTNAME` rather than `https://github.com`.

All **verified**. Zeros' existing `startDeviceFlow()` (`src/engine/git/github.ts:302-350`,
`@octokit/auth-oauth-device`) works against a GitHub App client id essentially unchanged — the
`clientType` switches from `"oauth-app"` to `"github-app"` and the grant now also *implies* an
installation. Do not assume device flow removes the need for an install browser trip: install
still happens in a browser.

UI requirements that follow from the error table: a **15-minute countdown**, and three distinct
outcomes rather than one "sign-in failed" — `access_denied` (user cancelled → offer retry),
`expired_token` (start over), `device_flow_disabled` (misconfiguration, not a user error).
`@octokit/auth-oauth-device` handles `slow_down` internally, but the failure surface must stay
user-legible.

### 7.2 Why it is the fallback and not the recommendation

Device-code phishing moved from an APT technique to a commodity attack class inside 18 months
(**verified**):

- Microsoft attributed an active campaign to **Storm-2372** — assessed with *moderate* confidence
  as aligning with Russian state interests, active since August 2024 — on
  [2025-02-13](https://www.microsoft.com/en-us/security/blog/2025/02/13/storm-2372-conducts-device-code-phishing-campaign/).
- Microsoft published a follow-up, "Inside an AI-enabled device code phishing campaign", on
  [2026-04-06](https://www.microsoft.com/en-us/security/blog/2026/04/06/ai-enabled-device-code-phishing-campaign-april-2026/).
- A [CSA research note dated 2026-04-05](https://labs.cloudsecurityalliance.org/research/csa-research-note-oauth-device-code-phishing-surge-20260405/)
  reports a **37.5× surge** in device-code phishing pages, attributed to the **EvilTokens**
  phishing-as-a-service kit that launched on Telegram in mid-February 2026 (corroborated
  independently by Sekoia, Huntress, Mimecast, Abnormal AI, ESET and The Register).

The mechanism is why it is hard to defend: the victim is walked through a **genuine** provider
authorization page and completes real MFA there, so the attacker-generated device code is approved
by the victim and the attacker receives valid access and refresh tokens. No credential theft, no
attacker-controlled origin — which is exactly why phishing-resistant MFA and AiTM defences do not
stop it. Effective mitigations are policy-level: disable or scope the grant where not needed, and
shorten refresh-token lifetimes.

One widely-repeated claim in this area was **refuted** and should not be used in review: Salesforce
did **not** remove OAuth 2.0 device flow entirely. It removed device flow from two first-party
connected apps — the Data Loader app (effective 2025-09-02) and the default Salesforce CLI app
(2025-08-28) — and disabled the "Enable for Device Flow" toggle on classic Connected Apps so the
CLI restriction could not be bypassed. Device flow remains a supported, documented Salesforce flow
(including "OAuth 2.0 Device Flow for IoT Integration" and `isDeviceFlowEnabled` on External
Client Apps). Do not tell the panel "even Salesforce killed it."

**Product consequence:** keep device flow wired — it is the only zero-secret path, the only one
that works headless or over SSH, and the fallback for a backend outage or a self-hosted fork — but
do not make "type this code into GitHub" the *recommended* gesture in 2026. Show the user code
inside Zeros with an explicit "only enter this if **you** started it in Zeros" warning, which is
the mitigation every one of the above writeups converges on.

### 7.3 The one thing device flow buys the refresh path

The docs' carve-out — `client_secret` "Required unless the user access token was generated using
the device flow" — means a device-flow grant can be refreshed **without a backend round-trip**.
That is worth knowing, because it makes device flow a genuinely self-sufficient fallback rather
than a one-shot: an offline-capable path with an 8-hour token that the engine can renew itself.
Flag it as **verified but untested in this repo**; verify empirically before relying on it,
because it determines whether `backend/` is on the hot path for every 8-hour rollover.

### 7.4 The load-bearing unknown

**Whether a server-to-server installation access token is subject to SAML SSO authorization is
not documented anywhere we could find.** The dedicated "SAML and GitHub Apps" page covers only
install visibility and user-token authorization (**unverified**).

This matters more than any other gap in this document. The entire cloud-workspace value
proposition is that `backend/` mints a token for a sandbox with no human present. If that token
were SSO-session-bound it would be useless. The strong prior — and the reason vendors use Apps for
CI — is that installation tokens are **not** SSO-session-bound, because the installation itself was
approved by an org owner. One February 2026 report (anthropics/claude-code#28738, closed as not
planned, no maintainer reply) alleges an org-level App installation acting on SSO-protected repos
where the user had never SSO-authorized the app's token, which is consistent with that prior but is
a single unanswered issue.

**Test this against a real SAML-enforced org before committing.** Until then, scope
cloud-sandbox installation tokens to a single repository via `repository_ids` so the blast radius
is provably one repo, and be able to say so to the security-conscious customer who asks.

---

## 8. PKCE and the client-secret problem

### 8.1 What GitHub shipped

Per the [2025-07-14 changelog](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/)
(**verified**):

- PKCE is supported for **both** OAuth Apps and GitHub Apps: "Both GitHub Apps and OAuth apps
  should use PKCE with the authorization code flow."
- **S256 only** — `code_challenge_method` "Must be S256 - the plain code challenge method is not
  supported"; `code_challenge` is "a 43 character SHA-256 hash of a random string generated by the
  client."
- It is **optional**: "GitHub is not requiring PKCE for any authentication flow at this time, as
  GitHub does not distinguish between public and confidential clients."
- Device flow and installation-token flows are **excluded**.
- On the code exchange, `code_verifier` is "Strongly recommended", required only if
  `code_challenge` was sent.

### 8.2 The constraint that decides the architecture

GitHub still documents `client_secret` as **Required** on
`POST https://github.com/login/oauth/access_token` for the authorization-code flow, for OAuth
Apps and GitHub Apps alike, **even with PKCE**. GitHub's own best-practices doc says public
clients "will have to ship the client secret in the application's code." GitHub staff (@hpsin) in
[community discussion #15752](https://github.com/orgs/community/discussions/15752) on **2025-07-15**:

> Yes, we don't have a 'public client' concept yet, so we treat all clients the same and all of
> them require access to the client secret. […] You cannot keep a secret 'secret' within a public
> client, but you do have to embed it there anyhow. This is how e.g. VS Code, Visual Studio, GH
> CLI, and GitHub Mobile all work.

On 2025-10-27 the same staffer pointed to github/roadmap#1153, "Single page app support for GitHub
Apps [Preview]", which *will* require PKCE and forbid a client secret — native apps "to come",
no GA date. The thread's latest comment (2026-06-22) notes GitHub missed its Q4-2025 goal and
remains unanswered. All **verified**.

So the honest design space is exactly three options:

| Option | Secret location | Verdict |
|---|---|---|
| **(a) Device flow** | none needed | keep as the fallback; not the recommendation (§7.2) |
| **(b) Backend performs the exchange** | `backend/` | the spec's choice. `backend/` already exists (Hono + Postgres + RLS + Auth0 + teams + audit + rate limiting), and only a server can hold the App private key anyway |
| **(c) Ship the secret** | the binary | has first-party precedent, but no multi-tenant precedent |

The precedents for (c) are real and should be cited accurately rather than dismissed:

- **`gh`** embeds its OAuth client secret in trunk with the comment "This value is safe to be
  embedded in version control" (**verified**).
- **GitHub Desktop** "uses the OAuth web application flow" and "The OAuth client ID and Client
  Secret are bundled into the application with webpack." Its repo ships a developer OAuth app in
  `app/app-info.ts` marked "DO NOT TRUST THIS CLIENT ID AND SECRET! THIS IS ONLY FOR TESTING
  PURPOSES!!", overridable via `DESKTOP_OAUTH_CLIENT_ID` / `DESKTOP_OAUTH_CLIENT_SECRET`
  (**verified**). That env-override pattern is worth copying: it mirrors Zeros' existing
  `ZEROS_GITHUB_CLIENT_ID` escape hatch at `src/engine/git/github.ts:93-97` and lets dev
  worktrees and GHES customers point at their own registration without a rebuild.
- **`github/github-mcp-server`** — first-party, June 2026, and the closest match to the target
  shape: "The server prefers the authorization code flow with PKCE: it starts a loopback callback
  server on your machine, opens GitHub's authorization page, and exchanges the returned code for a
  token"; "Because this is a public, distributed client, that secret is baked into the binary and
  is **not truly confidential**"; "PKCE is what secures the flow: it binds the authorization code
  to this one login attempt, so a code intercepted on the loopback redirect can't be redeemed
  anywhere else." Tokens are kept **in memory only** and GitHub App tokens "are refreshed
  transparently using the refresh token". Every quoted string was independently re-checked against
  the raw file; the doc was created 2026-06-26 and last modified 2026-07-22 (**verified**).
- **VS Code** is pattern (b) at scale: the browser goes to a GitHub-operated service at
  `https://vscode-auth.github.com/` and returns to the editor through a `vscode://` URI handler,
  with tokens landing in a keychain item `vscodevscode.github-authentication` — and VS Code
  *additionally* writes a session token into `credential-osxkeychain` so plain `git` works
  (**likely**; we could not verify from primary Microsoft/GitHub source that
  `vscode-auth.github.com` performs the exchange itself rather than merely redirecting). That last
  detail is the one to copy: without a deliberate equivalent step, Zeros reproduces the push gap.

None of these ships a multi-tenant cloud product whose blast radius includes other people's
repositories. Precedent, not justification.

### 8.3 What PKCE does not do

An important correction, because the naive version of this argument was **refuted** in our
verification pass and will not survive a security review.

What survives (**verified** against downloaded RFC text):

- RFC 8252 §8.1: "Loopback IP-based redirect URIs may be susceptible to interception by other apps
  accessing the same loopback interface on some operating systems," and PKCE "protects the
  authorization code from being used if it is intercepted… An app that intercepted the
  authorization code would not be in possession of this secret, rendering the code useless."
- RFC 9700 §4.5.3.1: "PKCE ensures that an attacker cannot redeem a stolen authorization code at
  the token endpoint… without knowledge of the code_verifier."
- RFC 6749 §4.1.2: codes are single-use; reuse MUST be denied and SHOULD revoke previously issued
  tokens.

What does **not** survive is the conclusion "PKCE defeats the local-attacker case." Auth0's
guidance says verbatim: "PKCE doesn't really help in these scenarios, as the malicious application
can initiate the login flow and wait to receive the callback without user interaction," and puts
loopback in the same bucket — desktop/CLI apps on `127.0.0.1` "are similarly at risk. In this case,
another application on the same machine could listen on the same port to intercept the response."
Auth0 classes loopback URIs as **"Non-Verifiable Callback URIs"** and its recommended mitigation is
a per-transaction end-user confirmation prompt (per RFC 8252 §8.6), not PKCE.

The residual attack is **client impersonation, not code interception**: the local malicious process
runs its *own* authorization request with the real app's `client_id` and its own verifier and
challenge, so PKCE is satisfied by the attacker. RFC 8252 §8.6 concedes exactly this — the
authorization server "SHOULD NOT process authorization requests automatically without user consent
or interaction, except when the identity of the client can be assured… This includes the case where
the user has previously approved an authorization request for a given client id." A loopback
redirect can never assure client identity, so with an active session the attacker gets tokens
silently and never has to steal anything. **PKCE only stops replay of a code minted against
someone else's challenge.**

Also refuted: the "races the legitimate app to redeem the code" mechanism. With a loopback
redirect exactly one process accepts the callback connection; a squatter that binds first normally
just prevents the real app from binding, and an app using an OS-assigned ephemeral port then
advertises a different port and is not intercepted at all. For both parties to hold the same code
you need loopback packet capture (root / `CAP_NET_RAW` / Npcap) or a fixed, predictable port.

**Send PKCE S256 on every authorization-code request** — it is free, GitHub supports it, and
RFC 8252 §8.1 makes it mandatory for public native clients. Just do not write in the design doc
that it makes the desktop flow safe against a compromised local machine. It does not, and the
correct statement of what protects Zeros is that the code is exchanged server-side by a client
that holds the secret, and the thing handed back over the custom scheme is a **single-use nonce
bound to `state`, not a token**.

---

## 9. Redirect URIs on a desktop app

### 9.1 The standards, quoted

RFC 8252 (BCP 212, Oct 2017 — still Active, no errata, nothing obsoleting it as of July 2026) and
RFC 9700 (BCP 240, Jan 2025, updates RFC 6749/6750/6819). All **verified** against the RFC text:

| § | Rule |
|---|---|
| §7 | native apps "MAY use whichever redirect option suits their needs best" |
| §7.2 | app-claimed `https` redirects "SHOULD" be used "over the other options where possible" |
| §7.3 | apps that can open a loopback port may use it; the AS "MUST allow any port to be specified at the time of the request for loopback IP redirect URIs, to accommodate clients that obtain an available ephemeral port"; `localhost` is **"NOT RECOMMENDED"**; the IP literal `http://127.0.0.1:{port}/{path}` (or `http://[::1]:{port}/{path}`) "avoids inadvertently listening on network interfaces other than the loopback interface" |
| §8.1 | "Public native app clients MUST implement PKCE… and authorization servers MUST support PKCE for such clients" |
| §8.3 | plain `http` is acceptable on loopback "as the HTTP request never leaves the device"; open the port only for the duration of the request; listen on loopback only |
| §8.4 | exact redirect-URI match required, "the exception is loopback redirects, where an exact match is required except for the port URI component"; native apps are public clients unless per-instance secrets are issued |
| §8.5 | "Secrets that are statically included as part of an app distributed to multiple users should not be treated as confidential secrets"; authorization servers "should not require" them, since doing so "serves little value beyond client identification" |
| §8.6 | the AS SHOULD NOT auto-approve without user interaction unless client identity can be assured |
| §8.12 | "native apps MUST NOT use embedded user-agents to perform authorization requests" — a host app embedding a webview "can record every keystroke… to capture usernames and passwords" and "copy session cookies" |
| Appendix B.3 | on Windows, set `SO_EXCLUSIVEADDRUSE` "to prevent other apps binding to the same socket" |
| Appendix B.4 | on macOS, private-use URI schemes are "a good redirect URI choice" |
| RFC 9700 §2.1 / §4.1.3 | "MUST utilize exact string matching except for port numbers in localhost redirection URIs of native apps" |

Two things people get wrong here:

1. **RFC 8252 does not rank loopback above private-use schemes.** It ranks only claimed-https
   above the other two. The stated weaknesses are symmetric-but-different: private-use schemes —
   "multiple apps can typically register the same scheme, which makes it indeterminate as to which
   app will receive the authorization code"; loopback — "may be susceptible to interception by
   other apps accessing the same loopback interface on some operating systems." The mitigations
   are *not* fully symmetric though: §8.3 and Appendix B.3 give loopback-only hardening with no
   private-use counterpart.
2. **The direction of travel does favour loopback.** `draft-ietf-oauth-v2-1-15` (March 2026, still
   a WG document, not an RFC) reorders the native-app options — claimed-https (§8.4.1) → loopback
   (§8.4.2) → private-use (§8.4.3) — and says private-use schemes "are vulnerable to potential
   attacks on their redirect URIs, so this option should only be used if the previously mentioned
   more secure options are not available." **verified**.

RFC 8252 §8.12 is the one rule with no room for interpretation, and it settles a question the
spec answers correctly: **the consent screen is always the system browser
(`shell.openExternal`), never a `BrowserWindow`.** No "embedded login" shortcut in the renderer.

### 9.2 Does GitHub allow a variable loopback port? Yes — and the contradiction is resolvable

There are two GitHub-doc statements in circulation that appear to conflict, and getting this wrong
either blocks the loopback design or ships a fixed, squattable port.

- The [authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
  page says "the redirect URL's host (excluding sub-domains) and port must exactly match the
  callback URL", listing `http://example.com:8080/path` as BAD.
- The same doc family also states: "If the application specifies a loopback URL and a port, then
  after authorizing the application users will be redirected to the provided URL and port. **The
  `redirect_uri` does not need to match the port specified in the callback URL for the app.**"

**Resolution:** the port-exact-match rule governs **non-loopback** redirect URIs; loopback gets
RFC 8252-style port flexibility. Two independent confirmations: `github/github-mcp-server`'s own
docs say "For loopback redirects GitHub does not require the callback port to match, so registering
`http://localhost/callback` is sufficient", and `gh` registers `http://127.0.0.1/callback` with no
port and binds an ephemeral one. Tagged **verified** on the strength of a first-party GitHub doc
plus two first-party implementations — but it is the single mechanic in this document most worth
re-confirming with a five-minute live test before the loopback listener is written, because the
apparent doc conflict is exactly the kind of thing that changes.

Note one deviation to fix if you copy the MCP server: it registers `http://localhost/callback`,
whereas RFC 8252 §7.3 says `localhost` is NOT RECOMMENDED. Register the **IP literal**.

Concrete spec if Zeros builds the listener: bind `127.0.0.1` (never `0.0.0.0`, never `localhost`),
ephemeral port, single-use, close immediately after the redirect, hard timeout, and
`SO_EXCLUSIVEADDRUSE` on Windows. It belongs in **Electron main** — which already owns
safeStorage — so the code never transits the renderer.

Pre-empt the predictable design-review objection: *"didn't Google kill loopback?"* No. Google's
own [migration guide](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration)
(last updated 2026-05-26) states verbatim: "The loopback IP address flow is being deprecated for
iOS, Android, and Chrome OAuth client types but will continue to be supported on desktop apps",
and adds "You don't need to do anything related to this deprecation if you are using the loopback
IP address flow on a Desktop app OAuth client." The 2022 cutoffs (Mar 14, Aug 1 warning, Aug 31,
Oct 21) were all scoped to those mobile/Chrome client types. The carve-out applies to the "Desktop
app" client type with `http://127.0.0.1:port` or `http://[::1]:port` — registering a Web-application
client, or relying on the `localhost` hostname, is a different policy path and is what still
produces "doesn't comply with Google's OAuth 2.0 policy" rejections in 2026. **verified**.

### 9.3 The custom-scheme option, and what macOS actually guarantees

Apple's **current** guidance ("Defining a custom URL scheme for your app") states verbatim: "If
multiple apps register the same scheme, the app the system targets is undefined. There's no
mechanism to change the app or to change the order apps appear in a Share sheet", and recommends
universal links instead because a reverse-DNS scheme "doesn't prevent other apps from registering
the same scheme and handling the associated links." **verified** — and note the older phrasing
often quoted ("there is currently no process for determining which app will be given that
scheme") comes from a retired ~2016 iOS document, not current guidance.

Three refinements that matter on macOS specifically:

- "Undefined" means **undocumented, not random**. Launch Services applies deterministic
  heuristics — apps in root-level `/Applications` preferred over elsewhere, then higher version
  number, with alphabetical/Safari fallbacks on stale records (Jeff Johnson, Dec 2024, addendum
  Feb 2026). **A colliding app can deliberately engineer a win.**
- Registration is **automatic and consent-free**, but `lsd` does not watch the filesystem: per
  Apple's 2026-02-18 response to FB16144150, "LaunchServices does not listen for filesystem
  events; we rely on cleaning up the database as we are asked about items." Registration is
  triggered by Finder/Spotlight-`mds` notification, installers, login-time `/Applications` scans,
  and lazy query-time binding.
- Unlike iOS, macOS *does* have handler-override mechanisms
  (`NSWorkspace.setDefaultApplication(at:toOpenURLsWithScheme:)`, the deprecated
  `LSSetDefaultHandlerForURLScheme`, `duti`, `LSHandlers` in
  `com.apple.launchservices.secure.plist`) — though all fail from a sandboxed app with `-54
  permErr` (Apple DTS, Oct 2025).

Real collisions exist: Zoom and Microsoft Teams both register `sip`/`tel` (Teams registers
`msteams`, `sip`, `sips`, `tel`, `callto`, `im`). **verified**.

The correct internal statement is therefore: **the outcome is undefined and cannot be a security
boundary.** Do not write "the first/last installed app wins" — we could not establish the
arbitration rule from any authoritative source, and Apple documents it as undefined. That is
itself sufficient justification for the spec's design: the scheme carries only a **single-use
nonce bound to `state`**, never a token, so a hijacked callback yields nothing redeemable.

### 9.4 Electron and Zeros-specific mechanics

Zeros already has the deep-link infrastructure, and it is better than the Electron tutorial's
(**verified** by reading `electron/deep-link.ts`):

- `registerProtocol()` at `electron/deep-link.ts:68-87` guards on `process.defaultApp` and passes
  `process.execPath` + `process.argv[1]` in dev.
- `app.requestSingleInstanceLock()` at `:229`, `second-instance` at `:235`, `open-url` at `:244`
  registered inside `will-finish-launching` (the module header at `:16` says so explicitly).
- **`handleUrl()` redacts before logging**: `rawUrl.replace(/([?#]).*$/, "$1<redacted>")` at
  `:104-105`, with the comment "invite tokens + OAuth/pairing secrets ride in the query/fragment".
  That is exactly right and must be preserved when the GitHub callback lands.
- Foreign-scheme rejection at `:110-114`.

Two Electron facts to hold onto (**verified**, [Electron deep-link tutorial](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)):

- On cold start on Windows/Linux the URL is only in `process.argv`. The official doc snippet
  inspects only the **last** element (`process.argv[process.argv.length - 1]`) and uses
  `commandLine.pop()` inside `second-instance` — **both are unreliable**, because Electron injects
  switches such as `--allow-file-access-from-files` and `--original-process-start-time` at
  arbitrary positions (electron/electron#20322, #23220). Scan argv for the item starting with the
  scheme instead.
- `second-instance` does **not** fire on a privilege mismatch — e.g. the app running elevated, or
  the link launched from an elevated context (electron/electron#44298).

And one Zeros-specific hazard the spec does not mention. Zeros registers **one scheme per release
channel** (`src/engine/runtime.ts:168-179`): `zeros`, `zeros-beta`, `zeros-alpha`, `zeros-dev`.
Two consequences:

1. **The backend's `zeros://` hand-back must be channel-aware.** A callback that hardcodes
   `zeros://github/connected` will route a Beta user's sign-in to the *stable* app — which is the
   exact "Open Zeros Beta?" mis-route the comment at `electron/deep-link.ts:46-52` says they
   already fixed once in the other direction. The channel must ride through `state` and come back
   in the scheme.
2. **The custom-scheme callback will not work in `pnpm electron:dev` on macOS.**
   `app.setAsDefaultProtocolClient`'s optional `path`/`args` parameters are documented as
   **Windows-only** (**verified**), so the `process.defaultApp` branch at `deep-link.ts:82` has no
   effect on macOS, and macOS/Linux protocol handling requires a **packaged** app with Info.plist
   / `.desktop` entries. Expect this to be misread as a code bug. Loopback behaves identically in
   dev and prod and needs none of this — which is a maintenance argument for loopback independent
   of the security one.

---

## 10. Every GitHub call Zeros makes today, and what it costs in permissions

This is the table the App registration must be derived from. Every row was read out of
`src/engine/git/github.ts` at the line given. The "App permission" column is the one that
determines the registration; the "fine-grained PAT" column is what determines whether PAT mode
degrades.

| Call | `github.ts:` | Classic scope | Fine-grained PAT | GitHub App permission |
|---|---|---|---|---|
| `users.getAuthenticated` | 206, 248, 269, 344, 911, 1046 | none | none | none |
| `users.getByUsername` | 601 | none (public) | none | none |
| `orgs.listForAuthenticatedUser` | 920 | **`read:org`** | ✗ single-owner | user-to-server, no repo permission |
| `repos.get` | 943 | `repo` | Metadata: read | **Metadata: read** |
| `repos.createInOrg` / `createForAuthenticatedUser` | 1052, 1057 | `repo` | Administration: write † | **Administration: write †** |
| `pulls.create` | 751 | `repo` | Pull requests: write | **Pull requests: write** |
| `pulls.update` | 1119 | `repo` | Pull requests: write | **Pull requests: write** |
| `pulls.list` | 817, 1275 | `repo` | Pull requests: read | **Pull requests: read** |
| `pulls.get` | 851, 1143, 1158, 1229, 1336 | `repo` | Pull requests: read | **Pull requests: read** |
| `pulls.listCommits` | 1459 | `repo` | Pull requests: read | **Pull requests: read** |
| `pulls.listReviews` | 1548 | `repo` | Pull requests: read | **Pull requests: read** |
| `pulls.merge` | 1628 | `repo` | Contents: write + Pull requests: write | **Contents: write + Pull requests: write** |
| `issues.listComments` | 1556 | `repo` | Issues: read † | **Issues: read †** |
| `issues.createComment` | 1607 | `repo` | Issues: write † | **Issues: write †** |
| `checks.listForRef` | 1341 | `repo` | **✗ inaccessible** | **Checks: read** |
| `repos.listCommitStatusesForRef` | 1344 | `repo` | Commit statuses: read | **Commit statuses: read** |
| `repos.compareCommitsWithBasehead` | 1201 | `repo` | Contents: read | **Contents: read** |
| GraphQL `markPullRequestReadyForReview` | 1147 | `repo` | Pull requests: write | **Pull requests: write** |
| GraphQL PR commit stats | 1467 | `repo` | Contents: read + Metadata: read | **Contents + Metadata: read** |
| `git clone` / `fetch` / `pull` (transport) | `ops.ts:198`, `fetch.ts:30`, `init-clone.ts:202` | `repo` | Contents: read | **Contents: read** |
| `git push` (transport) | `ops.ts:126`, `github.ts:1076` | `repo` | Contents: write | **Contents: write** |
| `git push` touching `.github/workflows/` | same | **`workflow`** | Workflows: write | **Workflows: write** |

† = **unverified mapping**, derived rather than read off GitHub's per-endpoint reference. See
§10.2. Everything unmarked is either directly attested in our evidence base or a documented
1:1 (`Metadata: read` is mandatory on every fine-grained/App credential regardless).

### 10.1 What this says about today's scope request

Zeros requests `["repo","read:org"]` (`src/engine/git/github.ts:319`). The table explains both:

- **`repo`** is doing the work of nine distinct fine-grained permissions. It is also full
  read/write on *every* repository in *every* org the user can reach, including settings and
  deploy keys — which is precisely the exposure that earned Conductor a top comment on its launch
  thread ("Full read-write access required to all your Github account's repos. Not just code.
  Settings, deploy keys."). Zeros' current OAuth App has the same exposure and would earn the same
  headline.
- **`read:org`** exists for exactly **one** call — `orgs.listForAuthenticatedUser` at
  `github.ts:920`, inside `listGithubOwners()`, whose only consumer is the Owner dropdown of the
  "Publish to GitHub" dialog (`src/shell/dialogs/publish-to-github.tsx:97`). The code already
  degrades gracefully when the scope is absent: the `catch {}` at `github.ts:928-930` falls back to
  user-only, with the comment "no org scope — user-only is fine". So `read:org` is a
  nice-to-have for one dropdown, requested from every user at sign-in.

Under the App there is no scope string at all — permissions come from the registration and the
installation, and `read:org` has no analogue. That is a straight improvement, and the "Publish to
GitHub" owner list should come from `GET /user/installations` instead.

### 10.2 Two permissions missing from the spec's registration table — for part 10

The authoritative spec's App permission table lists six: Contents (R&W), Pull requests (R&W),
Metadata (R), Checks (R), Commit statuses (R), Workflows (W). Comparing against the call table
above, two rows have no covering permission:

1. **`Issues`.** PR comments are *issue* comments. `getPrReviews` reads them
   (`issues.listComments`, `github.ts:1556`) and `addPrComment` writes them
   (`issues.createComment`, `github.ts:1607`) — the whole Review-tab timeline and every comment
   Zeros posts. GitHub's per-endpoint reference for `POST /repos/{owner}/{repo}/issues/{issue_number}/comments`
   documents the `Issues` permission; whether `Pull requests: write` alone suffices for comments on
   a **pull request** specifically is widely asserted in community sources and **we could not
   confirm it from GitHub's own reference in this pass**. This is a five-minute empirical test
   against a scratch installation and it must be run before the App is registered, because the
   failure mode is a 403 `Resource not accessible by integration` on the single most-used write
   path in the product.
2. **`Administration`.** `publishRepoToGithub` creates a repository
   (`repos.createInOrg` / `repos.createForAuthenticatedUser`, `github.ts:1052-1057`). No permission
   in the spec's table covers repository creation. Again **unverified** as to the exact permission
   name, but certain as a gap: under App mode, "Publish to GitHub" 403s. Either add the permission
   (and accept that `Administration: write` is a scary line item on the consent screen, which
   argues for asking only when the user actually publishes) or **document that Publish-to-GitHub is
   unsupported under App mode and falls back to gh CLI / PAT**. Do not discover this after launch.

A third, non-blocking observation: the spec's Checks entry is `read`, which is correct for
`checks.listForRef`. Note that **write** access to checks is App-only and always has been — "OAuth
apps and authenticated users can view check runs and check suites, but they are not able to create
them" — so if Zeros ever wants to *post* its own check runs (a plausible future for preflight),
that capability exists only under the App, and it is a genuine App-only differentiator worth
remembering.

### 10.3 The header that turns support tickets into fixes

GitHub returns **`X-Accepted-GitHub-Permissions`** on a 403 identifying exactly which permissions
the endpoint requires (**verified**,
[troubleshooting the REST API](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)).
Nothing in Zeros reads it. Surfacing it verbatim in the diagnostics view is the cheapest possible
support deflection: it turns "it says resource not accessible" into "your install is missing
`pull_requests:write`". It also tells you when a permission bump will require re-approval by every
installer.

---

## 11. Error semantics — the truth table

This section is the specification for the classifier the spec's Phase 0 demands. Today
`isAuthError()` at `src/engine/git/github.ts:390-394` is:

```ts
return status === 401 || status === 403;
```

`getAuthStatus()` (`:209-214`) and `withAuthRetry()` (`:497-503`) both react by calling
`tokenStore.clear()`. `wrapApiError()` (`:428-435`) maps the same condition to `NOT_AUTHENTICATED`
with the remediation "Call gh_auth_signin to refresh the token." And `withAuthRetry` **never
retries** despite its name and its doc comment at `:487-490` — verified by execution: a mock whose
first `pulls.list` throws 401 and whose second would succeed produced 1 call and a
`NOT_AUTHENTICATED` error.

### 11.1 What each status actually means

| Status | Meaning | Distinguisher | May clear the credential? |
|---|---|---|---|
| **401** | credential invalid / revoked / expired | body `Bad credentials` | ✓ — but only after N consecutive failures (§2.8) |
| **403** | primary rate limit | `x-ratelimit-remaining: 0` | ✗ |
| **403 / 429** | secondary rate limit | body "You have exceeded a secondary rate limit"; `retry-after` **often absent** | ✗ |
| **403** | SAML SSO enforcement | `X-GitHub-SSO` header; body "Resource protected by organization SAML enforcement…" | ✗ |
| **403** | org IP allow list | body "Although you appear to have the correct authorization credentials, the *ORG* organization has an IP allow list enabled, and your IP address is not permitted to access this resource." | ✗ |
| **403** | insufficient permission | body `Resource not accessible by integration` / `…by personal access token`; `X-Accepted-GitHub-Permissions` | ✗ |
| **403** | installation suspended | suspension message | ✗ |
| **403** | write to an archived repo | body | ✗ |
| **404** | repo not in the installation grant | cross-check the cached installation repo list | ✗ |
| **404** | private resource the credential can't see | GitHub returns 404 instead of 403 "to avoid confirming the existence of private repositories" | ✗ |
| **404** | SSO-unauthorized credential (sometimes) | no header; indistinguishable | ✗ |
| **404** | genuinely absent | — | ✗ |
| **200** | **partial results** — orgs requiring SSO silently omitted | `X-GitHub-SSO: partial-results; organizations=…` | ✗ |

All **verified** except the IP-allowlist message string (**likely**, from
github/github-mcp-server#748 and semantic-release/github#767 plus GitHub's docs).

Three sharp edges:

- **GraphQL does not use 403 for IP-allowlist denial.** It returns **HTTP 200** with the message in
  the `errors` array as `"type": "FORBIDDEN"` (verified in cli/cli#12150). Do not gate GraphQL
  detection on a status code. Zeros makes two GraphQL calls (`github.ts:1147`, `:1467`).
- **Git over HTTPS has no JSON body and Git over SSH has no HTTP status at all.** The exact
  Git-side allow-list string is not documented by GitHub and is not reliably attested anywhere we
  looked (**unverified**). Transport-layer classification has to be string-matching on stderr, and
  today's classifier at `src/engine/git/ops.ts:127-139` (`/not authenticated|authentication
  failed|403|401/i`) matches **none** of git's actual no-credential strings — which is why the
  single most likely real-world failure surfaces as a bare `GIT_COMMAND_FAILED` with no
  remediation while Settings still shows a green "Connected to GitHub".
- A request with **absent or invalid** credentials to an IP-restricted resource gets a *different*
  403 whose body is an HTML page headed "Access to this site has been restricted." — not the
  quoted sentence. Match on the sentence, not on 403 + "restricted".

### 11.2 The classifier, as codes

The spec's split is right. Restating it as the complete set, with the distinguishers above:

| Code | Trigger | Destructive? |
|---|---|---|
| `isCredentialInvalid` → clear | 401, or 403 whose `response.data.message` matches `/bad credentials\|token.*(expired\|revoked)/` | **the only destructive path** |
| `GITHUB_RATE_LIMITED` | 403/429 with `x-ratelimit-remaining: 0` or a `retry-after` header | no |
| `GITHUB_SSO_REQUIRED` | 403 carrying `x-github-sso`, **or** 200 carrying `partial-results` | no |
| `GITHUB_FORBIDDEN_SCOPE` | "Resource not accessible by…" | no |
| `GITHUB_REPO_NOT_INSTALLED` | 404 on a repo the local remote clearly points at, absent from the installation repo list | no |
| `GITHUB_IP_BLOCKED` | the IP-allow-list sentence (REST 403 **or** GraphQL 200 + `FORBIDDEN`) | no |
| `GITHUB_INSTALLATION_SUSPENDED` | 403 + suspension message | no |
| `GITHUB_INSTALLATION_DELETED` | 404 on `POST /app/installations/{id}/access_tokens` (backend-side) | no |

**Only `isCredentialInvalid` may call `tokenStore.clear()`.** This is a hard prerequisite for the
App, not a nicety: per-repo installation scoping produces 403s and 404s as *normal operation*.

Note the current damage runs through **two** independent routes, not one — the engine store →
`GITHUB_TOKEN_CHANGED` → `gh_token_clear` path (`src/engine/git/engine-token-store.ts:50-58`,
`src/engine/index.ts:1109-1117`), **and** Electron main's own safeStorage-backed `getAuthStatus`
(`electron/ipc/commands/github.ts:54`, which calls the same `getAuthStatus()` in main's copy of the
module). Both must be fixed; fixing one leaves the other.

### 11.3 SAML SSO in full

The single most user-hostile failure class found in the whole audit.

**Three failure shapes, not one** (**verified**,
[troubleshooting the REST API](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api) +
[enforcing SAML SSO](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-saml-single-sign-on-for-your-organization/enforcing-saml-single-sign-on-for-your-organization)):

1. **403** — carries `X-GitHub-SSO` with an authorization URL. Body, verbatim, one sentence:
   "Resource protected by organization SAML enforcement. You must grant your OAuth token access to
   this organization." (the second clause reads "your Personal Access token" for PAT credentials).
   The URL **expires after one hour** — so mint it at click time, not at render time.
2. **404** — "you may receive a 404 Not Found or a 403 Forbidden error". No header, no
   distinguisher.
3. **200 with silently missing data** — "If you requested data that could come from multiple
   organizations, the API will not return results from the organizations that require SAML SSO."
   The header is `X-GitHub-SSO: partial-results; organizations=21955855,20582480` — numeric org
   **IDs**, which must be resolved to names before they can appear in UI copy.

**`X-GitHub-SSO` has two forms and GitHub's own docs are self-contradictory about them.** The only
officially *exemplified* form is `partial-results; organizations=<ids>` on a 200. The prose also
says "you can follow the URL in the X-GitHub-SSO header" for 403s and that "the URL expires after
one hour" — but gives no example. That contradiction was filed as
[github/docs#31661](https://github.com/github/docs/issues/31661) and closed via PR #32002.
**Parse defensively for both shapes, and do not assume the header only appears on 403.**

This directly threatens Zeros' `listGithubOwners()` and any repo picker: a user's work org can be
**absent from a successful response**, which under the repo's keyed-read semantics gets cached as a
valid confirmed snapshot. The owners list must inspect `X-GitHub-SSO` on every response and render
an inline "N organizations hidden — authorize SSO" affordance rather than a clean, wrong, empty list.

**Credential-type differences** (**verified**):

| Credential | SSO behaviour |
|---|---|
| Classic PAT | must be **individually authorized per org after creation** |
| Fine-grained PAT | "authorized during token creation, before access to the organization is granted" — but requires an active SAML session *at creation time*, and may still sit pending org-owner approval |
| SSH keys | also subject to authorization, and the "Authorize" button **is not shown proactively** — "GitHub will only prompt you to authorize a key/token after an access attempt" (**likely**) |
| GitHub App user token | credential authorization is minted **at app sign-in time**, per org, and is "tied to the specific sign-in session with the app" |
| Installation token | **not documented** (§7.4) |

**Moving to an App does not eliminate the SAML class of bugs — it moves them to the authorization
leg.** Two concrete manifestations:

- Install/request: "If your organization or enterprise uses SSO, you may not see your organization
  listed when you try to install or request an GitHub App for your organization." No error — the
  org is simply absent. Remedy: start an active session at `https://github.com/orgs/ORG/sso`, then
  retry. The App-mode install flow needs an explicit **"don't see your organization?"** affordance.
- Authorize: after authorizing without an active SAML session, org resources are invisible, and
  **starting a session alone does not fix it**. The documented fix is start the SSO session →
  **revoke** the app's existing authorization (Settings → Applications → Authorized GitHub Apps) →
  **reauthorize**, because the credential authorization is minted at sign-in and an already-issued
  one does not retroactively pick up a new session. HashiCorp documents exactly this for HCP
  Terraform's GitHub App VCS connection (updated 2025-05-02): it "appears to hang which then fails
  without displaying any error messages"; the browser sees a 304 and only backend logs show the 403
  (**likely**).

So Zeros needs a **"Reconnect / re-authorize"** action that walks the user through revoke-then-
reauthorize. A plain retry with the same authorization keeps failing, and a silent token refresh
will never fix SSO-invisible org resources.

Two URLs worth surfacing: `https://github.com/orgs/ORG/sso` per org, and
`https://github.com/enterprises/ENTERPRISE-NAME/sso`, which covers **every** org in the enterprise
the user belongs to — generally the better one for a user in many orgs (**verified**).

One over-claim to avoid: "after an owner enables SSO, previously authorized apps **must** be
reauthorized" is not supported. The docs say authorizations "**may need to** be revoked and
reauthorized before they can access the organization" (**verified** correction).

### 11.4 Org install approval

The install page shows one of **three** buttons depending on how much of the requested access needs
owner approval (**verified**,
[installing from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)):

| Button | Condition |
|---|---|
| **Install** | no approval needed |
| **Install and request** | some access needs approval |
| **Request** | all access needs approval |

Org members and outside collaborators who cannot install can still *select* the org; GitHub then
notifies the org owner rather than installing.

The correlation problem, and it is a real one (**verified**): when approval is required, GitHub
redirects to the App's **setup URL** with `setup_action=request` and **no `installation_id`** and no
request identifier, and **`state` is not preserved on the approval path**. So the backend callback
cannot correlate a pending request back to the initiating user from the callback alone. It must
**persist a pre-install record keyed by the Zeros user id before redirecting**, then reconcile later
by polling `GET /user/installations` for that user.

And separately: **never trust `installation_id` from the redirect.** GitHub's own
[setup-URL doc](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
warns it can be spoofed — "bad actors can hit this URL with a spoofed `installation_id`, so you
should not rely on the validity of the `installation_id` parameter". Re-derive it from a user access
token, or verify server-side with the App JWT (`GET /app/installations/:id`), and bind the flow with
a `state` nonce tied to the signed-in backend session before persisting anything.

One documented silent failure to design around (**likely**, community #170852, reported 2025-08-24,
still unanswered): a non-owner requesting an app with elevated repo permissions sees "The
installation tab disappears entirely with no message, no error, and no indication that organization
owner approval is required." Zeros cannot rely on GitHub's UI to explain the block. Whenever an
install attempt returns without an installation for the target org, render an explainer plus a
copyable "ask your org owner to approve" link.

### 11.5 Webhooks are optional, and are not truth

A webhook endpoint is genuinely optional. At registration: "Optionally, if you do not want your app
to receive webhook events, deselect **Active**. For example, if your app will only be used for
authentication or does not need to respond to webhooks, deselect this option" — one consecutive
sentence, and Webhook URL / secret / SSL verification / event subscriptions are all conditional on
Active (**verified**).

The App-only lifecycle events, with their **event-level** descriptions (the commonly-quoted
sentences are *action*-level, a distinction that matters when you write the handler):

| Event | Event-level description | Actions |
|---|---|---|
| `installation` | "activity relating to a GitHub App installation. All GitHub Apps receive this event by default. You cannot manually subscribe to this event." | created, deleted, new_permissions_accepted, suspend, unsuspend |
| `installation_repositories` | "activity relating to which repositories a GitHub App installation can access." | added, removed |
| `installation_target` | "activity relating to the user or organization account that a GitHub App is installed on." | renamed |
| `github_app_authorization` | "occurs when a user revokes their authorization of a GitHub App." Received by default, **cannot unsubscribe**. | revoked |

All **verified**. Also: "GitHub Apps have built-in, centralized webhooks… OAuth apps must configure
webhooks individually for each repository and organization" — but **enterprise-level installations
cannot subscribe to webhooks at all** and need a separate enterprise webhook subscription.

Do **not** treat webhooks as the only truth: there are reports of `installation_repositories` not
firing as expected on install (community #193487, **verified** as a report), and repo deletion emits
both `installation_repositories.removed` and `repository.deleted`. The polling endpoints
(`GET /user/installations`, `GET /user/installations/{id}/repositories`,
`GET /installation/repositories`) are non-deprecated and confirmed present in GitHub's OpenAPI
description as of July 2026. GitHub's own best-practices doc recommends webhooks over polling
because of the request budget — so a webhookless v1 must **budget** its polling, not poll freely.

The spec's phase-1 answer (poll on settings open and on 403; add webhooks in phase 2) is sound. The
one event worth wanting early is `github_app_authorization`, because it is how you learn you were
revoked instead of discovering it on next use.

### 11.6 The in-app fix that avoids a browser bounce

The highest-leverage UX mechanic in this document: a repo can be added to an **existing**
installation via the API, with no browser trip.

```
PUT    /user/installations/{installation_id}/repositories/{repository_id}
DELETE /user/installations/{installation_id}/repositories/{repository_id}
```

Auth is a **user access token** (or a classic PAT with `repo`), and the authenticated user must have
**admin** access to the repository. `DELETE` returns **422** if it would remove all repository
access. **verified** ([REST installations](https://docs.github.com/en/rest/apps/installations)).

So when a user opens a workspace on a repo the installation doesn't cover, Zeros can offer
"Grant Zeros access to this repo" as a button that calls this endpoint with the user token it
already holds — falling back to the `/settings/installations/{id}` deep link only when the user
lacks repo-admin. That converts the single most common App-mode dead end into one click.

### 11.7 The lesson from every OAuth→App migration that has already happened

- **GitHub states flatly: "There is not a way to automatically migrate your users. Each user must
  install and/or authorize your GitHub App on their own."** Installing and authorizing are two
  separate user actions (**verified**). Existing Zeros users on `Ov23lityKSllg4mxOQCl` cannot be
  silently upgraded. Plan an explicit, dismissible in-app prompt; keep device flow working
  indefinitely; gate no existing feature on the App.
- **CircleCI's** transition (started Aug 2023, still generating support articles into 2026)
  produced: no in-place conversion, duplicate triggers and duplicate status checks when both
  integrations were live, a list of not-yet-supported features that migrating orgs called a
  dealbreaker, and OAuth-token revocation emails that caused CircleCI to "temporarily unfollow
  users from their projects", halting builds (**likely**). The transferable lesson: **never run two
  GitHub identities against the same repo simultaneously.** Zeros' three methods must be strictly
  exclusive per repo/remote — one selected method decides who authors PRs, comments and statuses.
  And say so in the UI, because switching methods changes the author of Zeros' comments in the
  permanent record.
- **Codecov** deprecated its 2015-era OAuth App with a March 2023 deadline; **Coveralls** maintains
  a dedicated `coverallsapp/migrate_to_github_app` repo. Both indicate a multi-quarter, user-by-user
  effort (**likely**). Budget for device flow and PAT to coexist with the App for **years**, and
  instrument which method each user actually selected so adoption is measurable before anyone
  proposes a deprecation.
- **GitHub tightens App auth semantics with limited notice.** The
  [2025-06-24 security update](https://github.blog/changelog/2025-06-24-security-updates-for-apps-and-api-access/)
  restricted "Signing into GitHub Apps and OAuth Apps that are private or owned by Enterprise
  Managed User (EMU) accounts … unless you are a member of the organization or enterprise that owns
  the application", and fixed a bug where a token authorized for one org could reach internal
  resources across the whole enterprise. Apps with 50+ external sign-ins in the prior year got a
  time-limited exemption by email (**verified**). Two consequences: **register the Zeros App as
  public and owned by the Zeros org from the start** (a private or EMU-owned app cannot be signed
  into from outside the owning org), and make the health readout surface **GitHub's actual error
  text** rather than a Zeros-authored paraphrase that can silently become wrong.

---

## 12. Rate limits — the numbers, and Zeros' actual burn rate

### 12.1 Primary limits

| Credential | Limit | GHEC-owned |
|---|---|---|
| unauthenticated | 60/hr | — |
| PAT (classic or fine-grained) | 5,000/hr | — |
| **GitHub App user token** | 5,000/hr — **shared** with every other app acting for that user *and* with the user's own PATs | 15,000/hr |
| **installation token** | 5,000/hr, scaling +50/repo >20 and +50/user >20 (org installs only), cap **12,500/hr** | flat **15,000/hr**, no scaling, no cap |
| enterprise-level installation | — | 15,000/hr + 10,000 GraphQL points/hr, separate budget |
| `GITHUB_TOKEN` in Actions | 1,000/hr per repository | 15,000/hr |
| OAuth client-credentials (public data) | 5,000/hr per client id, **not** shared with the user's limit | 15,000/hr |

**verified** ([REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
One note of caution on the scaling figures: they are correct as quoted, but GitHub's own
`rate-limits-for-github-apps` page now defers to the REST page, so **plan against 5,000/hr for a
small install and read `GET /rate_limit` at runtime** rather than hard-coding the bonus (**likely**).

### 12.2 Secondary limits

Independent of the primary budget, and the ones a fan-out client actually hits (**verified**):

- **No more than 100 concurrent requests**, shared across REST **and** GraphQL.
- **900 points/minute for REST** and, separately, **2,000 points/minute for GraphQL** — the point
  budgets are per-API, unlike the shared concurrency cap. GET/HEAD/OPTIONS and non-mutating GraphQL
  queries = 1 point; POST/PATCH/PUT/DELETE and GraphQL mutations = 5 points; some REST endpoints
  have undisclosed higher costs.
- **No more than 90 seconds of CPU time per 60 seconds of real time**, of which at most 60 s may be
  GraphQL.
- In general **80 content-generating requests/minute and 500/hour** — and these counts include
  actions taken through the **web UI**, not just the API.
- **No more than 2,000 OAuth access-token requests per hour per client id** — directly relevant to
  a device-flow-heavy design.
- Exceeding gives 403 or 429 with "You have exceeded a secondary rate limit."

GitHub states these limits are subject to change without notice and that you may be
secondary-rate-limited for undisclosed reasons. Multiple libraries report `Retry-After` is
frequently **absent** on secondary-limit responses despite the docs (hub4j/github-api#1805,
renovatebot/renovate#20601, community #56587) — so back off exponentially rather than depending on
the header.

### 12.3 Zeros' current burn rate

Measured against the code, for **one** active workspace with CI in flight:

| Lane | Fan-out | Period | Requests/hr |
|---|---|---|---|
| Review slow lane | 7 REST + 1 GraphQL | 60 s | ~480 |
| Review fast checks lane | 3 REST | 12 s | 900 |
| PR-status island | 4 REST | 60 s (floored) | 240 |
| **Total** | | | **~1,600/hr** |

(The slow lane is 7 REST + 1 GraphQL, not 8 REST: `getPr` 1 at `github.ts:1226-1231`, `getChecks` 3
at `:1335-1351`, `getPrCommits` 1 REST + 1 GraphQL at `:1457-1487`, `getPrReviews` 2 —
`pulls.listReviews` + `issues.listComments` — at `:1546-1562`. An eighth REST call appears only when
`mergeableState === "behind"`.)

Against a **shared** 5,000/hr user bucket, one workspace is already ~32% of the budget — before the
user's own agent CLIs, `gh`, Copilot, or any other authorized app spend a single request. With N
parallel worktrees the concurrency ceiling of 100 is trivially reachable too.

Zeros has **zero** rate-limit handling. Octokit is constructed bare — `new Octokit({ auth })` at
`src/engine/git/github.ts:132-134` — with neither `@octokit/plugin-throttling` nor
`@octokit/plugin-retry` in `package.json` (only `@octokit/auth-oauth-device` and `@octokit/rest`,
lines 102-103). Nothing in `src/engine` or `electron` reads `x-ratelimit-remaining`,
`x-ratelimit-reset` or `retry-after`.

### 12.4 The free fix

> "Making a conditional request does not count against your primary rate limit if a 304 response is
> returned and the request was made while correctly authorized with an Authorization header."

**verified** ([best practices](https://docs.github.com/rest/guides/best-practices-for-using-the-rest-api)).
Most endpoints return `etag`; many return `last-modified`.

The calibration datapoint from a directly comparable desktop client: **Gitify** (GitHub
notifications tray app) at a 60-second poll with 2 accounts × 3 pages issued **360 requests/hour**
and ~36 MB/hour, all counted; with conditional requests that drops to effectively **0 counted
requests/hour and ~120 KB/hour** (gitify-app/gitify#2303, opened 2025-10-15, closed as not planned)
(**likely**). 360/hr is already ~7% of a shared bucket for one trivial feature. Zeros' per-PR
fan-out is 4× heavier.

Storing the ETag alongside every cached read and sending `If-None-Match` turns the rate limit from
a design constraint into a non-issue, and a 304 maps exactly onto the repo's existing
"retain the last confirmed exact-key snapshot while revalidating" read-cache contract. It should be
non-negotiable in the engine's Octokit wrapper, together with a global in-flight cap well under
100 and a points-per-minute budgeter.

One adjacent efficiency note, since it is free: `getPrChecks` re-fetches the whole PR solely to read
`head.sha` (`github.ts:1335-1338`), and the island fires `ghPrGet` and `ghPrChecks` concurrently in
one `Promise.allSettled` (`src/shell/pr/pr-status-island.tsx:380-384`). Every island refresh
therefore issues **two identical `pulls.get` calls** — 1 of 4 REST calls, 25% waste; the Review
full snapshot does the same at 1 of 8. Accept an optional `headSha` parameter, or add a short
per-`owner/repo#pr` in-flight coalescing map.

---

## 13. GHES, GHE.com, and why "the Zeros GitHub App" cannot be one identity

### 13.1 Host-relative endpoints

GitHub Enterprise Server uses the same flows at host-relative paths (**verified**,
[GHES 3.20 user access tokens](https://docs.github.com/en/enterprise-server@3.20/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)):

| Purpose | github.com | GHES |
|---|---|---|
| authorize | `https://github.com/login/oauth/authorize` | `http(s)://HOSTNAME/login/oauth/authorize` |
| token | `https://github.com/login/oauth/access_token` | `http(s)://HOSTNAME/login/oauth/access_token` |
| device code | `https://github.com/login/device/code` | `http(s)://HOSTNAME/login/device/code` |
| device entry | `https://github.com/login/device` | `http(s)://HOSTNAME/login/device` |
| REST | `https://api.github.com` | `http(s)://HOSTNAME/api/v3` |
| GraphQL | `https://api.github.com/graphql` | `http(s)://HOSTNAME/api/graphql` |

GHES 3.20 (GA 2026-03-17) supports device flow — but only after the app owner ticks **Enable Device
Flow**, off by default. User-to-server token expiration exists on 3.20 and is **opt-out**, not
opt-in: "When you create your app, expiration of user access tokens is enabled unless you opt out"
(8 h + 6 mo). Cite GHES 3.20 "Getting started with the REST API" for `/api/v3`; the
endpoints-available page does not document it.

**GitHub Enterprise Cloud with data residency** replaces `https://api.github.com` with
`https://api.SUBDOMAIN.ghe.com`, puts web/OAuth/device endpoints under `SUBDOMAIN.ghe.com`, and adds
`auth.ghe.com` as a non-tenant-scoped authentication hostname that must be allow-listed alongside
`*.SUBDOMAIN.ghe.com`, `*.githubassets.com` and `*.githubusercontent.com`. One allow-list gotcha:
some GHE.com flows (e.g. the Azure/Entra connection flow) still round-trip through
`https://github.com/enterprises/oauth_callback`, so **`github.com` cannot be fully blocked**
(**verified**, [GHE.com network details](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/network-details-for-ghecom)).

Also: the "Only on this account" / "Any account" install-scope options apply to github.com; under
GHEC with Enterprise Managed Users, "Only on this account" is disabled for user accounts and
"Any account" reads "This enterprise".

### 13.2 An App registered on github.com does not exist on a customer's GHES

GHES organizations "cannot install GitHub Apps registered on GitHub.com or on another GitHub
Enterprise Server instance" — each instance needs its own registration, typically via the **App
manifest flow** (`/settings/apps/new?state=…` + manifest POST) since Marketplace is unavailable on
GHES (and on GHE.com data residency). GHES 3.17 (GA 2025-06-03) added enterprise accounts as App
owners, with enterprise-owned permission updates auto-accepted by installed orgs — but **App
manifests are not available for enterprise-owned apps**. **likely**
([GHES availability doc](https://docs.github.com/en/apps/sharing-github-apps/making-your-github-app-available-for-github-enterprise-server)).

So "Zeros GitHub App" cannot be a single global identity. Two consequences the spec already
anticipates and one it does not:

- Anticipated: the App variant list is `{key, label, clientId, appSlug, hostname}[]`, mirroring
  Conductor's `{ key, label, clientId, appSlug }` array — which our teardown found in their
  runtime binary, with `ghe_hostname` / `ghe_app_slug` appearing as first-class protobuf fields
  rather than error strings. Multiple App variants from day one means GHE is a config row, not a
  code fork.
- Anticipated: no GHES App is registered in phase 1, so GHES users fall back to PAT / gh CLI.
- **Not** anticipated: for a GHES customer to use App mode at all, an admin must register a
  per-instance App and Zeros must store `{instanceUrl, appId, clientId, privateKey}` — i.e. a
  **manifest-registration wizard** and a place to keep a customer's private key. That is a
  materially different product surface from "add a config row", and it should be named as
  out-of-scope explicitly rather than implied by the variant list.

The generalisation this argues for is the same one GitLab and Bitbucket will need: persist the auth
record as `{provider, hostUrl, method, credentials}` from day one, at the
`resolveReviewProvider(originHost)` seam in `src/shell/pr/review-provider.ts`. That function
currently ignores its parameter and always returns the GitHub provider
(`src/shell/pr/review-provider.ts:78-80`), and both production call sites pass no argument at all —
so the seam exists in shape only. Conductor's naming precedent is `gitForge` with a `hostname`
field already present, `"github" | "local-git"` today (first-hand teardown of the sandbox-creation
payload) — a good name for the Zeros equivalent.

One repo-level blocker for any second host: `repoSlugFromOriginUrl` (`src/engine/git/repo.ts:29`,
doc comment at `:22-28`) deliberately drops the host — "We intentionally drop the host so worktrees for the same logical
project don't fragment if the user re-clones via SSH after HTTPS" — and `repo_slug` is the workspace
partition key throughout the DB and the renderer cache. It is not specifically a *cross-forge* bug:
`github.com/acme/widgets` and a self-hosted `github.acme.com/acme/widgets` collide just as
`gitlab.com/acme/widgets` would, and two separate clones of the same remote also share a slug. That
must be resolved before a second host exists, and it is a GHES problem before it is a GitLab problem.

---

## 14. The URL table

Every GitHub URL an implementation needs, with the failure each wrong choice causes. All
**verified** ([sharing your GitHub App](https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app),
[reviewing installed apps](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps)).

| Purpose | URL | Note |
|---|---|---|
| First-time install | `https://github.com/apps/{slug}/installations/new` | accepts `?state=` to "correlate an installation to a user or account" |
| Account picker | `https://github.com/apps/{slug}/installations/select_target` | in use for account-picker flows |
| **Re-scope an existing** install (personal) | `https://github.com/settings/installations/{installation_id}` | lands on the repo-selection screen for the *existing* install |
| **Re-scope an existing** install (org) | `https://github.com/organizations/{org}/settings/installations/{installation_id}` | same |
| Start an SSO session (org) | `https://github.com/orgs/{ORG}/sso` | one org |
| Start an SSO session (enterprise) | `https://github.com/enterprises/{ENTERPRISE}/sso` | every org in the enterprise — usually the better link |
| Org app policy | `https://github.com/organizations/{org}/settings/oauth_application_policy` | the "ask your owner" link |
| Revoke an app authorization | Settings → Applications → Authorized GitHub Apps | required for the SSO re-auth dance (§11.3) |
| GHES install | `https://HOSTNAME/github-apps/{slug}/installations/new` | **different path shape** |
| GHE.com install | github.com shape, under the tenant host | misdetecting this shipped as a 404 bug in Coolify (#10573) |
| GHES app registration | `https://HOSTNAME/settings/apps/new?state=…` + manifest POST | no Marketplace on GHES |

**Using the wrong one of the first three is the most common self-inflicted wound**: sending a user
with an existing installation to `/apps/{slug}/installations/new` creates a **second, duplicate
install** instead of widening the first. Build these from a host-aware helper sitting beside
`resolveReviewProvider(originHost)`, not as string literals at call sites.

Note also what Conductor does here, and copy it: **the backend returns `installUrl`** rather than
the client constructing it (`{ installUrl }` is a discrete schema in their runtime binary,
first-hand teardown). That keeps slug, host shape and `state` binding in one server-side place.

---

## 15. The whole thing as one diagram

```mermaid
flowchart TD
  subgraph MAC["Mac — Zeros desktop"]
    PICK["Settings: authMethod<br/>gh-cli | zeros-app | pat"]
    SS["safeStorage<br/>github.app.userToken (8h)<br/>github.app.refreshToken (6mo)<br/>github.pat"]
    BROKER["credential broker<br/>unix socket + PATH shims<br/>GIT_TERMINAL_PROMPT=0"]
    GIT["git / gh child processes<br/>engine + agent PTY"]
  end

  subgraph BE["backend/ — holds BOTH secrets"]
    CS["client_secret<br/>→ code exchange, refresh"]
    PK["App private key<br/>→ RS256 JWT (exp ≤ 10 min)"]
  end

  subgraph GH["GitHub"]
    AUTHZ["/login/oauth/authorize<br/>PKCE S256, optional"]
    TOK["/login/oauth/access_token<br/>client_secret REQUIRED<br/>(except device flow)"]
    MINT["POST /app/installations/:id/access_tokens<br/>1 hour · repository_ids ≤ 500 · permissions ⊆ grant"]
    XPORT["git over HTTPS<br/>x-access-token:TOKEN"]
  end

  SBX["cloud sandbox<br/>same broker, /zeros/bin<br/>never a PAT, never the private key"]

  PICK -->|"zeros-app"| AUTHZ
  AUTHZ -->|"code + state, system browser only<br/>RFC 8252 §8.12"| CS
  CS --> TOK
  TOK -->|"ghu_ 8h + ghr_ 6mo"| SS
  SS -->|"T−60s / on 401"| CS
  PK --> MINT
  MINT -->|"ghs_ 1h, ~520 chars, opaque"| SBX
  SS --> BROKER
  PICK -->|"gh-cli → gh auth git-credential"| BROKER
  PICK -->|"pat"| BROKER
  BROKER --> GIT --> XPORT
  SBX --> XPORT

  style MINT fill:#1f6feb,color:#fff
  style TOK fill:#8957e5,color:#fff
  style MAC fill:#0d1117,color:#e6edf3
```

The two purple/blue nodes are the two places a secret is unavoidable, and they are both server-side.
Everything else is plumbing.

---

## 16. Storage: what safeStorage does and does not promise

Relevant because §3 puts a refresh token on the Mac for six months, and the security section of any
design doc must not over-claim.

`electron/secret-store.ts:133-158` uses Electron `safeStorage`, which delegates to Chromium's
OSCrypt. On macOS and Linux that is **AES-128-CBC (unauthenticated)** with the IV hardcoded to 16
space characters — verbatim `kFixedIvForAes128Cbc` in
`components/os_crypt/async/common/encryptor.cc` — so **identical plaintext yields identical
ciphertext under the same key** (**verified**).

Two corrections to the commonly-quoted version of this:

1. On macOS the Keychain item (service `<AppName> Safe Storage`, account `<AppName>`; Electron sets
   these in `shell/browser/electron_browser_main_parts.cc:564-565`) stores a **password**, not the
   AES key: `base::Base64Encode(base::RandBytesAsVector(16))` — a 24-char ASCII string with 128 bits
   of entropy. The AES-128 key is derived via PBKDF2-HMAC-SHA1, fixed salt `"saltysalt"`, **1003
   iterations**. Protection is macOS's default per-item Keychain access control for the creating
   code-signed app, not an explicitly constructed ACL.
2. "Not AES-256, not GCM" is true only of the **synchronous** API and of the macOS/Linux async
   providers. Electron's docs now recommend `encryptStringAsync`/`decryptStringAsync` and state the
   synchronous API "may be deprecated in a future version"; on **Windows** the async DPAPI provider
   yields `kAES256GCM` with a fresh random 12-byte nonce (authenticated, non-deterministic). macOS
   still yields AES-128-CBC with the fixed IV on **both** paths.

Electron's own doc sentences are verbatim current: on macOS "Encryption keys are stored for your app
in Keychain Access in a way that prevents other applications from loading them without user
override"; on Linux, "If no secret store is available, items stored in using the safeStorage API
will be unprotected as they are encrypted via hardcoded plaintext password" — that `basic_text`
fallback is `PBKDF2-HMAC-SHA1(1 iteration, key="peanuts", salt="saltysalt")`, detectable via
`getSelectedStorageBackend() === 'basic_text'`.

The consequential limit is that **the guarantee is inter-app, not intra-app**: "child processes of
the same app, dynamically loaded libraries, and injected code are all treated as the app itself, and
won't trigger the authorization prompt", so "an Electron app poisoned by a malicious npm package can
call safeStorage to decrypt its own keys after launch, and the OS won't say a word" (**likely**).

Three design consequences, all of which the spec's shape already satisfies:

1. On-disk `secrets.json` is **confidentiality-only, not integrity-protected**. Do not treat a
   successful decrypt as proof the value was not tampered with, and do not store anything where
   ciphertext equality leaks information.
2. **Prefer short-lived credentials** precisely *because* storage cannot be made airtight. An 8-hour
   user token and a 1-hour installation token are a better answer than a hardened vault for a PAT
   that never expires.
3. Say this out loud in the security section rather than implying safeStorage is a vault. Keeping
   the token out of the **renderer** is genuinely valuable — and note that today it is not:
   `GITHUB_TOKEN_CHANGED` broadcasts the **raw token value** to every local client
   (`src/engine/index.ts:1109-1117` ← `src/engine/git/engine-token-store.ts:50-53`, which fires
   `onChange(token)` on every `set()`, not only on clear), and the renderer's WebSocket client is a
   local client. The App method makes this worse, not better, because rotation means the value is
   broadcast every 8 hours instead of once.

Also relevant to §2.3: `ZEROS_GITHUB_TOKEN` is injected into the engine's spawn env
(`electron/sidecar.ts:1195`) and `buildPtyEnv` copies the engine's whole `process.env` for local
shells (`src/engine/pty/shell-setup.ts:175`), deleting only `TERM_*`/`ZEROS_PTY_*`/
`ELECTRON_RUN_AS_NODE`/`OLDPWD`. So the plaintext credential currently reaches every terminal and
every agent subprocess — where `gh` cannot even read it, since `gh` looks for `GH_TOKEN`/
`GITHUB_TOKEN`. A leak with no upside. Setup scripts, by contrast, *are* scrubbed by a 12-name
allowlist whose comment names the token explicitly (`src/engine/git/setup-hooks.ts:144-158`).

---

## 17. What we could not establish

Stated plainly, because each of these is a decision input:

1. **Whether installation access tokens are subject to per-user SAML SSO authorization.** Not
   documented either way (§7.4). This is the load-bearing unknown for cloud workspaces in
   SSO-enforced orgs. Test against a real SAML-enforced org before committing.
2. **Whether `Pull requests: write` alone permits commenting on a pull request**, or whether
   `Issues: write` is required (§10.2). Determines whether the App registration needs an `Issues`
   permission that the current spec omits.
3. **The exact permission required to create a repository** via `repos.createInOrg` /
   `repos.createForAuthenticatedUser` under a GitHub App (§10.2). Determines whether
   "Publish to GitHub" works at all under App mode.
4. **Whether GitHub genuinely accepts an arbitrary ephemeral loopback port** against a registered
   portless callback (§9.2). Three independent sources say yes and one doc sentence reads the other
   way; we resolved it in favour of yes, but it is worth a five-minute live test before writing the
   listener.
5. **Whether a device-flow-derived refresh really needs no client secret** (§7.3). The docs' carve-out
   is verbatim, but we found no second source and no empirical confirmation. It decides whether
   `backend/` sits on the hot path of every 8-hour rollover.
6. **macOS Launch Services' tie-breaking rule for duplicate URL schemes.** Apple documents it as
   undefined; third-party analysis describes deterministic heuristics but no authoritative rule
   exists. Therefore it cannot be a security boundary — which is itself the actionable conclusion.
7. **The Git-over-HTTPS error string for an IP-allow-list denial.** Not documented by GitHub, not
   reliably attested in first-hand sources. Any transport-layer classifier for that case will be
   guesswork until someone reproduces it.
8. **The body of the 2026-05-15 per-request installation-token override changelog.** We read the
   headline only. It may simplify multi-installation token minting.
9. **The Zeros App's own numbers** — slug, permission set as actually registered, and the callback
   URL — because the App does not exist yet. Conductor's equivalents were also unobtainable: their
   `appSlug` values are server-supplied and no `github.com/apps/<slug>` URL appears in plaintext in
   either binary.

## 18. Notes for part 10 — evidence that pushes against the spec

Per the brief, these are flagged rather than quietly reconciled. None of them changes the spec's
core decision; three of them change what must be built.

1. **The App permission table is incomplete.** Missing `Issues` (PR comments — the Review timeline
   and every comment Zeros posts) and a repository-creation permission ("Publish to GitHub").
   §10.2. Both need an empirical check, and the second may be better resolved by declaring
   Publish-to-GitHub out of scope for App mode than by requesting `Administration: write` on the
   consent screen.
2. **Log redaction is a Phase 0 blocker, not a follow-up.** The spec's Phase 0 lists six blockers;
   `packages/core/src/scrub.ts:75,81` failing on `ghs_APPID_JWT` should be a seventh, because the
   first installation token minted is the first one logged in plaintext. Conductor shipped this fix
   in 0.76.1 *after* their App had been live for a year. §2.3.
3. **The `zeros://` callback must be channel-aware, and will not work in `pnpm electron:dev` on
   macOS.** Zeros registers four schemes (`zeros`, `zeros-beta`, `zeros-alpha`, `zeros-dev`,
   `src/engine/runtime.ts:168-179`). A backend redirect that hardcodes `zeros://` routes a Beta
   user's sign-in into the stable app. §9.4. This is a concrete argument for the loopback listener
   the spec keeps as an alternative — it behaves identically in dev and prod and needs no Info.plist.
4. **"Loopback vs private-use scheme" should not be argued on security grounds in either
   direction.** The spec's reading of RFC 8252 §7 is correct — the RFC does not rank loopback above
   private-use schemes, and Appendix B.4 does call private-use "a good redirect URI choice on
   macOS". But `draft-ietf-oauth-v2-1-15` (March 2026) *does* draw that ranking, and PKCE defeats
   neither option's real attack (client impersonation, §8.3). The honest framing is: both are
   non-verifiable callbacks, the mitigation is that the scheme carries only a single-use nonce, and
   the tiebreak is maintenance (loopback works in dev) not security.
5. **One internal date conflict in the evidence base**, noted for completeness: Bitbucket app-password
   removal is given as 2026-07-28 by the spec and 2026-06-09 by a second source in the same evidence
   set. Immaterial to GitHub mechanics; material to whichever section owns Bitbucket. §6.4.
6. **A rate-limit claim in the spec's supporting material is overstated.** "App mode is the only
   path that gets a private, scaling budget — worth surfacing as a real user benefit" is true only
   of **installation** tokens. The App's **user** token shares the same 5,000/hr bucket as a PAT and
   as every other app acting for that user. Do not put "higher rate limits" in the App radio's copy
   for the desktop path. §12.1.
7. **`withAuthRetry` is a documentation defect, not just a behavioural one.** Its comment describes a
   one-shot 401 retry that has never existed (present since the initial commit). Under the App this
   function is exactly where credential refresh belongs, so the fix is not "rename it" — it is
   "implement `refreshCredential()` behind it", with an idempotency guard, because
   `pulls.create` / `issues.createComment` / `pulls.merge` all flow through it and none is
   idempotent. §11.
8. **One thing the spec asserts that we could not confirm and could not refute:** that installation
   tokens work in SSO-enforced orgs without per-user authorization. It is the foundation of the
   cloud-workspace story and it is undocumented. It belongs in the risk register with an owner and a
   test, not in the design as an assumption. §7.4.
