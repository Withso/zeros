# Measuring Zeros Local turns from a Mac shell

Target: `gotchas.md` (macOS drive and measurement), referenced from `zstack-drive`.

- Symptom: a turn-wait script tailing `main.log` for `agent_prompt_finished`
  never saw it. Cause: renderer analytics go through `log_submit` to
  `app.jsonl` only (`electron/ipc/commands/logs.ts`). Rule: read `app.jsonl`
  (the event is JSON-escaped in a record's `text`); `zeros.db` `turns` and
  `chat_messages` rows (read-only `sqlite3`) give settlement, tools and usage.
- Symptom: Local data and logs were not under the bundle ID. Cause: the bundle
  slug (`dev-instance.mjs`) and the data identity (`com.zeros.local.<16 hex>`)
  differ. Rule: take the identity explicitly, or the newest `zeros.db-wal`.
- Symptom: a fake-macOS test finished but its piped command hung for 300 s.
  Cause: stand-in children (`bash -c 'sleep … & wait'`) inherited stdout.
  Rule: detach stand-in trees from stdout and stop children first.
- Unattended approval presses need the card's reject row in the same shot
  (Zeros cards have Deny; provider cards have Yes and No). Clicks and keys
  re-check, in the same process, that Zeros is frontmost.
- A prompt typed in one burst and sent 0.3 s later is a worst case: after a
  pristine agent switch, chat-view admits the session at the first keystroke
  (`pristine-agent-switch.ts`), so typing hides the agent's startup. Report
  session start to first output, or pause before Send.
- `pnpm electron:local` drops inherited `ZEROS_*` variables
  (`localEnvironment`); confirm a diagnostic dial reached the process (its own
  log line) before trusting a debug run.

Encoded in `.context/cu-bench/` (`bench.sh`, `test/run-fake.sh`).
