# Adapter contract fixtures

One JSONL-per-scenario dump of a real CLI's `stream-json` output.
`scripts/test-adapters.mjs` replays each fixture through the
corresponding translator and asserts:

1. No unknown-event warnings (every line maps to a known event kind).
2. A monotonic sequence of `SessionNotification.sessionUpdate` kinds
   matches the golden list next to the fixture (`.expected.json`).
3. `stopReason` + `sawResult` / `sawTurnTerminal` end up in the
   expected terminal state.

When a vendor ships a stream-json schema change, this is the first
place it breaks — fixture lines that used to map cleanly now hit the
translator's `onUnknown` hook, and CI fails loud. That's the intended
early-warning system for "Codex shipped a new event type".

## What this suite covers today

The live fixture suite is **Claude-only** — `claude-basic.jsonl` is the
sole checked-in fixture, exercising the `ClaudeStreamTranslator`
(`src/engine/agents/adapters/claude/translator.ts`), which is the live
translator the Agent SDK adapter (`claude-sdk/`) reuses.

The other agents are not stream-json-fixture-tested here:

- **Codex** uses the long-lived `codex app-server` JSON-RPC transport,
  not `codex exec --json`. Its coverage lives in
  `src/engine/agents/adapters/codex/__tests__/` (translator unit + live
  `initialize` smoke). The `codex exec --json` flow is retained only for
  ephemeral one-shots (PR titles / classifiers) and is not fixture-tested.
- **Cursor** runs through the bundled `@cursor/sdk` in-process
  (`cursor-sdk/`), with its own typed translator — there is no
  stream-json output to capture for the default path (the `cursor-agent`
  CLI is only a hidden fallback behind `ZEROS_CURSOR_CLI=1`).

> Note: `cursor-agent` and `amp` are still registered terminal-agent
> CLIs in Zeros — they simply have no stream-json fixtures in this suite.

## Capturing a new fixture

Run the CLI with its stream-json flag, pipe to a file, run a small
representative prompt, then trim to the first ~50 lines:

```sh
# Claude
claude -p "what is 2+2?" --output-format stream-json --verbose \
    > scripts/fixtures/claude-basic.jsonl
```

Then commit `foo.jsonl` and `foo.expected.json` side-by-side.
`foo.expected.json` lists the ordered `sessionUpdate` kinds the
translator should produce; generate it by running
`pnpm test:adapters --write` once and reviewing the diff.

## Why JSONL fixtures, not live CLI invocation

Live invocation would be flaky (auth expiry, network, rate limits)
and would require credentials in CI. Fixtures are deterministic,
check in with the repo, and anyone can reproduce a failure by
reading the fixture file. The fidelity cost is accepting that
fixtures go stale when a vendor ships a schema change — which is
exactly what we want CI to tell us.
