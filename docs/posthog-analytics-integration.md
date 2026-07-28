# PostHog Analytics Integration — Research, Analysis & Plan

> Status: **Phases 1, 2, 2.5 & 3 implemented** (2026-06-04). Phase 1: app/tab/error events live in `Zeros Dev`. Phase 2: agent reliability funnel, renderer-side (§14). Phase 2.5: per-turn token/cost/model usage from **all 5 agents** + cost auto-computed by PostHog (§15). Phase 3: web-build analytics enabled + reverse-proxy/CSP wired (§16) — **DEPLOYED & LIVE at `app.zeros.build`** (verified 2026-06-07): proxy `t.zeros.build` up, prod `phc_` key baked into the shipped bundle, web resolves to the `Zeros` prod project. Decisions in §11. Phase 4 (flags/experiments/surveys) optional/not started.

---

## 0. TL;DR

- **Should we use PostHog? Yes** — but only as a *metadata-only, anonymous-by-default* analytics layer, never touching user code, prompts, or file contents. Zeros today has **zero analytics** (verified: no Sentry/Segment/Mixpanel/GA anywhere in the repo), so we are flying blind on activation, retention, and — most importantly — *which of our five AI agents actually work*.
- **The single biggest win is LLM/agent observability.** Zeros runs Claude, Codex, Cursor, Droid and OpenCode through one `AgentGateway` with a clean failure taxonomy (`timeout | auth-required | subprocess-exited | protocol-error | transport-closed | session-expired`, each tagged with a `stage`). PostHog's LLM analytics + error tracking turn that taxonomy into dashboards that answer *"where do agents get stuck?"* — i.e. **the "locks" you want to find.**
- **The "2× free monthly limits" you have is the Lenny's Newsletter "Product Pass" deal**: new PostHog customers get **2× the free-tier credits *and* a full year of the PostHog Scale plan** (unlimited projects, extended session-replay retention, SSO, white-labeling, priority support) — a ~$16,500 value. It is **time-boxed (1 year) and new-customer-only**, so there's a real reason to set the account up now and lock it in.
- **No lock-in risk:** PostHog is open-source and self-hostable, so adopting it now (to use the free credits) does not trap us — we can move to EU cloud or self-host later without re-instrumenting.
- **One caveat to internalize:** PostHog is all-in-one (analytics + session replay + flags + experiments + surveys + error tracking + LLM observability). We should adopt it **product by product**, not all at once — and we should likely **keep session replay OFF on the editor/canvas surface** because it would record the user's private code.

---

## 1. What the "2× free monthly limits" actually is

This is the **PostHog × Lenny's Newsletter "Product Pass"** offer. For new PostHog customers it bundles:

- **2× the standard free-tier credits, every month, for a year**, and
- **A full year of the PostHog *Scale* platform add-on** (normally $750/mo) — which adds **unlimited projects**, extended session-replay retention, priority support, white-labeling, SAML/SSO, advanced permissions, audit logs, HIPAA BAA.

Combined value ≈ **$16,500**. It's a first-of-its-kind deal and **you must be a new PostHog customer** to redeem it.

### What the doubled free tier gives us per month

| Product | Standard free / month | **Your 2× allowance** |
|---|---|---|
| Product analytics events | 1,000,000 | **2,000,000** |
| Session replays | 5,000 | **10,000** |
| Feature flag requests | 1,000,000 | **2,000,000** |
| Survey responses | 1,500 | **3,000** |
| Error-tracking exceptions | 100,000 | **200,000** |
| Logs | 50 GB | **100 GB** |
| PostHog AI credits (their Max assistant) | 2,000 ($20) | **4,000 ($40)** |

> Note: ~90% of PostHog accounts never exceed even the *single* free tier. At Zeros' current scale (solo dev + early users) we will not come close to 2M events/month. The doubled tier mostly matters as *insurance* once we have hundreds of active users, and the **Scale features are the real prize** — especially **unlimited projects** (lets us run separate `Zeros` and `Zeros Dev` projects, matching the existing `com.zeros` / `com.zeros.dev` data isolation) and extended retention.

**Action:** redeem on a fresh account, then set per-product **billing limits to $0** so we can never be surprise-charged — when a limit is hit, ingestion for that product simply stops; nothing breaks and there's no bill.

---

## 2. What PostHog is, and which parts map to Zeros

PostHog is an all-in-one product OS. Relevance to Zeros, ranked:

| Product | What it does | Fit for Zeros | Priority |
|---|---|---|---|
| **LLM / AI observability** | Per-generation model, tokens, cost, latency, stop reason; traces group multi-call agent runs | **Killer fit** — instruments our 5 agents to show reliability/cost/latency, in *privacy mode* (metadata only) | **P0** |
| **Error tracking** | Captures exceptions + stack traces, links to replays | Replaces a separate Sentry; catch renderer/main/engine crashes (we have a root `ErrorBoundary` but nowhere for crashes to go today) | **P0** |
| **Product analytics** | Events, funnels, retention, paths, trends, SQL | Activation/retention funnels — "find the locks" (drop-off) | **P0** |
| **Feature flags** | Server-evaluated boolean/multivariate flags | Kill-switches per agent adapter; gradual rollout of new agents/features; remote-disable a broken adapter without shipping | **P1** |
| **Experiments (A/B)** | Built on flags | Onboarding/CTA experiments; default-agent experiments | **P2** |
| **Surveys** | In-app surveys targeted by flag/event | NPS, "why did the agent fail?" micro-surveys after a failure | **P2** |
| **Session replay** | Records the DOM of a session | **Use sparingly.** Great on the *marketing site* and maybe first-run onboarding; **OFF on the editor/canvas** (would record private code). | **P3 / restricted** |
| **Data warehouse / CDP** | Sync external sources, sync cohorts out | Not needed yet | — |

### Why PostHog over the alternatives

- **vs Sentry** — Sentry only does error/perf monitoring. PostHog does errors *plus* analytics, flags, LLM observability, in one SDK and one free tier.
- **vs Mixpanel / Amplitude** — Neither offers **error tracking** or **LLM/AI observability**; both are analytics-only. PostHog's free tier is the most comprehensive single-platform tier available, and PostHog is **engineering-led / open-source**, which matches a dev-tool's instincts.
- **Open source + self-hostable + EU cloud** — the decisive point for a privacy-positioned product: if cloud ever becomes a concern we migrate to EU cloud or self-host **without re-instrumenting**. That removes the usual "don't add a tracker" objection.

---

## 3. The core tension: PostHog vs Zeros' privacy posture

This is the crux of the decision, so it gets its own section.

Zeros is built on the opposite of telemetry: an **E2EE relay the server can't read**, a **local encrypted secret store**, **scrubbed remote-shell envs**, and the principle that *the relay is blind*. Bolting on a third-party analytics pipe is, on its face, in tension with that. The resolution is a hard contract:

### The data contract (non-negotiable)

| ✅ ALLOWED to send (metadata only) | ❌ NEVER send |
|---|---|
| App version, OS, arch, surface (`electron`/`web`/`cli`), runtime mode (`dev`/`prod`) | User **code** / file contents |
| Anonymous **device** id (random UUID, local) | Agent **prompts / completions / conversation** content |
| Feature usage: which tab/panel/command (by *name*) | **File paths, project names, branch names** (omit or hash) |
| Agent lifecycle: `agentId`, session start/end, duration, mode | **API keys, tokens, secrets** of any kind |
| Agent outcome: success/fail, `failureKind`, `stage`, latency | Commit messages, PR titles/bodies, **diffs**, terminal output |
| LLM metadata (privacy mode): model, provider, in/out/cache **tokens**, **cost**, latency, stop reason | Real user identity (email/name) — stay **anonymous** |
| Git op *type* (commit/push/diff) — not contents | Anything decrypted from an E2EE relay payload |
| Our **own** exception types + scrubbed stack traces | Raw agent **stderr** (can contain user content) |

### The five guardrails that make this safe

1. **Anonymous by default.** Keep PostHog's default `person_profiles: 'identified_only'` and **never call `identify()`**. Use a random per-install UUID as `distinct_id`. Result: no person profiles, no individual-user tracking — *and* anonymous events are **up to 4× cheaper** than identified ones (stretching the quota further). We lose person-level cohorts and person-property flag targeting, which we don't need.
2. **LLM analytics in *privacy mode*.** The `@posthog/ai` wrapper supports a privacy-mode flag that **suppresses prompt/response content while still capturing model, token counts, cost, latency, and stop reason.** This is the exact shape we want: agent *performance* telemetry with zero user content. (Verify the exact flag name — `privacyMode` / `posthog_privacy_mode` — at implementation.)
3. **Session replay restricted.** OFF on the editor/canvas surface. If used at all (onboarding, marketing), enable PostHog's input/text masking (`maskAllInputs`, mask text) so nothing typed is recorded.
4. **Reverse proxy.** Route ingestion through a first-party domain (**`t.zeros.build`**) so (a) the web app isn't blocked by ad-blockers and (b) traffic goes to *our* domain, not a visible third-party tracker endpoint. Scale tier supports a managed proxy.
5. **User control + transparency.** A clear **Settings → Privacy → "Share anonymous usage data"** toggle, a first-run notice, and a documented list of exactly what's collected. Decide opt-in vs opt-out (see §11) — for a privacy-brand product, opt-out *with a prominent first-run disclosure* is the usual sweet spot; opt-in is the maximally trustworthy choice but suppresses data volume.

> Net: we send **numbers and enums about how the product performs**, never the user's work. That is defensible for a privacy-first dev tool, and it's reversible (self-host) if the bar ever rises.

### 3.1 Session replay — what it is, and why it's OFF in the app

**What it records.** Session replay (PostHog uses rrweb under the hood) is *not* a screen video. It records the **initial DOM + every DOM mutation**, plus interactions (mouse moves, clicks, scroll, input, viewport, navigation), then **reconstructs a pixel-accurate playback** of exactly what the user saw and did. It can *optionally* also capture **network requests and console logs**.

**The benefit (the "why" behind the "where").** Funnels (§4) tell you *where* users drop off; replay tells you *why*. You watch the actual sessions that failed — rage-clicks, dead-clicks, the cursor hunting for a control, the exact steps before a crash (PostHog links a replay to each error event). It's the qualitative companion to quantitative funnels and the fastest way to reproduce a confusing bug.

**Why it's dangerous for Zeros specifically.** Because it records the DOM, **anything rendered on screen is captured** — and in the Zeros editor that's the entire deny-list:
- Source **code** / file contents (Monaco/CodeMirror render visible lines as DOM text — default input-masking does *not* catch this; it only masks `<input>`/`<textarea>`).
- The **chat panel** — the user's prompts *and* the agent's responses (conversation content).
- **File tree, paths, project & branch names** (sidebar/tabs/breadcrumbs).
- **Diffs** in Changes/Review, commit messages, PR titles.
- Terminal output is *probably* spared (xterm renders to a `<canvas>`, which replay doesn't capture by default) — but "probably" is not a privacy guarantee.

So enabling replay over the editor would pipe exactly the content the whole §3 contract forbids straight to PostHog Cloud.

**Could masking save it?** PostHog supports `maskAllInputs` (on by default), `maskAllText: true` (every text node → asterisks), and element blocking (`.ph-no-capture` / `blockSelector`, rendered as a grey box). You *could* mask all text + block the editor/chat/terminal/files containers — but then the replay is mostly grey boxes (low value), and one missed selector after a UI refactor silently leaks. Safe-by-construction beats masking-by-vigilance.

**Decision:**
- **Marketing site (`zeros.build`): replay ON** — pure win, no private data.
- **The app (editor/canvas/chat/files/changes/terminal): replay OFF** for v1.
- **Network + console capture OFF** everywhere (they'd leak payloads).
- Revisit later *only* for a specific onboarding question, and then only on pre-project screens with full text-masking.

---

## 4. "Finding the locks" — what to actually instrument

Interpreting "find the locks" as **find the friction / failure / drop-off points where users get stuck or churn.** PostHog answers this with three lenses, all backed by code we already have:

### A. The activation funnel (product analytics → Funnels)
`app_opened → workspace_created/opened → agent_session_started → agent_first_response → agent_session_succeeded`
Each step's drop-off is a "lock." (e.g. if users open the app but never start an agent, the lock is onboarding; if they start an agent but never get a first response, the lock is auth/spawn.)

### B. The agent reliability funnel (LLM analytics + custom events)
This is where Zeros is unusually well-positioned, because the **failure taxonomy already exists** in `src/engine/agents/gateway.ts` / `types.ts`:
- `failureKind` ∈ `timeout | auth-required | subprocess-exited | protocol-error | transport-closed | session-expired`
- `stage` ∈ `initialize | newSession | loadSession | prompt | cancel | setMode`

Emit one event per agent run carrying `agentId`, `failureKind`, `stage`, `durationMs`, plus the `$ai_generation` metadata. Then a single breakdown answers questions like: *"OpenCode hangs 5% of sessions at `prompt`"*, *"Cursor's `auth-required` rate spiked after release X"*, *"Droid resume is a no-op (loadSession success but no first response)"* — these are precisely the per-agent fragilities flagged in the deep-audit, now measured instead of guessed.

### C. Crashes & errors (error tracking)
Wire the renderer `ErrorBoundary`, Electron main `uncaughtException`, and engine failures into PostHog error tracking. Today these vanish; tomorrow they're a ranked list of "locks" by frequency.

---

## 5. Proposed event taxonomy (v1)

Names follow PostHog's `object_action` convention. Properties are **metadata only** per §3.

| Event | Key properties | Surface |
|---|---|---|
| `app_opened` | `version`, `os`, `arch`, `surface`, `runtime_mode` | all |
| `app_error` (error tracking) | `error_type`, scrubbed `stack`, `surface` | all |
| `workspace_opened` | `kind` (`code`/`design`), `is_worktree` | desktop/web |
| `tab_viewed` | `tab` (`chat`/`files`/`changes`/`review`/`browser`/`terminal`) | desktop/web |
| `agent_session_started` | `agent_id`, `mode`, `surface`, `runtime_mode` | engine |
| `agent_first_response` ✅ | `agent_id`, `latency_ms`, `first_kind` | renderer |
| `agent_session_ended` | `agent_id`, `outcome` (`success`/`cancelled`/`error`), `duration_ms`, `prompt_count` | engine |
| `agent_failed` | `agent_id`, `failure_kind`, `stage`, `duration_ms` | engine |
| `$ai_generation` (auto, privacy mode) | `model`, `provider`, in/out/cache `tokens`, `cost`, `latency`, `stop_reason`, `$ai_trace_id` | engine |
| `git_op` | `op` (`commit`/`push`/`pull`/`diff`/`pr`), `outcome` | engine |
| `relay_connection` | `state` (`connecting`/`connected`/`failed`), `reason` | web |
| `pairing_completed` | — | web |

`$ai_*` events are **standard billed analytics events**, so they count against the 2M/month quota — fine at our scale; see §8 for the at-scale plan.

---

## 6. Architecture — where it plugs in, per surface

Zeros has four surfaces (Electron main, Electron renderer, web-over-relay, CLI/engine). The natural split:

```
┌─────────────────────────────────────────────────────────────┐
│ Electron RENDERER (React)  ── posthog-js (full bundle)        │  UI events, funnels,
│   src/main.tsx / AppShell     dist/module.full.no-external.js │  error tracking
├─────────────────────────────────────────────────────────────┤
│ WEB app (relay client)     ── posthog-js (full bundle)        │  same events, via
│   src/zeros/web/web-app.tsx    + REVERSE PROXY (ad-blockers)  │  reverse proxy
├─────────────────────────────────────────────────────────────┤
│ ENGINE / daemon (Node/Bun) ── posthog-node + @posthog/ai      │  ★ agent LLM events,
│   src/engine/agents/gateway.ts  (server-side, privacy mode)   │  failure taxonomy
├─────────────────────────────────────────────────────────────┤
│ Electron MAIN (optional)   ── posthog-node                    │  app lifecycle, crashes
│   electron/main.ts                                            │  (could also route via renderer)
└─────────────────────────────────────────────────────────────┘
     CLI standalone: skip, or minimal opt-in (`zeros serve` is a daemon)
```

### Surface-specific notes
- **Renderer & web** use `posthog-js`. Electron requires the **full bundle** import — `posthog-js/dist/module.full.no-external.js` — because PostHog normally lazy-loads extensions (replay, surveys) from a CDN at runtime, which Electron's CSP/no-remote-code policy blocks. Manually `capture('$pageview')` on route changes (React Router 7) since Electron has no real page loads.
- **Engine** is the home of the **agent/LLM instrumentation** (the differentiator). Wrap the agent SDK calls with `@posthog/ai` and flush via `posthog-node`. ⚠️ The prod engine ships as a **Bun single-file binary**; `posthog-node` is pure-JS/`fetch` (no native bindings, unlike better-sqlite3) so it *should* run under Bun — **verify early**, and ensure `flush()`/`shutdown()` is called before the daemon exits so events aren't lost.
- **Dev vs prod = two PostHog projects.** Use the existing `isDevRuntime()` single source of truth (`src/engine/runtime.ts`) to pick the project key, so `Zeros Dev` activity never pollutes prod analytics. Unlimited projects come free with the Scale year.
- **Key handling.** The PostHog *project API key* is a **public, write-only** key — safe to ship. Inject per surface via the existing Vite env pattern (mirror `VITE_ZEROS_TARGET`): `VITE_POSTHOG_KEY` for renderer/web, a plain constant/env for the engine. No secret-store needed.

---

## 7. Feature flags, experiments, surveys (P1–P2)

Cheap wins once the SDK is in:
- **Per-agent kill switch** — a flag per adapter (`agent_cursor_enabled`, …). If an adapter starts failing in the wild, flip it off remotely instead of shipping a build. Pairs naturally with the failure-taxonomy events.
- **Gradual rollout** — release new agents / ACP migrations to N% first, watch the failure rate, then ramp.
- **Onboarding experiments** — A/B the first-run flow / default agent; measure activation-funnel lift.
- **Targeted micro-surveys** — trigger a one-question survey after `agent_failed` ("what were you trying to do?") to add qualitative color to the locks. (Note: anonymous-by-default limits person-property targeting; event-triggered surveys still work.)

---

## 8. Quota & cost management

- **Anonymous events** (our default) are up to **4× cheaper** and share the same free million(s) — so the 2M/month doubled tier effectively stretches much further.
- **`$ai_generation` events count** as analytics events. Rough math: even a power user driving thousands of agent generations/month is a rounding error against 2M. Revisit only at thousands of active heavy users.
- **At scale**, three levers, in order: (1) **sampling** high-volume events, (2) **billing limits** (already set to $0 → ingestion just stops, no bill), (3) buy events (they get cheaper per-unit at volume). 
- **Log what we drop.** If we ever sample or hit a cap, surface it internally so dashboards aren't silently truncated.

---

## 9. Risks, cons, and honest counter-arguments

| Risk | Mitigation |
|---|---|
| **Privacy brand damage** if users feel tracked | Anonymous-only, metadata-only data contract (§3), transparent toggle + first-run notice, self-host escape hatch. Never instrument the E2EE payloads or content. |
| **Session replay leaks code** | OFF on editor/canvas; masking elsewhere. |
| **Bun compat in the engine binary** | Verify `posthog-node` under Bun in Phase 1 spike; it's pure-JS so low risk, but the better-sqlite3 precedent says *test, don't assume*. |
| **Deal is time-boxed (1 yr) & new-customer-only** | Redeem now on a fresh account; design portable (open-source/self-host) so expiry just means "switch hosting," not "re-instrument." |
| **Event quota blowout at scale** | Anonymous events + billing limits + sampling (§8). |
| **Vendor reliance** | PostHog is OSS; we can self-host the exact same SDKs/data model. Genuinely low lock-in. |
| **Engineering time** | Phased (§10); Phase 1 is ~a day; the differentiator (agent observability) is Phase 2. |
| **Electron full-bundle weight** | Full bundle is larger; acceptable for a desktop app, and only loaded in renderer. |

**When NOT to expand it:** don't turn on autocapture-everything, don't enable replay on the editor, don't call `identify()` with real identity, don't send anything in the deny-list — even "just for debugging."

---

## 10. Phased rollout plan

### Phase 0 — Account & foundation (½ day, no code)
- Redeem the Lenny's Product Pass on a **new** PostHog account (**US cloud — already provisioned**).
- Create **two projects**: `Zeros` (prod) and `Zeros Dev`.
- Set every product's **billing limit to $0**.
- Turn **session replay OFF** globally for now; keep **error tracking ON**.
- (Optional) stand up the **reverse proxy** subdomain.

### Phase 1 — Desktop core analytics + error tracking ✅ IMPLEMENTED (2026-06-04)
See §13 for the file-by-file map. Built:
- `posthog-js` added; loaded via **dynamic import of the full no-external bundle** (`posthog-js/dist/module.full.no-external`) so it (a) survives Electron's CSP and (b) stays in its own lazy chunk, out of the entry bundle.
- Init config enforces the privacy contract: `autocapture:false`, `disable_session_recording:true`, `disable_surveys:true`, `capture_performance:false`, `person_profiles:'identified_only'` (anonymous device id; **we never call `identify()`**).
- Events wired: `app_opened`, `tab_viewed` (Column-3 tab **type** only — never title/url/path), renderer `ErrorBoundary` + `window.onerror`/`unhandledrejection` → error tracking. (No `$pageview`: Zeros has no router; navigation is tabs.)
- **Settings → Privacy** toggle + one-time first-run notice (opt-out model).
- Dev/prod routing: a new `app_info` IPC command exposes the main process's authoritative runtime mode; the renderer picks `VITE_POSTHOG_KEY_DEV` vs `VITE_POSTHOG_KEY_PROD` from it. `.env.example` documents the keys.
- **Verified:** `tsc` clean on all touched files, renderer `vite build` OK, Electron `tsup` build OK, eslint clean.
- **Remaining (you):** create the two projects, paste keys into `.env`, then launch and confirm events land in the right project + opt-out stops sends. Live verification needs the keys.

### Phase 2 — Agent observability ★ the differentiator ✅ IMPLEMENTED (2026-06-04)
**Done renderer-side** (not engine — see §14 for why): `agent_session_started`, `agent_prompt_completed` (duration + stop_reason + best-effort model/tokens/cost), `agent_failed` (via a single store observer carrying `failure_kind` × `stage`). The original "`posthog-node` + `@posthog/ai` in the engine" plan was dropped because Zeros' agents are subprocesses (the SDK wrapper can't see their calls) and the renderer already has all the data over the bridge.
- **Verified:** tsc/build/lint clean.
- **Remaining (you):** live-verify (start agent → complete a turn → force a failure) + build the Agent Reliability dashboard.
- **Since implemented (no longer deferred):** the TTFT event `agent_first_response` ✅ (2026-06-07, see §14); PostHog's native `$ai_generation` LLM-product dashboards ✅ (Phase 2.5, §15 — all 5 agents).

### Phase 3 — Web app + reverse proxy ✅ IMPLEMENTED (2026-06-04)
Web analytics enabled (gates removed); `pairing_completed` + `relay_connection` added; `.env.web` host + CSP wired for the `t.zeros.build` proxy. See §16. **✅ DEPLOYED & LIVE (verified 2026-06-07):** `app.zeros.build` serves the renderer with our `_headers` CSP/HSTS; the prod `phc_` key is baked into the shipped bundle and the web build resolves to the `Zeros` prod project; the `t.zeros.build` proxy is up. Only residual is proof-of-receipt (watch the `Zeros` project's Live events).

### Phase 4 — Flags / experiments / surveys (as needed)
- Per-agent kill-switch flags; one onboarding experiment; one post-failure survey.

---

## 11. Decisions (resolved 2026-06-04)

1. **Opt-out**, with a loud first-run notice. ✅
2. **US cloud** (already provisioned; EU is a separate instance that can't be merged). **Not a problem for us:** we send **anonymous metadata only** — no PII — so GDPR data-residency exposure is minimal. PostHog's own guidance is that US cloud is acceptable for EU users *if personal data is anonymized*, which we do by design. If an enterprise/EU customer ever demands EU residency, we stand up an EU project then — little is "lost" because there's no personal data to migrate. Self-host stays the ultimate escape hatch. ✅
3. **"Find the locks" = friction/failure/drop-off funnels** (§4). ✅
4. **Reverse proxy at `t.zeros.build`.** Primary domain moved **`zeros.design` → `zeros.build`** (zeros.design being retired). *Heads-up, separate from this doc:* the relay host in code is still `relay.zeros.design` — that's its own migration. ✅

---

## 12. Sources

- PostHog pricing & free tier — https://posthog.com/pricing , https://posthog.com/docs/product-analytics/pricing
- Lenny's Newsletter × PostHog "Product Pass" (2× free tier + 1yr Scale, ~$16.5k) — https://www.lennysnewsletter.com/p/a-year-free-of-posthog-16500-value
- PostHog for Startups ($50k credits, alternative program) — https://posthog.com/startups/apply
- Electron integration tutorial (full bundle, replay, `$pageview`) — https://posthog.com/tutorials/electron-analytics
- LLM analytics / AI observability — https://posthog.com/docs/llm-analytics , https://posthog.com/docs/llm-analytics/start-here
- Anthropic Claude observability (`@posthog/ai` + `posthog-node`, `$ai_generation`) — https://posthog.com/tutorials/anthropic-analytics
- Claude Code AI observability (privacy mode keeps tokens/cost/latency/model) — https://posthog.com/docs/ai-observability/installation/claude-code
- Anonymous vs identified events (4× cheaper, `identified_only`) — https://posthog.com/docs/data/anonymous-vs-identified-events
- Reverse proxy — https://posthog.com/docs/advanced/proxy
- Privacy / GDPR — https://posthog.com/docs/privacy , https://posthog.com/docs/privacy/gdpr-compliance
- PostHog vs Mixpanel/Amplitude (no error tracking / no LLM observability in those) — https://posthog.com/blog/posthog-vs-mixpanel , https://posthog.com/blog/posthog-vs-amplitude

---

## 13. Phase 1 implementation map (2026-06-04)

**New files**
- `src/zeros/analytics/posthog.ts` — core client: init (dynamic full no-external bundle, privacy-locked config), `capture()`, `captureException()`, `setAnalyticsEnabled()`, dev/prod key selection, super properties, pre-init buffer.
- `src/zeros/analytics/consent.ts` — opt-out + first-run-notice flags (localStorage via `getSetting`/`setSetting`).
- `src/zeros/analytics/boot.tsx` — `<AnalyticsBoot/>`: init + global error listeners + first-run notice.
- `electron/ipc/commands/app.ts` — `app_info` IPC handler (runtime mode / version / platform / arch).
- `.env.example` — documents `VITE_POSTHOG_KEY_DEV`, `VITE_POSTHOG_KEY_PROD`, `VITE_POSTHOG_HOST`.

**Edited files**
- `src/app-shell.tsx` — mount `<AnalyticsBoot/>`.
- `src/shell/column3.tsx` — emit `tab_viewed` (tab type only).
- `src/zeros/ui/error-boundary.tsx` — `componentDidCatch` → `captureException`.
- `src/zeros/panels/settings-page.tsx` — **Privacy** section + `PrivacyPanel` toggle.
- `electron/ipc/router.ts` + `electron/ipc/commands/index.ts` — register `app_info`.
- `src/vite-env.d.ts` — type the `VITE_POSTHOG_*` env vars.
- `package.json` — add `posthog-js`.

**Graceful-degradation note:** with no keys in `.env`, `initAnalytics()` logs one info line and no-ops — the app runs normally. The web build is excluded (Phase 3).

---

## 14. Phase 2 implementation — agent observability (2026-06-04)

**Architecture finding (decisive):** Zeros runs agents as external CLI subprocesses (ACP / Codex app-server / stdio), so the engine never calls the Anthropic/OpenAI SDK directly → PostHog's `@posthog/ai` auto-wrapper **does not apply**. But the bridge already delivers everything to the renderer — including the structured failure (`BridgeAgentFailure` preserves `kind` + `stage` on the wire). So Phase 2 was built **entirely renderer-side**, reusing the Phase-1 posthog-js client: **no engine changes, no `posthog-node`, no Bun risk, no key-wiring.** (Two parallel codebase investigations confirmed both the lifecycle hook points and that failure data survives to the renderer.)

**Events (metadata only):**
- `agent_session_started` — `{ agent_id }`. Hook: `ensureSession` success in `sessions-provider.tsx`.
- `agent_prompt_completed` — `{ agent_id, stop_reason, duration_ms, model, input_tokens, output_tokens, cost_usd }`. Hook: successful turn completion. **Usage coverage is uneven**: Claude = tokens + cost; Codex = tokens only; Cursor/Droid/OpenCode = sparse (their engine translators don't surface per-turn usage yet).
- `agent_failed` — `{ agent_id, failure_kind, stage }`. Hook: a single `useSessionsStore.subscribe` observer that fires when any slot's `failure` is newly set (covers ensureSession / sendPrompt / loadSession in one place), deduped per chat by `kind:stage`. Recoverable failures that self-heal clear `failure` mid-retry, so only genuine end-state failures are counted.

**Files:** new `src/zeros/analytics/agent-events.ts`; edited `src/zeros/agent/sessions-provider.tsx`.

**Since implemented (was deferred, now done):**
- `agent_first_response` (TTFT) — ✅ **DONE 2026-06-07.** `{ agent_id, latency_ms, first_kind }`. Armed when a turn's prompt is dispatched (`sendPrompt` → `trackAgentTurnStarted`) and fired by that turn's first streamed chunk — assistant text, reasoning, or tool call, whichever lands first — detected at RECEIVE time in the `AGENT_SESSION_UPDATE` listener (before the rAF buffer, so latency isn't skewed by up to a frame of batching) via `trackAgentFirstResponse`. Exactly one event per turn: disarms on the first chunk, re-armed each turn, cleared on session end. `first_kind` (`message`/`thought`/`tool_call`) distinguishes think-first / act-first / talk-first turns. tsc + eslint clean.
- PostHog's native **`$ai_generation` / LLM Analytics product** — ✅ **done in Phase 2.5 (§15)** for all 5 agents.

**Agent Reliability dashboard recipe (build in PostHog):**
- Funnel: `agent_session_started` → `agent_prompt_completed`, broken down by `agent_id` → start-to-success rate per agent.
- Bar: `agent_failed` count, broken down by `failure_kind` then `stage` → *where* each agent gets stuck.
- Trend: `agent_prompt_completed` p50/p95 of `duration_ms`, broken down by `agent_id` / `model`.
- Trend: `agent_first_response` p50/p95 of `latency_ms` by `agent_id` (**TTFT**), plus a funnel `agent_session_started` → `agent_first_response` — the drop-off is the auth/spawn lock (they started an agent but never got a first token).
- Trend: sum of `cost_usd` and `input_tokens`/`output_tokens` by `model` (Claude-complete; partial elsewhere).

---

## 15. Phase 2.5 — per-turn LLM usage across all agents (2026-06-04)

**Goal:** populate PostHog's native `$ai_generation` event so the built-in **LLM Analytics** dashboards (cost / tokens / latency by model & agent) work for *all* agents.

**Root cause found:** every adapter returned `response: {} as PromptResponse`, so `PromptResponse.usage` was empty for **all** agents — Claude included (it only emitted the Channel-2 `usage_update` for the UI counter). Fix: each adapter now populates `PromptResponse.usage` (canonical `TurnUsage`) from its protocol's per-turn usage.

| Agent | Source of per-turn usage | Tokens | Cost |
|---|---|---|---|
| Claude | stream-json `result.usage` + `total_cost_usd` | in/out/cache | ✅ |
| Droid | stream-json `completion.usage` (defensive multi-shape parse) | in/out/cache (best-effort) | reported, else PostHog-computed |
| Codex | app-server `tokenUsage.last` (per-turn — **not** cumulative `total`) | in/out/cache/reasoning | ✅ PostHog-computed |
| Cursor | ACP `SessionPromptResult._meta.quota.token_count` | in/out | ✅ PostHog-computed |
| OpenCode | SDK `AssistantMessage.tokens` + `cost` | in/out/cache/reasoning | ✅ reported |

**Cost for every agent (the key fix):** PostHog auto-computes `$ai_total_cost_usd` from `$ai_provider` + `$ai_model` + tokens using its pricing DB (OpenRouter + manual fallback). So agents that don't report cost (Codex, Cursor, Droid) still get cost — we just send the **real provider** (inferred from the model name via `inferProvider()`, e.g. `gpt-*`→`openai`, `claude-*`→`anthropic`), NOT the Zeros agent id. When an agent DOES report cost (Claude, OpenCode) we pass `$ai_total_cost_usd` and PostHog uses it directly. `agent_id` is sent as a separate property for per-agent breakdowns. `chat.model` is authoritative — the ModelPill writes it to the agent's model env, so it's the exact model the engine runs.

**Mechanism (Claude/Droid):** a new optional `turnUsage` getter on the shared `StreamTranslator`, read by `stream-json-adapter`'s success return. ACP/OpenCode/Codex populate `PromptResponse.usage` directly in their adapters/translators.

**Renderer:** `sessions-provider.tsx` emits `$ai_generation` (via `agent-events.ts:trackAiGeneration`) with `$ai_model`, `$ai_provider` (real LLM vendor inferred from the model — see cost note above), `$ai_input_tokens`/`$ai_output_tokens`/`$ai_cache_*`/`$ai_reasoning_tokens`, `$ai_total_cost_usd` (only when reported; omitted → PostHog computes), `$ai_latency` (seconds), `$ai_trace_id` (= session id), and `agent_id` for per-agent breakdown. Also fixed a field-name mismatch (renderer read `cachedReadTokens`; engine sends canonical `cacheReadTokens`).

**Files — engine:** `agents/types.ts`, `shared/spec.ts`, `shared/stream-json-adapter.ts`, `claude/translator.ts`, `droid/translator.ts`, `acp/acp-adapter.ts`, `opencode/translator.ts`, `opencode/adapter.ts`, `codex/app-server-translator.ts`, `codex/app-server-adapter.ts`. **renderer:** `analytics/agent-events.ts`, `agent/sessions-provider.tsx`.

**Verified:** tsc clean (no new errors), `build:engine` + `build:ui` OK, eslint clean.
**Caveat (small):** cost is computed only for models PostHog's pricing DB knows. Mainstream models (GPT/Claude/Gemini/etc. that Codex/Cursor/Droid use) are covered; an exotic or mislabeled model name won't price (tokens/latency still chart). If one is missing, either the model string needs normalizing or a manual `$ai_total_cost_usd` can be supplied.
**Pending (you):** live-verify per agent, then open PostHog → **LLM Analytics** — generations should show cost/tokens/latency, broken down by `$ai_provider` (vendor) and `agent_id` (Zeros agent).

---

## 16. Phase 3 implementation — web build analytics (2026-06-04)

Enabled analytics on the web build (was gated off in Phases 1–2):
- Removed the `isWebTarget()` early-returns in `posthog.ts:initAnalytics` and `boot.tsx`. Web now initializes the same posthog-js client when `<AppShell>` mounts (post-pairing). Events are tagged `app_surface: "web"`; web prod → the `Zeros` project (same as desktop prod, distinguished by surface), web dev → `Zeros Dev`.
- **New web events:** `pairing_completed` (once, from `web-app.tsx`, when a valid offer mounts the app) and `relay_connection` `{ state: connecting|connected|disconnected }` (from `AnalyticsBoot` watching `useBridgeStatus()`, web-only).
- **Reverse proxy (ad-blocker resistance + first-party):** `.env.web` sets `VITE_POSTHOG_HOST=https://t.zeros.build`; `public/_headers` CSP `connect-src` now allows `https://t.zeros.build`. The deployed web client talks only to a first-party domain — no third-party tracker in the CSP, not blocked by ad-blockers.

**Files:** `posthog.ts`, `boot.tsx`, `web-app.tsx`, `public/_headers`, `.env.web`.
**Verified:** tsc clean, `build:web` + `build:ui` OK, eslint clean; confirmed the CSP entry + proxy host shipped into `dist/`.

**✅ DONE — infra (verified live 2026-06-07):**
1. **Reverse proxy at `t.zeros.build` — LIVE.** PostHog managed proxy (org-level, free); one proxy serves both projects (routed by the `phc_` key, not the host). Present in the shipped CSP and used by the live bundle. (A plain `GET /` returns 404 — expected for a PostHog proxy; ingestion endpoints live under `/i/…`, `/flags/`, etc.)
2. **`VITE_POSTHOG_KEY_PROD` baked into the build — DONE.** The live bundle at `app.zeros.build` contains the prod `phc_` key + the `t.zeros.build` host; the web build resolves `import.meta.env.DEV === false` → `prod` → the `Zeros` project (453880).
3. **Web app deployed — DONE.** `app.zeros.build` returns 200 with our `_headers` CSP + HSTS.

   *Caveat (not a gap):* web analytics initialize only **after pairing** — `AnalyticsBoot` lives in `<AppShell>`, which `web-app.tsx` mounts only once `paired === true`. So the `Zeros` prod project fills as a function of real pairings, not page visits. The only residual is proof-of-receipt: watch the `Zeros` project's Live events, or pair via a browser and watch the `POST t.zeros.build/i/…`.

**Note (resolved):** the web CSP now lists `wss://relay.zeros.build` — the relay-host migration shipped; the old `wss://relay.zeros.design` reference is gone from `public/_headers`.

---

## 17. Error & issue coverage — gaps A/B/C (2026-06-07)

A coverage audit asked: *is every error captured?* **Crashes yes** (four boundaries: React `ErrorBoundary`; renderer `window.onerror`/`unhandledrejection`; electron-main `uncaughtException`/`unhandledRejection` → `main-process-error`; engine **process** crash → sidecar `engine-crash`). But **handled** errors were not: the engine has **no PostHog client** (≈49 `console.error` sites), ~124 renderer `catch` blocks swallowed into toasts, and `git_op` recorded outcome with no reason. Closed all three — **metadata only** (the privacy contract forbids shipping raw error text, which embeds paths/branches/content).

**Shared scrubber — `@zeros/core/scrub.ts`** (`scrubError` / `redactSensitive`): redacts absolute paths (`/Users|/home/<user>` → `~`, deep paths → `/…/<file>`), long opaque tokens → `[redacted]`, and truncates message/stack. One rule, both sides of the bridge. New `"./scrub"` export in `packages/core/package.json`.

**A — Engine error relay (the big win).** New `ENGINE_ERROR` wire message (`@zeros/core` union + `KNOWN_MESSAGE_TYPES`, drift-guarded). `ZerosEngine.reportEngineError(client, origin, err)` scrubs → `client.send`. Wired at the **`workspace.handle()` catch** — so **every** git/file/workspace op failure is captured engine-wide, across **all surfaces incl. web**, carrying the structured `GitError.code` — plus an `onMessage` `.catch` safety net for any uncaught handler throw. `EXPECTED_ENGINE_ERROR_CODES` (validation / branch-in-use / not-authenticated / not-found / in-progress / detach / remote-permission) are **skipped** so error tracking stays signal — they still show up in B's funnel. The renderer (`boot.tsx`) subscribes to bridge `ENGINE_ERROR` → `captureException(origin: engine)`. Agent errors are **not** relayed here (already covered by `agent_failed`). The engine keeps **no `posthog-node`** — it relays over the existing bridge.

**B — `git_op` error kind.** `trackGitOp` now derives `error_kind` from the `GitError.code` already serialized to the renderer (`GitError.toJSON`), and the `op` enum is expanded (fetch/rebase/stage/unstage/discard/stash/merge/checkout/branch_*/pr_*/workspace_*). Wired in the Changes + Review tabs. The code is a fixed enum — zero content. (A makes git *error* capture comprehensive; B is the per-op success/outcome **funnel**.)

**C — `reportError()` helper.** `reportError(err, ctx)` in `posthog.ts` (scrub → `captureException`, tagged `handled: true`) for catch blocks that would otherwise swallow. Wired into the bridge's connectivity faults (`get_engine_port`, `relay_connect`) in `ws-client.ts`; available for broader catch-site adoption. Not for expected control flow (e.g. a git error already in `trackGitOp`).

**Files:** `packages/core/src/{scrub.ts(new),messages.ts,schemas.ts}`, `packages/core/package.json`, `src/engine/index.ts`, `src/zeros/analytics/{boot.tsx,posthog.ts,agent-events.ts}`, `src/zeros/bridge/ws-client.ts`, `src/shell/column3-tabs/{changes-tab,review-tab}.tsx`. **Verified:** tsc clean (only the pre-existing `verify-jwt.ts` error), eslint 0 errors, `@zeros/core` tsc clean, `build:engine` success.

**Coverage doctrine:** crashes → the four boundaries; handled engine/git/file errors → the `ENGINE_ERROR` relay; handled renderer errors → `reportError`; agent failures → `agent_failed`; expected git control-flow → the `git_op` funnel (not error tracking).

---

## 18. Auto-create Linear issues from errors (2026-06-07)

> **⚠️ SUPERSEDED — see §21.** We built the custom `zeros-posthog-linear` Worker described below, but ultimately went with PostHog's **native** "Linear issue on issue created" alert instead; the Worker was **retired** (CF deployment deleted + `packages/posthog-linear-webhook/` removed from the repo, 2026-06-07). Kept as the design record.

Goal: when a *real, fix-worthy* bug reaches PostHog error tracking, it becomes a Linear issue automatically. **The rule that makes this sane: automate at the issue level, not the event level.** PostHog already groups exceptions into **issues** by fingerprint, so one unique bug → one Linear issue; repeat occurrences bump the count, they don't spawn dupes.

**Native pieces (configured in PostHog):** the Linear integration is connected in both projects (one-click "Create issue" = Level 1). Error-tracking **alerts** fire on **"issue created/reopened"** and **"spike"**, with an **HTTP webhook** destination whose JSON body is fully templatable (Hog/Liquid) — so we own the payload contract.

**Level 2 — `packages/posthog-linear-webhook/` (Cloudflare Worker).** PostHog alert → webhook → Linear GraphQL. Standalone (no workspace deps, own `wrangler.jsonc`, deployed separately from the relay; default workers.dev URL). Behaviour:
- **Dedup via KV** (`${project}:${issueId}` → Linear issue id, 90-day TTL). A repeat "issue_created" is skipped; a **"spike" on an already-tracked issue adds a comment**, never a duplicate.
- **Severity → Linear priority** (critical→Urgent, major→High, minor→Low; falls back to area/title heuristics).
- **Dev vs prod** PostHog projects → optionally different Linear **teams**.
- **Auth** via a shared `WEBHOOK_TOKEN` (header / query / body).
- **Privacy:** forwards the already-scrubbed title/stack (§17); never un-scrubs.

**Level 3 — severity/area tags.** Every capture site now stamps `severity` + `area`, so PostHog issues are filterable and the webhook can route Linear priority. Engine computes severity on `ENGINE_ERROR` (non-GitError→critical, `NETWORK_ERROR`→minor, else major; added a `severity` field to `EngineErrorMessage`); renderer: main-process/engine crash→critical, render/global errors→major, handled (`reportError`)→minor.

**Setup (yours — see the package README):** create the KV namespace; set secrets (`LINEAR_API_KEY`, `LINEAR_TEAM_ID[_DEV]`, `WEBHOOK_TOKEN`, optional `LINEAR_LABEL_IDS`); `pnpm deploy`; then add **four PostHog alerts** (issue-created + spike, in each project) pointing at the Worker URL with the README's body template. **Open question:** whether PostHog's issue-level alert template exposes event properties (`severity`/`area`); if not, the Worker's area/title fallback covers routing, and the tags still make PostHog issues filterable.

**Files:** `packages/posthog-linear-webhook/{src/worker.ts,wrangler.jsonc,package.json,tsconfig.json,README.md}` (new); `packages/core/src/messages.ts` (`severity` on `EngineErrorMessage`); `src/engine/index.ts` (`engineErrorSeverity`); `src/zeros/analytics/{boot.tsx,posthog.ts}`, `src/zeros/ui/error-boundary.tsx` (severity/area tags). **Verified:** worker tsc, `@zeros/core` tsc, renderer/engine tsc (only the pre-existing `verify-jwt.ts`), eslint 0 errors, `build:engine` success.

---

## 19. Error-tracker-first optimization (2026-06-07)

Decision: PostHog is **error-tracker-first** + AI observability; product analytics is trimmed to a small high-signal set. **Key fact that drives this:** PostHog bills each product on its *own* monthly free allowance — error tracking 100K exceptions, LLM analytics 100K, product analytics 1M (×2 with the Lenny deal) — so errors and AI obs **never** consume the product-analytics quota, and vice-versa. Set a per-product **billing limit** (e.g. $0) for zero-surprise.

**Agent faults now reach Linear (the gap fix — the important one).** Agent failures were emitted only as the `agent_failed` *event* (product analytics), never as an `$exception`, so they never created a PostHog error-tracking issue → never reached the PostHog→Linear bridge. Now (`agent-events.ts` `trackAgentFailed`): **every** failure still emits `agent_failed` (the reliability funnel), and a **fix-worthy fault** — kind ∉ `{auth-required, session-expired, timeout, transport-closed, rate-limited, cancelled}` — *also* emits a `captureException` (`AgentFault: <kind>`, `area:agent`, `severity:major`) → error tracking → Linear. Recoverable / expected / auth failures stay observability-only (no Linear). The `name`-by-kind groups them into one Linear issue per fault kind, not per occurrence.

**Trim.** Cut `tab_viewed` (navigation noise, highest-volume product event; `column3.tsx`). **Kept** (low-volume, power the dashboards, "build better features" signal): `app_opened`, the agent funnel (`agent_session_started`/`agent_first_response`/`agent_prompt_completed`/`agent_session_ended`), `agent_failed`, `workspace_opened`, `git_op`, and `$ai_generation` (separate LLM-analytics quota — the per-turn AI telemetry). Cutting more would lose product-decision signal for *zero* quota benefit (separate quotas).

**Write-back (Linear link onto the PostHog issue) — deferred.** PostHog's error-issue "external reference" linking is UI / native-integration driven; a public, stable API to attach it programmatically isn't confirmed. The forward link already works (the Worker writes the PostHog issue URL into the Linear description + a hidden `<!-- posthog-issue:ID -->` marker). Revisit if the API is confirmed.

**Files:** `src/zeros/analytics/agent-events.ts` (fault routing), `src/shell/column3.tsx` (`tab_viewed` removed). **Verified:** tsc (only the pre-existing `verify-jwt.ts`), eslint 0 errors.

---

## 20. Intercom feedback loop — Help → Feedback → Intercom → Linear (2026-06-07)

The human-feedback counterpart to the machine-error pipeline. **Decision: conversation + type tag** — feedback lands in the Intercom Inbox as a thread *from the user* (repliable), and the native **"Create with Linear Agent"** (Business plan) files an informed Linear issue with status syncing back. **No embedded Messenger** (CSP-heavy); Fin AI later.

**Worker — BUILT: `packages/feedback-intercom-webhook/`** (standalone CF Worker). `POST { token, type, message, email?, name?, app_version?, area?, posthog_url?, logs? }` → Intercom **contact** (`user` if email so you can reply; else anonymous `lead`) + **user-initiated conversation** whose body is prefixed `[Type]` + metadata; an optional *real* Intercom tag when `INTERCOM_ADMIN_ID` + `INTERCOM_TAG_IDS` are set. CORS-enabled (renderer posts cross-origin). Privacy: the renderer scrubs "recent logs" via `@zeros/core/scrub` *before* posting. Deploy + secrets (`INTERCOM_TOKEN`, `FEEDBACK_TOKEN`, optional `INTERCOM_REGION`/`ADMIN_ID`/`TAG_IDS`) mirror the Linear worker; the app reads `VITE_FEEDBACK_URL` + `VITE_FEEDBACK_TOKEN`. **Verified:** worker tsc clean.

**UI — BUILT (2026-06-07).** The Help button (`column1.tsx` `SidebarFooter`) is now a **DropdownMenu** (`src/shell/help-menu.tsx`): *Documentation · Send feedback* (hidden when feedback isn't configured) *· version footer* (`Zeros v<app_info.version>`). The **Feedback modal** (`src/shell/dialogs/feedback-dialog.tsx`, `Dialog`): type `Select` (Bug / Feature request / Issue / Feedback) + message `Textarea` + optional email + a privacy note → `submitFeedback()` (`src/zeros/feedback/submit-feedback.ts`) POSTs to the Worker (reads `VITE_FEEDBACK_URL`/`VITE_FEEDBACK_TOKEN`) with the app version; result goes through the toast surface. Built with the Zeros design primitives. **Wiring:** env types in `vite-env.d.ts`; `VITE_FEEDBACK_URL` committed to `.env.web` + placeholders in `.env.example`; the Worker host added to `public/_headers` `connect-src` (web only — Electron has no renderer CSP). **Deferred:** image attach + "include recent logs (scrubbed)" (no renderer log buffer yet). **Verified:** tsc + eslint + `vite build` clean.

**To activate the modal:** add `VITE_FEEDBACK_URL` + `VITE_FEEDBACK_TOKEN` to the gitignored `.env` (desktop build) and the web build env. Until then the "Send feedback" item hides itself (`isFeedbackConfigured()`).

---

## 21. PostHog → Linear: native alert + severity-in-name (2026-06-07)

Final decision (after testing PostHog's guided wizard): use the **native "Linear issue on issue created"** error-tracking alert, **not** the `zeros-posthog-linear` webhook worker — now **retired** (CF deployment deleted + `packages/posthog-linear-webhook/` removed from the repo, 2026-06-07). The `$error_tracking_issue_created` event only exposes `event.properties.{name,description,id}` + `project.*`; it drops the underlying `$exception` custom props, so **neither** native templates nor the webhook can interpolate `severity`/`area` (confirmed via the test payload + PostHog AI).

**Severity in Linear — the working channel:** baked into the exception **name** in `captureException` (`src/zeros/analytics/posthog.ts`): `err.name = "[<severity>] <name>"` (idempotent, deterministic per call site → stable grouping). It rides through `{event.properties.name}` → Linear titles read `[PostHog] [critical] …`. One destination, no filters.

**Linear destination template:** Title `[PostHog] {event.properties.name}`; Description = a clickable issue link `[{event.properties.name}]({project.url}/error_tracking/{event.properties.id})` + `{event.properties.description}`.

**Scope:** native alert on **Zeros prod (453880) only** → Linear = production errors; **Zeros Dev (453881)** stays PostHog-only. **Verified:** tsc + eslint clean.
