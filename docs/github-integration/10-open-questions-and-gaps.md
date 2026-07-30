# Open Questions and Gaps

*Part 10 of the Zeros GitHub Integration Report · July 2026*

## The short version

- **Six decisions need a founder, not an engineer.** The load-bearing one is whether
  `backend/` is allowed on the GitHub auth path at all — because GitHub's protocol forces it,
  and README.md currently promises the opposite.
- **The design panel and the report critics were cut for time.** Part 04 is therefore one
  author's synthesis of a strong evidence base, not a panel consensus, and nobody adversarial
  has re-read it. That is the single biggest process gap in this report.
- **No vendor publishes its GitHub App permission set** — not Conductor, not Cursor, not
  Devin. Our permission list is derived from what the API calls require, not from copying a
  competitor.
- **The three-method picker itself is a product decision, not a verified competitor fact.**
  The claim that Conductor ships an explicit user-selected credential rather than a
  precedence chain was **refuted** during verification. What survived is structural: they
  persist the method *with* the credential.
- **Seven GitHub behaviours we could not settle from documentation** are listed in §3, each
  one a decision input. Four are answerable in an afternoon with a real GitHub App and a real
  SAML-enforced org.
- **57 of 109 audit findings were killed.** §5 walks through the most instructive ones,
  because how aggressively a claim gets refuted tells you how much to trust the ones that
  survived.
- **Several sections disagreed with the spec they were given, and were right.** Those
  corrections are consolidated in §6 and should be folded into part 04 before anyone builds
  from it.

---

## 1. Decisions that need a founder

Each of these was reached by one author from the evidence. Each has a real cost if decided
the other way.

### Q-A · Is `backend/` allowed on the GitHub auth path?

**Recommendation: yes, with honest disclosure in the same PR.**

This is not a preference. GitHub documents `client_secret` as **required** on
`POST /login/oauth/access_token` for the authorization-code flow, for GitHub Apps and OAuth
Apps alike, **even when PKCE is used** — and states plainly that it "is not requiring PKCE
for any authentication flow at this time, as GitHub does not distinguish between public and
confidential clients". Refreshing an 8-hour user token needs the secret too. Minting an
installation token needs the App **private key**. None of those can live in a desktop binary.

The cost is that [README.md](../../README.md) says "Agent credentials stay on your machine;
Zeros never hosts them", and [CONTRIBUTING.md](../../CONTRIBUTING.md) and
[SECURITY.md](../../SECURITY.md) carry the same posture. Under the App method that stops
being true in a specific, limited way: the *exchange* and the *refresh* pass through
`api.zeros.build`, and the backend can mint tokens for repositories the user granted. The
token still lands on the Mac; the secret never leaves the server.

**Do not let the docs quietly become untrue.** If this ships, README.md and SECURITY.md are
edited in the same PR, and the settings UI says which method involves Zeros' servers and
which does not. The `gh CLI` and `PAT` rows genuinely never touch our backend — that is a
real, disclosable difference and it is worth stating in the UI, not just in a doc.

*What would change this:* if GitHub shipped a true public-client flow (PKCE without a
secret), the App method could be fully local and the backend would be needed only for cloud
sandbox minting. Worth re-checking annually.

### Q-B · Public or private GitHub App?

**Recommendation: public.** Conductor's `conductor-build` renders "Conductor.build is a
private GitHub App" on github.com (**verified**, re-confirmed live July 2026), and per
GitHub's own docs a private App can only be installed on the account that owns it. That is
consistent with Conductor driving installation from inside the desktop app rather than from a
Marketplace listing — but it is not a model Zeros can copy, because Zeros needs arbitrary
users and orgs to install. Public also means the App page carries our description and
privacy link, which is the thing a security-conscious org reviewer will read.

*Cost of getting it wrong:* a private App would block every external user at installation
time, and switching private→public later is possible but the App page URL and any
screenshots in support docs churn.

### Q-C · May a PAT be used for a cloud sandbox?

**Recommendation: no. Reject outright.**

A PAT is long-lived, broadly scoped, and unrevocable-per-repository. Putting one in a rented
VM means a sandbox compromise costs the user every repository they can reach, for as long as
the token lives. Vercel's own guidance recommends **GitHub App installation tokens for
multi-tenant platforms** and reserves fine-grained PATs for individual developers
(**verified**). Claude Code goes further and keeps GitHub credentials out of the sandbox
entirely, proxying all GitHub operations.

Offer the App, or run the workspace locally. If a user insists, the honest answer is a
*fine-grained* PAT scoped to one repository — but do not build that path in phase 3.

### Q-D · Bundle the `gh` binary, as Conductor does?

**Recommendation: no.** Conductor ships the real 53 MB GitHub CLI at
`Resources/bin/gh` (**verified**, first-hand), which deletes the "GitHub CLI not found"
branch entirely. But once the broker exists, Zeros needs `gh` for exactly one method the user
explicitly chose. The DMG cost is real and permanent.

Instead, fix the copy: `src/zeros/panels/github-section.tsx:225-227` currently tells users
"GitHub CLI not found" in situations where that is not what was detected. Make the gh-CLI row
honestly unavailable with an install link.

*Revisit if* sandboxes need `gh` for agent workflows — there the calculus differs, because a
sandbox image is ours to control and 53 MB in a container is cheaper than 53 MB in a
notarised DMG.

### Q-E · Ship a credential proxy that keeps tokens out of the sandbox entirely?

**Recommendation: not in phase 3.** Claude Code's cloud sessions route all GitHub operations
through a proxy so real credentials never enter the session (**verified**). That is a
strictly stronger posture than a scoped 1-hour token. But part 05 found that sandbox
providers now ship native secret plumbing, so the honest phase-3 entry is *"spike the
provider's proxy for git-over-HTTPS, then decide build-vs-configure"* — not *"build a
proxy"*. Do the spike; do not commit to building.

### Q-F · Whose identity does a shared cloud workspace act as?

**Recommendation: the workspace creator's** installation and `gitIdentity`, recorded in the
workspace row and surfaced in the UI. It is the only choice that is auditable after the fact.

This is genuinely unresolved upstream too — `docs/cloud-workspace/08-engineering-reference.md:476`
explicitly leaves it open ("decide whose token the box acts as"). Revisit when workspace
sharing actually ships, not before.

Twelve further engineering-level questions (callback mechanism, `repoSlug` rewrite, audit-row
schema, one App or one per channel, webhooks in 2 or 2b, and the rest) are in
[part 09 §12](09-implementation-plan.md), each with a recommendation.

---

## 2. What this report does not cover

Stated so nobody assumes silence means "handled".

- **GHES beyond the variant design.** Part 04 specifies a
  `{key, label, clientId, appSlug, hostname, apiBaseUrl}[]` App-variant list so a second
  registration is a config row. No GHES App is registered, and an App registered on
  github.com does not exist on a customer's GHES instance — the customer must register their
  own. Enterprise users fall back to PAT or `gh CLI` until one asks.
- **The webhook endpoint.** Deferred to phase 2b. Note that `installation_repositories` is
  reported not to fire reliably on install, so webhooks must never be the only source of
  truth about repository access.
- **Any GitLab or Bitbucket implementation.** Part 06 designs the seams and lists the
  host-coupling that must be undone; it does not implement an adapter.
- **The repository picker.** Part 08 records that there is no repo picker at all today — "Open
  GitHub project" is a paste-a-URL box, with nothing half-built toward browsing. A GitHub App
  installation naturally enables "browse my repos and clone one", but designing that UI is
  out of scope here.
- **PostHog / telemetry schema detail.** Part 09 §9 names the events to emit; it does not
  specify properties, retention, or the dashboard.
- **Cost modelling.** No estimate of backend load, token-mint volume, or the GitHub rate-limit
  headroom at 100 concurrent cloud workspaces beyond the burn-rate arithmetic in part 03 §12.
- **Anything about non-git forges** (Gerrit, Perforce, Azure DevOps).

---

## 3. What remains unverified

### 3.1 About competitors

- **No vendor publishes its GitHub App permission set.** Not Conductor, not Cursor, not
  Devin, not Jules. For Conductor specifically it *cannot* appear on GitHub's public
  surfaces, because a private App renders a minimal page. Our permission list in part 04 is
  derived bottom-up from what each API call requires — which is the right method anyway, but
  it means we have no competitor baseline to sanity-check against.
- **Conductor's desktop callback mechanism is undocumented.** We know the `conductor://`
  scheme is registered and that every *documented* deep link is workspace-oriented
  (`conductor://prompt=`, `conductor://linear_id=`, `conductor://async?repo=`). We know their
  backend returns an `installUrl` rather than the client constructing one. Whether the
  redirect lands on a loopback port or the custom scheme is inference, not evidence.
- **Whether Conductor's users install a private App at all**, and if so how, given GitHub's
  documented restriction. This is the largest unexplained fact in the teardown. It is
  possible their user-facing App is a different, public one and `conductor-build` /
  `conductor-dev` are internal.
- **The exact settings-screen strings** — "All repositories accessible.", the RECOMMENDED
  badge, the row order — are sourced *only* from the founder's screenshot. They are tagged
  **unverified** throughout, and the analytical claim built on them (that Conductor ships an
  explicit user-selected credential rather than a precedence chain) was **refuted**: the
  changelog quotes cited in support of it do not support it.

### 3.2 About GitHub

Seven behaviours we could not settle from documentation. Each is a decision input; four are
answerable in an afternoon with a real App and a real SAML org.

| # | Unknown | Why it matters | How to settle |
|---|---|---|---|
| 1 | Are installation access tokens subject to per-user SAML SSO authorization? | The load-bearing unknown for cloud workspaces in SSO-enforced orgs. If yes, the whole cloud story needs a per-user authorization step. | Test against a real SAML-enforced org before committing to phase 3. |
| 2 | Does `Pull requests: write` alone permit commenting, or is `Issues: write` required? | Decides whether the App registration needs an `Issues` permission part 04 currently omits. | One API call with a minimal App. |
| 3 | What permission creates a repository under a GitHub App? | Decides whether "Publish to GitHub" works at all under App mode. | One API call. |
| 4 | Does GitHub accept an arbitrary ephemeral loopback port against a registered portless callback? | Only matters if we fall back from `zeros://` to loopback. Three sources say yes, one doc sentence reads the other way. | Five-minute live test. |
| 5 | Does a device-flow-derived refresh really need no client secret? | Decides whether `backend/` sits on the hot path of every 8-hour rollover in the fallback mode. The docs' carve-out is verbatim but single-sourced. | Empirical test. |
| 6 | macOS Launch Services' tie-break for duplicate URL schemes | Apple documents it as undefined. **The actionable conclusion is that it cannot be a security boundary** — which is why the callback carries only a single-use nonce. | Unanswerable; design around it. |
| 7 | The git-over-HTTPS error string for an IP-allow-list denial | Any transport-layer classifier for that case is guesswork until someone reproduces it. | Reproduce against an allow-listed org. |

### 3.3 About the evidence base itself

Eleven of the 207 research claims had fact-checks that did not resolve cleanly and were kept
as confirmed by default. They are not individually flagged in the JSON. Any single claim in
this report that a decision rests on should be re-read at its source before it is acted on —
which is what the inline URLs are for.

---

## 4. Process gaps

**The design panel never ran.** The plan was four independent architecture proposals —
backend-first, local-first, provider-abstraction-first, incremental/risk-first — scored by
four judges on distinct lenses (security, feasibility, UX, cloud-and-scale), then
synthesized. That phase was cut when the run hit a session limit. The consequence is
concrete:

- **Part 04 has not been read by anyone adversarial.** No security judge attacked the
  blast-radius story. No feasibility judge checked the estimates against this codebase's real
  integration cost.
- **The local-first alternative never got a fair hearing.** It was rejected on one
  argument — that GitHub requires a client secret — which is well-evidenced, but a dedicated
  advocate might have found a materially different shape around device flow that this report
  dismisses in two paragraphs.

**The two report critics never ran.** They would have (a) hunted for material gaps and
cross-section contradictions, and (b) re-verified a sample of at least 15 `path:line`
citations by opening the files and spot-checked 6 GitHub API claims against docs.github.com.

**Recommended before implementation starts:**

1. Run a citation spot-check over parts 04 and 08 — open 15 cited `path:line` references and
   confirm they say what is claimed. The finder agents did open files, and the sections that
   corrected the spec (§6 below) demonstrate they were reading carefully, but nobody
   re-checked them.
2. Have one engineer who did not write this read part 04 specifically looking for the
   security hole, before the App is registered.
3. Settle the four cheaply-answerable GitHub unknowns in §3.2 first — items 1, 2, 3 and 4
   change the App registration, and the registration is awkward to change later.

---

## 5. Critic claims we rejected

Fifty-seven audit findings were killed by verification — a 52% kill rate. These are the most
instructive, because they show the failure modes an unverified audit produces.

**"`GITHUB_TOKEN_SET` is local-clients-only, so the Mac can never courier a token to a
sandbox engine"** — filed as a *blocker*. Killed on mechanism: the desktop courier does not
use `GITHUB_TOKEN_SET` at all. `pushGithubTokenToEngine` is an explicit no-op; the real path
is Electron main's spawn env plus a stdin control line. The finding also inverted the
security intent — the local-only gate exists deliberately so a remote peer can neither inject
nor harvest the owner's credential, and the finding proposed removing it.

**"`ZEROS_GITHUB_TOKEN` is read once at boot, so the documented 1-hour auto-re-mint has no
mechanism"** — filed as a *blocker*. Killed on fact: two live mid-session re-seed paths exist
into the same slot, neither needing an engine restart. The design conclusion (env delivery
cannot serve git *transport*) survived; the stated mechanism did not.

**"The sandbox image ships no `gh` and no credential helper, so `git push` cannot
authenticate"** — filed as a *blocker* against `scripts/cloud-spike/Dockerfile:29`. Killed on
scope: the anchored file is explicitly non-shipping harness code, and its own README says so
in the first paragraph. Accurate about the bytes, wrong about what the bytes are.

**"Zero code exists for delivering a git credential to a sandbox; the spike proves it"** —
killed because the *receiving* half is already built and generic. The headline was factually
false even though every mechanical observation under it checked out.

**"The encrypted secrets vault a GitHub App private key would need was deleted in migration
0005"** — killed because 0005 dropped a table, not an encryption primitive, and nothing about
a Zeros GitHub App is blocked by its absence.

**"`GIT_TERMINAL_PROMPT` is never set, so a credential-less HTTPS op hangs the RPC
forever"** — the two sub-observations are true and the fix is still worth shipping, but the
claimed failure mechanism and every claimed impact were wrong.

The pattern: **the mechanical observations were almost always right and the causal story on
top of them was often wrong.** That is exactly what a refutation pass is for, and it is why
the 52 survivors are worth acting on.

---

## 6. Where the sections corrected the spec

Several sections disagreed with the architecture spec they were handed and were right. These
should be folded into part 04 before anyone builds from it.

| Correction | Detail |
|---|---|
| **The OAuth hand-back already exists** | Zeros ships and has hardened `zeros://auth/callback#ticket=…&nonce=…` with an opaque single-use ticket redeemed over HTTPS from Electron main. The GitHub App flow is a second instance of that pattern, not new machinery. |
| **The settings key should mirror `providers.<agent>.auth`** | `[github] auth_method` matches the shipped shape at `src/engine/settings/schema.ts:114`, not an invented one. |
| **Use git's native expiry protocol** | `password_expiry_utc` (git ≥ 2.40) makes git itself refuse a stale credential and re-ask, removing a whole class of race between the broker's clock and git's. Emit it at `exp − 300 s`. One line. |
| **The sandbox should call the backend, not the Mac** | The spec said "over the existing control connection". A Mac-sourced token dies when the laptop closes — which is the product's headline promise. Sandbox → backend, over the sandbox's own authenticated channel. |
| **`resolveReviewProvider` ignores its argument** | It takes `_originHost?` and neither call site passes one. The seam has never carried host information at all — worse than "correctly shaped but incomplete". |
| **`ghPrCreate` is a dead export** | Zero callers. PR creation happens through an agent prompt, so the provider abstraction cannot capture PR creation even in principle today. The gap is the prompt path, not an unwrapped IPC method. |
| **The bypass count is 5 of 8, not 6** | Verified per-callsite: `authStatus`, `getPr`, `getChecks`, `markReady`, `merge`. |
| **GitLab's `oauth2` username is "should", not "mandatory"** | GitLab's docs say "You can set the username to any string value. You should use `oauth2`." Keep the engineering rule (always send `oauth2`); soften the doc wording. |
| **GitLab's device grant landed in 17.2, not 17.1** | Introduced 17.2 behind a flag, enabled by default 17.3, GA 17.9. The GA date in the spec was right. |
| **IP-allow-list denial can return HTTP 200** | Over GraphQL, with the message in `errors[].type = "FORBIDDEN"`. Any classifier keyed on `err.status` misses it. Zeros uses REST today, so this is latent — but the classifier contract should say "status **and** GraphQL error array". |
| **`X-GitHub-SSO` appears on 200s too** | The URL-bearing form is on 403; the `partial-results` form is on **200**. Checking the header only on error paths makes an incomplete org list look authoritative. |
| **B2's blast radius is larger than stated** | `getAuthStatus` in Electron main clears safeStorage directly, and `ghAuthStatus` is the one handler that does *not* re-courier to the engine — so main and engine can disagree about whether a credential exists. |
| **GHES is less broken than the spec implies** | The manual Create-PR fallback already works against a GHE host and is unit-tested. Two audit findings asserting stronger GHES breakage were **refuted** on this point. |
| **Two `area_summaries` entries are pre-refutation prose** | The `cloud-workspace-credentials` summary asserts things that were subsequently refuted. Anyone mining the summaries directly must cross-check against `refuted_findings`. |
| **Bitbucket's app-password date is inconsistent in the evidence base** | The spec's 2026-07-28 is correct (full removal); a separate claim says 2026-06-09, which is the brownout start. Do not print both. |

---

## 7. What would change my mind on the central decision

The central decision is *"the backend holds the GitHub App secret and private key, and sits
on the auth path."* It should be revisited if any of these become true:

1. **GitHub ships a genuine public-client flow** — PKCE-only code exchange with no
   `client_secret`. Then the App method becomes fully local and the backend is needed only
   for cloud sandbox minting. Re-check annually.
2. **Cloud workspaces are cancelled or indefinitely deferred.** The cloud requirement is what
   makes installation-token minting non-optional. Without it, device flow plus a local broker
   would be a defensible, materially simpler design — and would keep the README's promise
   intact.
3. **The backend cannot be made to meet the bar.** A credential-minting endpoint needs a
   shared-store rate limiter (part 09 §12 Q12 flags that today's limiter may be per-process),
   an append-only audit trail with a resolved schema for personal installations, and a key
   custody story for the App private key. If those cannot be done properly, do not ship the
   mint route — ship phases 0 and 1 alone, which fix six real blockers and need no backend at
   all.
4. **A security review finds the blast radius unacceptable.** The backend holding an App
   private key means its compromise reaches every installation. That is a real
   concentration of risk, and it has not been reviewed by anyone adversarial (§4).

Note that **phases 0 and 1 are independent of this decision entirely.** They fix the six
confirmed blockers and make the three methods explicit and correctly stored, using no backend
and no GitHub App. If Q-A goes the other way, that work is not wasted — it is the whole
local-first design, already built.
