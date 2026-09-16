# Turn usage and cost

The output timer is the entry point for usage. Hover, keyboard focus or click
opens a single card with the agent, start/end time, Input, Output, Cache read
and Total cost. There is no separate cost icon or per-model price UI. A hidden
chat cannot keep this card open or revalidate its turn row.

## Canonical accounting

- `TurnUsage.accountingVersion: 1` means input includes cache reads and writes.
  Cache fields are subsets, not extra input to add in the renderer. Reasoning
  remains a subset of output. Context-window occupancy is a separate reading;
  billed token sums must never become the composer's context fill.
- Missing, invalid or unassignable cost is unavailable. A reported zero is
  `$0.00`. Claude amounts are estimates and receive the small Estimated label.
  Never calculate a Codex dollar amount from a price table.
- Legacy records lack reliable query/run baselines. Preserve them on disk;
  do not invent a historical migration. Their old dollar totals are unavailable
  in the timer card. Old token records retain provider-specific cache handling.
- `turn_usage_update` carries an absolute snapshot for an exact Zeros user
  `turnId`. Its monotonic `revision` replaces older snapshots; it is never an
  additive transcript event. The engine validates the execution/provider and
  existing turn owner before persistence. Private per-execution receipts combine
  a retry with earlier work under the same prompt without replaying either
  execution; the wire receives a monotonic combined revision. Finishing Git snapshots or an error
  cannot overwrite newer usage with stale/empty data. Deleted turns stay deleted.
- Renderer delivery invalidates only the exact turn-row cache key, retaining
  the confirmed snapshot during revalidation. Accounting updates do not restart
  activity timers, wake an idle process or add messages/tool rows.

## Provider boundaries

Claude 0.3.266 supplies query-cumulative `total_cost_usd` and `modelUsage`.
Keep their baseline for the running query, including ordinary `system/init`
turn boundaries. Start a new baseline for a new query (including resume), a
confirmed conversation replacement, or `conversation_reset` (`/clear`). Apply
reset/result UUIDs idempotently. Ignore child result frames: the root model map
already includes children and auxiliary work. Use model-map token deltas, not
the main-loop-only aggregate `usage`. Zeroed crash/stale results must not lower
confirmed counters. A missing cumulative interval makes the next snapshot a
baseline, not another turn's bill. Native input excludes caches and is converted
once to inclusive input.

Claude result correlation maps user-message UUIDs to Zeros turns. Autonomous
continuation usage extends its owning turn after `prompt()` has returned. A
result for an earlier input must not charge a newer queued input. Multiple
conflicting user owners cannot be split from a cumulative native snapshot and
must not be guessed. Per-result increments describe the work the query reported
between confirmed snapshots; they cannot reconstruct per-child invoice timing.

Codex 0.153.4 exposes no USD field. `tokenUsage.last` describes one inference,
not a whole user turn. Use changes in `tokenUsage.total`, scoped to the native
turn; repeated/retired-turn notifications cannot add tokens. Capture restored
totals during `thread/resume` before wiring the transcript translator. If resume
omits this snapshot, seed from the first new inference's `last`, then use total
deltas; missed earlier notifications cannot be reconstructed. Context-only
compaction counters rebase future deltas without erasing already counted work.
Codex native input already includes cache subsets.

Cursor 1.0.31 `RunResult.usage` sums native turns in that run. Prefer it over
separately summed stream/callback usage; never add the two delivery lanes.
Cursor native input excludes caches. `getUsage()` totals span the agent and
may change when old bills settle, so before/after agent-wide subtraction is
not turn accounting. Accept only an exact owned entry from `runs[]`.

The installed Cursor local SDK keys billing entries by usage UUID, whereas
`Run.id` is the client run ID. There is no documented public join between
those identities. Local dollars therefore remain unavailable when ownership
cannot be proved. Cloud/native entries with matching run identity are supported,
including charged zero. A bounded per-execution reconciliation lane retries
missing cost after 3, 10, 30 and 60 seconds and updates the original turn. It
stops on settlement, replacement or disposal. Failed/hung billing lookups are
bounded to 500ms and do not fail agent work. No paid live billing was exercised
by the mock-backed regression suites.

## Analytics

Prompt completion/generation events receive corrected turn snapshots. Canonical
input sets PostHog's `$ai_cache_reporting_exclusive: false`; a supplied total
uses `$ai_cost_passthrough` so per-model pricing cannot replace the provider
total. `agent_cost_source` distinguishes estimates/reported/unavailable amounts.
PostHog may calculate its own analytics estimate for unknown provider cost;
this must never be treated as a provider bill or fed back to the timer card.

`agent_turn_usage_updated` records absolute usage revisions, including late
background/billing updates. Analytics aggregating final turn totals must select
the latest revision per turn, never sum these revisions. Continuations do not
emit a duplicate `$ai_generation`. Events contain scalar accounting metadata,
not prompts, paths or transcripts.

## Retired Claude settings

Zeros no longer offers or passes `fallbackModel` or `maxBudgetUsd` to Claude.
Legacy `CLAUDE_FALLBACK_MODEL`, `CLAUDE_MAX_BUDGET_USD`, browser preferences and
settings.toml values cannot re-enable them. The TOML schema accepts the retired
keys for compatibility, describes them as ignored, and the settings mirror
removes them on its next write. Native provider fallback narration, scoped
session-model adoption and composer updates remain active. Keep sessions active
and automatic memory remain independent settings.

## Upgrade verification

Keep the Claude/Codex/Cursor `usage-accounting.test.ts` suites, shared turn
ledger tests, adapter continuation tests, DB/engine ownership tests, renderer
cache/analytics tests and `ui-smoke-turn-usage.mjs` passing when upgrading SDKs.
Cover cumulative increments, reset/resume, crashes, missing fields, replay,
subagent totals, Stop/failure usage, delayed prior-run bills, zero cost, missing
cost and hidden/keyboard-operated timer cards.

Sources checked against the installed contracts:
[Claude cost accounting](https://code.claude.com/docs/en/agent-sdk/cost-tracking),
[Cursor SDK usage](https://cursor.com/docs/sdk/typescript#agentgetusage),
[Codex pinned protocol](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/protocol/src/protocol.rs),
[PostHog manual capture](https://posthog.com/docs/ai-observability/installation/manual-capture).
