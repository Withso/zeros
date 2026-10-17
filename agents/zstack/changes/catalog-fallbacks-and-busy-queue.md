# A provider's refusal reason, the catalog's fallbacks, and an undelivered send

- Symptom: Grok 4.7 showed "Unavailable for this account" and replies said
  "Model fallback used composer-2". Cause: Cursor's run backend refused the
  *settings* ("AI Model Not Found Invalid parameters for registry model") —
  including the account's own default variant — while the same id had run with
  other settings. The classifier called it model-unavailable, the adapter
  denied the model for the account and retried on a hard-coded `composer-2`
  outside the curated catalog. The earlier fix assumed guessed parameters; the
  stored run records disproved that. Rule: read the provider's own run error
  (Cursor keeps it with the sent params in
  `provider-state/cursor/<workspace hash>/runs.ndjson`) before deciding why a
  model "is unavailable"; retry the account's advertised settings before
  denying the model; substitute only from `catalogs/models-v1.json`
  `fallbacks`; only curated models become a chat's saved model for any agent.
- Symptom: an agent's Zeros Local CLI message and the user's "hi" raced; "hi"
  got "The agent is already responding to this chat" with Retry, and the agent
  turn's output grouped under the refused bubble. Cause: the renderer treated
  an undelivered busy refusal as a turn failure, and turn grouping is
  positional. Rule: busy is typed (`activeTurn`) and queues the send behind the
  running turn; failure cards belong to the latest turn only and retire to a
  one-line status once a newer turn starts; reconnect notices are live status.
- Gotcha: a pure helper plus the real store is enough to prove the queue path;
  the send callback itself is too large to extract for a unit test.

Encoded in Cursor `model-passing.test.ts` (settings ladder, curated fallbacks,
window expiry, exact mode), `models-catalog-validity.test.ts`,
`shared/__tests__/curated-models.test.ts`, the Claude/Codex adapter suites
(non-catalog session fallback), `agent-model-fallback.test.ts`,
`busy-turn-queue.test.ts`, `turn-footer.test.ts`, `transcript-notices.test.ts`
and `agent-session-reload.test.ts`.

Eval cases to add under `../evals/cases/` once the PR number exists (strict
validation rejects `fixedBy: "pending"` on this long-lived branch):


```json
{
  "id": "cursor-settings-refusal-not-account-denial",
  "kind": "replay",
  "area": "vm-engine-agents",
  "fixedBy": "pending",
  "symptom": "Every Grok 4.7 Extra High turn ended with Cursor's \"Invalid parameters for registry model\" (the account's own default-variant parameters included). The adapter treated it as account denial, greyed Grok 4.7 as \"Unavailable for this account\", and retried on the hard-coded composer-2, a model outside the curated catalog.",
  "rule": "Read the provider's stored run error before believing \"unavailable\". Settings refusals retry the account's own advertised settings for the same model; only a refused model is denied, and every substitute comes from the catalog's fallbacks. See docs/agent-tool-presentation.md and catalogs/README.md.",
  "check": "pnpm exec vitest run apps/desktop/src/engine/agents/adapters/cursor-sdk/__tests__/model-passing.test.ts apps/desktop/src/renderer/features/agent/__tests__/models-catalog-validity.test.ts apps/desktop/src/engine/agents/adapters/shared/__tests__/curated-models.test.ts apps/desktop/src/engine/__tests__/agent-model-fallback.test.ts"
}
```

```json
{
  "id": "busy-send-queues-behind-running-turn",
  "kind": "replay",
  "area": "renderer",
  "fixedBy": "pending",
  "symptom": "An agent's Zeros Local CLI message started a turn as the user sent \"hi\". The engine refused \"hi\" as busy, the chat showed a Retry banner, and the agent turn's output grouped under the refused bubble, pushing the banner below it.",
  "rule": "An undelivered busy send is not a failure: the engine returns the running turn as typed activeTurn and the renderer queues the send behind it. Failure cards belong to the latest turn only and retire to a one-line status once a newer turn starts; reconnect notices are live status, then a quiet row.",
  "check": "pnpm exec vitest run apps/desktop/src/renderer/features/agent/__tests__/busy-turn-queue.test.ts apps/desktop/src/renderer/features/agent/__tests__/turn-footer.test.ts apps/desktop/src/renderer/features/agent/__tests__/transcript-notices.test.ts apps/desktop/src/engine/__tests__/agent-session-reload.test.ts"
}
```
