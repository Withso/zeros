# Zeros GitHub Integration Report

*July 2026 · ten parts · the audit, the competitive teardown, the architecture, and the plan*

Zeros authenticates to GitHub today through an **implicit fallback chain** — try the `gh`
CLI, else a pasted token, else an OAuth device flow — all of it writing into **one token
slot**, with no record of which method won. The founder wants what Conductor ships: three
methods the user picks explicitly, one of them a native **Zeros GitHub App** with real
consent and per-repository scoping, each with its own connection health. That change is
worth doing on its own. But the reason it is urgent is **cloud workspaces**: an agent
running in a rented sandbox has no `gh` login and no keychain, and forwarding a user's
personal access token into a rented VM is not an acceptable answer. Native GitLab and
Bitbucket follow later, so whatever we build must generalise.

This report is what we found when we went looking, and what we think Zeros should build.

---

## The decision

- **Three explicitly-selected, independently-stored auth methods** — `gh CLI`,
  **Zeros GitHub App** (recommended), `Personal Access Token`. Separate credential slots are
  what make the picker honest: switching method must not destroy the other credential.
  Today's single slot plus a non-durable `viaCli` boolean cannot represent this.
- **One genuinely new component: a Zeros-owned git credential broker.** A unix-socket
  server in the engine, plus PATH-shimmed `git`/`gh` and a `GIT_ASKPASS` shim. It fixes four
  confirmed problems at once — push works under every method, short-lived tokens become
  viable, the agent's own shell `git`/`gh` are covered, and cloud sandboxes reuse the same
  code path.
- **The GitHub App is a *public* App whose client secret and private key live in
  `backend/`.** This is forced, not chosen: GitHub documents `client_secret` as **required**
  on the code exchange *even with PKCE*, refreshing a user token needs it too, and minting an
  installation token needs the App private key — which can never ship in a desktop binary.
  Zeros already runs a Hono + Postgres control plane with Auth0, teams, RLS and audit. Put
  the secrets there.
- **The Mac holds only an 8-hour user access token and a 6-month refresh token**, in
  safeStorage. Never the secret, never the private key.
- **Cloud sandboxes never receive a long-lived credential.** The backend mints **1-hour
  installation access tokens** scoped to the single repository the sandbox needs. A 6-hour
  agent run outlives a 1-hour token five times over, so refresh is the normal path, not an
  edge case.
- **Six confirmed blockers ship first, before any of the above.** The worst is that
  `isAuthError()` treats **403 as 401** and durably deletes the user's credential. Per-repo
  installation scoping *generates* 403s by design — shipping the App on today's classifier
  would sign users out constantly.
- **The OAuth hand-back is not new machinery.** Zeros already ships and has already hardened
  `zeros://auth/callback#ticket=…&nonce=…` with an opaque single-use ticket redeemed over
  HTTPS from Electron main. The GitHub App flow is a second instance of that pattern.
- **Durable selection lives in `~/.zeros/settings.toml` → `[github] auth_method`**, mirroring
  the shipped `providers.<agent>.auth` shape exactly. Installation metadata goes in SQLite,
  revalidated on open — never treated as truth.
- **The migration infers, never defaults.** If `gh auth token` returns the string already
  stored, write `gh-cli`; else `pat`; if no token, leave it unset. A wrong default silently
  signs people out.
- **The broker is also the multi-provider abstraction**, because the one thing that genuinely
  differs per forge at the git layer is the magic HTTPS username — `x-access-token` /
  `oauth2` / `x-token-auth` — and the broker is the only place that has to know it.

---

## Start here

| If you are… | Read |
|---|---|
| The implementing engineer | **04** (architecture) then **09** (plan). Keep **03** open as the API reference. |
| Reviewing the current code | **08** (every surviving bug, with the regression test each needs) then **01**. |
| The founder, deciding | This page, then **10** — the open questions and what we could not establish. |
| Working on cloud workspaces | **05**, then **04 §11**. |
| Planning GitLab / Bitbucket | **06**, then **01 §10** for the coupling that must be undone first. |

---

## The ten parts

| # | Part | What it is |
|---|---|---|
| 01 | [Current State — What Zeros Does Today](01-current-state-audit.md) | Evidence-cited teardown of the integration as it exists: the three implicit paths, the token courier across renderer/main/engine, the API-vs-transport split, all 19 `gh*` IPC methods — and a substantial section on what already works well. |
| 02 | [How Others Do It](02-how-others-do-it.md) | Conductor from the inside (first-hand teardown), then Claude Code, Codex, Cursor, Devin, Jules, Copilot, and the Netlify/Vercel/Linear multi-provider UIs. Includes the claims we rejected. |
| 03 | [GitHub Auth Mechanics](03-github-auth-mechanics.md) | The authoritative reference: installation vs user vs PAT tokens, exact lifetimes, scoping limits, the new `ghs_APPID_JWT` format, device flow, PKCE and the client-secret problem, SAML, rate limits, GHES. Implement from this without re-reading GitHub's docs. |
| 04 | [Recommended Architecture](04-recommended-architecture.md) | **The decision.** Interfaces, storage keys, endpoint shapes, the broker, the App spec, the consent sequence, the settings state machine, the migration. |
| 05 | [Cloud Workspaces and Credentials](05-cloud-workspaces-and-credentials.md) | Why the cloud requirement drives everything: the options matrix with blast radius each, mid-run expiry, commit attribution, teams, and the industry cross-reference. |
| 06 | [Multi-Provider — GitLab and Bitbucket](06-multi-provider-gitlab-bitbucket.md) | Why the broker is the durable seam, the hard constraints (GitLab has no App analogue; Bitbucket app passwords died on 2026-07-28), the semantics mapping, and what must change here first. |
| 07 | [Edge Cases and Failure Modes](07-edge-cases-and-failure-modes.md) | The catalogue an implementer works through, as tables: scenario, what happens today, what must happen, where it is handled, which test covers it. |
| 08 | [Bugs and Hazards Found](08-bugs-and-hazards.md) | All 52 surviving findings by area and severity, each with `file:line`, the failure scenario, the fix, and the regression test to write first. Plus hazards-not-yet-bugs and the notable claims we killed. |
| 09 | [Implementation Plan](09-implementation-plan.md) | Phases 0–4 with a working product at every step, the exact gate commands, the App registration checklist field by field, telemetry, a manual QA script, and rollback per phase. |
| 10 | [Open Questions and Gaps](10-open-questions-and-gaps.md) | What needs a founder decision, what this report does not cover, what remains unverified, and where the process itself fell short. |

---

## What changes vs today

| | Today | After |
|---|---|---|
| Auth method | Implicit chain: gh → PAT → device flow | Explicit, user-selected, persisted in `settings.toml` |
| Credential storage | One slot; all three methods overwrite each other | Three independent slots |
| Which method is active | Inferred per session, lost on restart | Durable, and shown honestly per row |
| GitHub App | None (an OAuth App with a baked client id) | Public GitHub App, consent + per-repo installation |
| `git push` / `clone` | Whatever credential helper the machine happens to have | Zeros' own broker, host-scoped, under every method |
| Agent's `gh pr create` | Fails unless the user separately ran `gh auth login` | Works — PATH-shimmed `gh` hits the broker |
| A 403 from GitHub | **Deletes the user's credential** | Classified: rate-limited / SSO-required / forbidden-scope / not-installed. Never destructive. |
| Token expiry | Unhandled — PATs simply die | Refreshed at T−60 s and on a reported 401 |
| Cloud sandbox | Cannot clone or push at all | 1-hour installation token, scoped to one repo, auto-refreshed |
| Commit attribution | Implicit in whatever token is used | Explicit `gitIdentity`, so commits are the user's |
| GitLab / Bitbucket | Hard-coded to GitHub in ~20 places | Seams in place; the broker already carries per-forge usernames |

---

## The top open questions

Full list with reasoning in [part 10](10-open-questions-and-gaps.md) and
[part 09 §12](09-implementation-plan.md). The ones needing a founder call:

| # | Question | Recommendation |
|---|---|---|
| 1 | Is a backend on the GitHub auth path acceptable, given README.md's "your machine, your credentials" promise? | **Yes, with disclosure.** It is forced by GitHub's protocol, not chosen. Update the README and SECURITY.md in the same PR — do not let the docs quietly become untrue. |
| 2 | Public or private GitHub App? | **Public.** Conductor's `conductor-build` is private, which per GitHub's docs can only be installed on the owning account. Zeros needs any user or org to install. |
| 3 | Is PAT permitted for cloud sandboxes at all? | **No.** Forwarding a long-lived personal credential into a rented VM is the one option to reject outright. Offer the App, or run locally. |
| 4 | Bundle the 53 MB `gh` binary, as Conductor does? | **No.** Once the broker exists, `gh` is needed for exactly one method the user explicitly chose. Fix the fabricated "not found" copy instead. |
| 5 | Ship the Claude-Code-style credential proxy that keeps tokens out of the sandbox entirely? | **Not in phase 3.** Spike the sandbox provider's native secret plumbing first, then decide build-vs-configure. |
| 6 | Whose identity does a *shared* cloud workspace act as? | **The creator's**, recorded in the workspace row and shown in the UI. Revisit when sharing ships. |

---

## How this report was produced

Seventeen agents worked in parallel: **9 code auditors** over this repository and **8 web
researchers** over GitHub's documentation, competitor products, and the RFCs. Everything they
produced was then handed to **220 independent agents**, each given exactly one finding to
**refute** or one claim to **fact-check** from scratch.

The refutation did real work:

| | Raised | Verified | Survived | Killed |
|---|---|---|---|---|
| Audit findings | 125 | 109 (all at medium or worse) | **52** | 57 — a **52% kill rate** |
| Research claims | 207 | 207 | **188** | 19 |

The 16 unverified findings are all `low`/`info` and are marked as such. Many surviving items
carry a verifier's `correction` — and several corrections made the finding *worse*, not
better. A 52% kill rate is the reason the surviving list is worth acting on.

On top of that sits a **first-hand, read-only teardown of the live Conductor 0.77.5 install**
on the founder's Mac — the binaries, the sidecar's embedded schemas, the Keychain service
names and the local database. That is primary evidence, and it is stronger than anything
published: it is how we know Conductor persists the auth method *with* the credential as a
discriminated union, and how we found their git-credential broker.

**Two phases were cut for time, and it matters.** The design panel — four competing
architectures scored by four judges on distinct lenses — and the two report critics never
ran. So the architecture in part 04 is **one author's synthesis of the verified evidence,
not a panel consensus**, and no adversarial reader has re-verified the `path:line` citations
or spot-checked the API claims against docs.github.com. Part 10 says exactly what that leaves
open and recommends a citation spot-check before implementation begins.

Everything under `docs/` is working notes, not spec — see [AGENTS.md](../../AGENTS.md).
The raw evidence base lives at `.context/evidence-confirmed.json`, the Conductor teardown at
`.context/conductor-teardown-2026-07-29.md`.
