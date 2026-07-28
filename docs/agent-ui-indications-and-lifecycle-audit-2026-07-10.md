# Agent Lifecycle, Transport Reconnect & UI Indications — Audit + Consolidation (2026-07-10)

Deep review of the lifecycle / transport-reconnect implementations for **Claude, Codex, and Cursor**, plus a full audit and consolidation of the **user-facing indication system**. Everything found was either fixed in this pass (marked ✅ fixed) or listed as a follow-up (§7).

---

## 1. The indication taxonomy — four types, one decision rule

The user never sees logs. Everything they learn about an agent's health comes from exactly four surfaces:

| Type | Surface | Meaning to the user | Lives where |
| :--: | --- | --- | --- |
| **1** | Inline transcript row (tool-call style, `error_notice`) | "Something happened at this point in the work" — a compact, timestamped record inside the turn | `event-row-renderer.tsx`, `event-meta.ts`; emitted by adapters/translators |
| **2** | Full-stop pill in the turn footer (`AGENT STOPPED`, `STOPPED BY USER`, …) | "This turn is over. Nothing is retrying." Terminal, calm, factual | `turn-footer.tsx` |
| **3** | Live loading indicator (shimmer / spinner) | "Still working / still trying — wait" | `event-row-renderer.tsx` ("Reconnecting agent" row), `agent-chat.tsx` ("Reconnecting…" card), `activity-hud.tsx` (working shimmer) |
| **4** | Toast | "An agent hit an error and there is no in-chat place to show it" | `agent-chat.tsx` toast effect + `toast.tsx` |

### The decision rule (now enforced in code)

```
Is the agent still trying (vendor retry or app rebuild in flight)?
  → Type 3 (loading), optionally recorded afterwards by a Type 1 row.
Did the turn end, permanently, with no further attempts?
  → Type 2 pill on that turn (+ the Type 1 row that explains why, already in the transcript).
Did something fail OUTSIDE any turn (initialize / newSession / loadSession)?
  → Type 4 toast — the only case with no in-chat anchor.
```

**Never two indications for one event.** A prompt-stage failure shows the Type 2 pill *instead of* a toast (✅ fixed — previously both fired). The only exception is `auth-required`, which keeps its toast at every stage because it carries the one actionable step ("Open Settings → Providers…").

**Copy rule:** user-facing text says *what state the agent is in*, never *why in engine terms*. The technical detail (host paths, exit codes, stack-ish messages) goes to the engine log / `console.warn` — greppable for support, invisible to the user. (PostHog capture: follow-up, §7.)

---

## 2. Type 1 — inline error rows: full inventory

| Agent | Trigger | Severity | Copy (after this pass) | Where emitted |
| --- | --- | :--: | --- | --- |
| Claude | CLI exhausted its own API retries on a network error; app recovery takes over | error | `Connection lost — reconnecting…` | `claude-sdk/adapter.ts` result branch (✅ simplified from `Claude: API connection failed after automatic retries (<raw error>)`; raw error now `console.warn`ed) |
| Claude | CLI is retrying the same call (`system/api_retry`) — settled record of a burst | warning (`code:"api_retry"`) | `Temporary connection problem (HTTP 529) — retrying automatically…` | `claude/translator.ts` (✅ simplified; one row per burst, never one per attempt) |
| Codex | app-server retrying the same turn (`error{willRetry:true}`) — settled record | warning (`code:"api_retry"`) | `Temporary connection problem — retrying automatically…` | `codex/app-server-translator.ts` (✅ simplified; was silently filtered before 2026-07-10) |
| Codex | Terminal turn error (API rejection, model unavailable, …) | error | `Codex: <vendor message>` | `codex/app-server-translator.ts` `onError` |
| Codex | Actionable advisory (deprecation, config warning) | warning | `Deprecation:/Config:/Warning: <text>` | `codex/app-server-translator.ts` `onAdvisory` (benign WS→HTTPS fallback advisory filtered) |
| Cursor | Network-shaped stream death (incl. host crash) before app recovery | error | `Connection lost — reconnecting…` | `cursor-sdk/adapter.ts` (✅ simplified from `Cursor: connection lost (cursor host: the Cursor SDK host (Node subprocess) exited unexpectedly) — reconnecting`; detail already in `[cursor-sdk]` stderr log) |

Rows are keyed by `noticeId` (reducer dedupes on replay), persist in the transcript, and expand to show the message. Codex's terminal-error row intentionally keeps the vendor message — that's a real error the user may need to read (e.g. "model X is unavailable").

## 3. Type 2 — full-stop pills: full inventory

Rendered by `turnFooterStatusLabel` (`turn-footer.tsx`), precedence top→bottom:

| Label | Trigger | Source |
| --- | --- | --- |
| `STOPPED BY USER` | User clicked Stop (live `lastStopReason:"cancelled"`, or persisted turn row `cancelled`) | live + persisted |
| `SIGN IN REQUIRED` | Prompt-stage `auth-required` | live (`footerLabelForFailure`) |
| `AGENT EXITED` | Prompt-stage `subprocess-exited` | live |
| `SESSION EXPIRED` | Prompt-stage `session-expired` surfaced terminally | live |
| `AGENT RESPONSE TIMEOUT` | Prompt-stage `timeout` surfaced terminally | live |
| `CONNECTION LOST` | Prompt-stage `transport-closed` surfaced terminally (recovery retried once and failed again) | live |
| `AGENT RESPONSE FAILURE` / (generic protocol errors) | Prompt-stage `protocol-error` | live |
| `AGENT STOPPED` | Persisted turn row `status:"failed"` with no live label — the crash-swallowed cases: duplicate-turn guard kept a partial answer; app crashed mid-turn (boot janitor settles the row); reload after any failed turn | persisted (survives restart; suppressed while a retry is warming so it never flashes mid-recovery) |

Semantics: a pill == **full stop**. Nothing behind it is retrying. The composer stays usable — typing + Send *is* the retry (✅ fixed this session: `failed` chats used to hard-lock the composer with no recovery affordance).

## 4. Type 3 — live "still trying" indicators: full inventory

| Surface | Trigger | Copy / visual |
| --- | --- | --- |
| "Reconnecting agent" shimmer row | A live `api_retry` burst (Claude CLI retry, Codex `willRetry`) is the streaming tail | `ZerosSpinner` + `Reconnecting agent` in `--fg1`; settles to a static row (RefreshCw icon, same label) the moment the stream resumes |
| Working shimmer (tail) | Any streaming turn | spinner + elapsed timer |
| "Reconnecting…" card above composer | Session status `reconnecting` (idle child crash — session-scoped; engine respawn) | ✅ now carries a slow-spin icon (loading affordance per this consolidation; supersedes the earlier no-spinner request) + `Reconnecting…` |
| (implicit) warming | Auto-rebuild+resend in flight after a recoverable failure | turn shimmer resumes when the resend streams; AGENT STOPPED pill is suppressed during this window |

Cursor has **no** "Reconnecting agent" shimmer by design: its SDK has no in-turn retry phase (status events are terminal-only). Its blips show the Type 1 row, then either the resumed answer or the Type 2 pill. Showing the shimmer there would claim a vendor retry that isn't happening.

**"No internet" mapping** (user question): while the vendor/app is still retrying → Type 3 (+ Type 1 record). Once retries exhaust and the turn is abandoned → Type 2 (`AGENT STOPPED`, or `CONNECTION LOST` if the failure surfaced live). This is exactly what ships now.

## 5. Type 4 — toasts: full inventory (after this pass)

The single agent-failure toast (`agent-chat.tsx` effect):

- **Shown only for failures with no in-chat anchor** — `initialize` / `newSession` / `loadSession` stages (✅ fixed: prompt-stage failures no longer toast; the Type 2 pill owns them).
- **Simple copy** (✅ fixed): title `"<Agent name>: <short label>"` where label ∈ {`Agent error`, `Sign in required`, `Session expired`, `Timed out`, `Disconnected`, `Agent exited`, `Agent response failure`}. **No technical description** — the raw message is `console.warn`ed instead (e.g. the old `cursor-sdk newSession failed: cursor host: the Cursor SDK host crashed 3 times…ZEROS_PTY_HOST_RUNTIME…` blob no longer reaches the user).
- **Exception**: `auth-required` keeps a description because it's actionable: `Open Settings → Providers to sign in to <Agent>.`
- **De-duplicated** (✅ fixed): keyed `id: agent-error-<chatId>` — a repeat of the same chat's failure *replaces* the toast instead of stacking identical copies (the double-toast screenshot). Transport-shaped noise is still filtered outright (`isTransportShaped`).

Other agent-adjacent toasts (kept, already simple + actionable): `"<agent>: Not installed"` / `"<agent>: Sign in required"` (pre-send agent checks), `"Agent no longer available"`, `"Couldn't send now"`, `"Answer didn't reach the agent"` (question-ack watchdog), turn-reset outcome toasts.

---

## 6. Lifecycle & transport-reconnect audit — per agent

All flows below were re-verified this session; each has automated coverage (819+ tests across `src/engine/agents` + `src/zeros/agent`, all green).

### Claude (persistent SDK query, one child per agent)
| Scenario | Behavior | Indication | Tests |
| --- | --- | --- | --- |
| Network blip mid-turn | CLI retries same call (`api_retry`); turn continues, nothing lost | Type 3 shimmer row → settles to Type 1 record | `translator.test.ts` |
| Retries exhausted, nothing streamed | `transport-closed` → silent rebuild (`--resume`, full context) + resend | Type 1 row; then normal answer | `adapter.test.ts` |
| Retries exhausted, partial streamed | Partial kept (duplicate-turn guard) | Type 1 row + Type 2 `AGENT STOPPED`; "continue" resumes in context | `turn-footer.test.ts` |
| Idle query death | Next prompt lazily recreates the query with `resume` | none needed (invisible self-heal) | adapter design |
| Stale `--resume` | `session-expired` → rebuild + replay-preamble | invisible by design | recovery tests |
| Not signed in | `auth-required` | Type 4 toast (actionable) + `SIGN IN REQUIRED` pill | classification tests |

### Codex (one app-server child per chat)
| Scenario | Behavior | Indication | Tests |
| --- | --- | --- | --- |
| API blip mid-turn | app-server retries same turn (`willRetry`) | Type 3 shimmer row → Type 1 record | `app-server-translator.test.ts` |
| Child dies mid-turn | Recoverable transport-closed → rebuild (`thread/resume`) + resend; partial → keep + pill | Type 3 during rebuild; Type 2 if kept partial | `app-server-adapter-reconnect.test.ts` |
| Child dies idle | **Session-scoped** exit — only that chat flips `reconnecting`; siblings + pool untouched; next send revives | Type 3 card | `sessions-store-agent-exit.test.ts` (7 cases) |
| Rollout gone | `session-expired` → fresh thread fallback | invisible | failure tests (99) |
| Overloaded server (-32001) | Request-level backoff retry, pre-stream | none (sub-second; working shimmer covers) | runtime tests |

### Cursor (shared Node host subprocess)
| Scenario | Behavior | Indication | Tests |
| --- | --- | --- | --- |
| Network stream death | `transport-closed` → rebuild (`Agent.resume`, server-side thread) + resend | Type 1 `Connection lost — reconnecting…`; Type 2 if partial kept | `reconnect-notice.test.ts` |
| Host crash (unexpected) | Tagged `CURSOR_HOST_EXITED` → recoverable; host respawns lazily | same as above (was a hard toast before 2026-07-10) | `host-client.test.ts`, `classify.test.ts` |
| Host crash-loop (≥2 early deaths) | Exponential respawn hold-off (1s→2s→…→30s cap), no process machine-gunning | Type 3-ish muted reconnecting after silent retry | `host-client.test.ts` crash-loop suite |
| Host crash-loop (≥3) | TERMINAL — actionable message (log location, reinstall, `ZEROS_PTY_HOST_RUNTIME`); half-open retry after hold-off; **send = retry** | Type 4 toast (session stage) — now simple title, detail in log | same |
| Fatal boot (`@cursor/sdk` unloadable) / spawn failure | Terminal (respawn would fail identically) | Type 4 toast | same |
| TLS interception | Terminal `protocol-error` with actionable copy (kept verbose deliberately — the fix is environmental) | Type 4 toast (log carries full text) | `classify.test.ts` |

### Engine-level
| Scenario | Behavior | Tests |
| --- | --- | --- |
| Electron dies without cleanup | Engine self-exits: stdin-EOF + 15s ppid watchdog (armed only via `ZEROS_PARENT_PID`), bounded 3s graceful stop | manual (process-level) |
| Crash leaves `running` turn rows | Boot janitor settles them `failed` → honest `AGENT STOPPED` on reopen | `turns.test.ts` |
| Renderer inactivity watchdog | 30-min prompt inactivity abort — comfortably above any retry backoff | design check |

---

## 7. Fixes shipped in this pass (2026-07-10, branch `iamarunrk/bern`)

1. Prompt-stage failures no longer toast — Type 2 pill owns them (no double indication). `agent-chat.tsx`
2. Toast copy simplified: `"<Agent>: <short label>"`, no technical description (except actionable auth). Detail → `console.warn`. `agent-chat.tsx`
3. Toast de-dup by `id` (repeat failures replace, never stack). `agent-chat.tsx`, `toast.tsx`
4. Type 1 row copy simplified across Claude/Codex/Cursor (see §2 table); technical detail routed to logs.
5. "Reconnecting…" card now carries a loading spin (Type 3 affordance).
6. Earlier same-day (see the parity doc's ✅ rows): AGENT STOPPED pill; session-scoped codex exits; Claude `api_retry` + exhausted-retry recovery; Codex `willRetry` parity; Cursor reconnect row; host-crash recoverable; crash-loop guard; failed-chat composer unlock (send = retry); sidecar env-override respect; engine parent-death self-exit; orphan turn-row reconcile.

## 8. Follow-ups (not blocking)

- ~~**PostHog capture** of failure details (kind, stage, agent, message hash)~~ ✅ **Done (2026-07-10):** `trackAgentFailed` (`src/zeros/analytics/agent-events.ts`) now sends `message_hash` — an FNV-1a hash of the technical failure message with volatile fragments (paths, ids, pids, counts) normalized away — on both the `agent_failed` event and the `AgentFault` exception. Raw text never leaves the app (pinned by `agent-events-pii-contract.test.ts`); the hash keeps distinct faults behind the same kind:stage distinguishable and recurrences grouped.
- **Attempt counter** on the live "Reconnecting agent" row ("attempt 3/10", per the reference screenshot) — needs reducer support for updating an existing notice row by `noticeId` (currently insert-only by design). One row per burst was chosen to avoid transcript spam; revisit if users want progress detail.
- **Cursor terminal-error copy** (TLS, plan/model gating) is still verbose in the toast's *log line*; the toast itself is now simple. If those cases prove common, give them dedicated short labels + a "Learn more" action.
- ~~**`STOPPED BY USER` after reload** for the SIGTERM'd-subprocess cancel race~~ ✅ **Done (2026-07-10):** cancel-intent is now threaded into `finishTurn`. `AGENT_CANCEL` (and the remote-client-drop relay cancel) record the sessionId in `cancelRequested` before dispatching; if the in-flight prompt then REJECTS (SIGTERM'd subprocess racing the clean `stopReason:"cancelled"`), the `AGENT_PROMPT` catch records the turn row `cancelled`/`"cancelled"` instead of `failed` — so the reloaded footer reads `STOPPED BY USER`. The intent is cleared when the prompt settles and at the start of the next prompt (a stale Stop can't mislabel a later genuine failure). `src/engine/index.ts`.

## 9. Manual verification checklist (UI) — with concrete commands

Prerequisite for every scenario: run the dev app from this workspace's Mac mirror (the only checkout with today's code):

```bash
cd /Users/arunrajkumar/conductor/remote-workspace-sync/Zeros/78e09b32-94d0-4c8b-bdc7-f7e6e27e3cf1
pnpm electron:dev
```

Long-turn prompt used throughout: `Write a 1000-word essay on the history of computing, then summarize it in 5 bullet points.`
pfctl block (instant, deterministic — `return` refuses connections instead of silently dropping): run mid-stream; restore with `sudo pfctl -f /etc/pf.conf && sudo pfctl -d`. Domains: Claude `api.anthropic.com`, Codex `chatgpt.com, api.openai.com`, Cursor `api2.cursor.sh`.

1. **Type 3 → recovery** (Claude/Codex chat): send the long prompt; once text streams, `echo 'block return out quick to { api.anthropic.com }' | sudo pfctl -ef -` (Codex: use its domains). Expect the shimmering **"Reconnecting agent"** row (fg1) within ~30–60s. Restore within ~2 min → answer continues in the SAME turn; the settled row becomes a static "Reconnecting agent" record with the simple message on expand.
2. **Type 2** (same drill): keep the block up until the CLI's retries exhaust (~5+ min). Expect: partial answer kept + **AGENT STOPPED** pill; **no toast** (prompt-stage). Restore the network, type `continue` → resumes with the partial work in context.
3. **Type 1 (Cursor)**: long prompt in a Cursor chat; mid-stream `kill -9 $(pgrep -f cursor-host.cjs)`. Expect the short `Connection lost — reconnecting…` row, then silent recovery (or partial + pill if content had streamed); no toast.
4. **Type 4**: `echo 'process.exit(1)' > /tmp/bad-cursor-host.cjs`, then relaunch with `ZEROS_CURSOR_HOST_SCRIPT=/tmp/bad-cursor-host.cjs pnpm electron:dev`. Send twice in a Cursor chat (3 boot deaths) → ONE toast: `Cursor Agent: Agent error` (no stack blob; detail in devtools console + engine log); further sends replace the toast, never stack. Composer stays typable; heal with `cp src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs /tmp/bad-cursor-host.cjs`, wait ≤30s, send again → works.
5. **Stop button**: send the long prompt, click Stop mid-stream → `STOPPED BY USER` pill, no toast, composer ready. Then quit + reopen the app: the turn must STILL read `STOPPED BY USER` (cancel-intent fix above), not `AGENT STOPPED`.
