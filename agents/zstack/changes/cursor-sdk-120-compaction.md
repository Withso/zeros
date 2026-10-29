# Cursor SDK 1.2.0: instructions and context compaction

PR: 767. zstack 0.1.7. Mode: owner-authorized Claude Opus 5.5 master and
Codex GPT-6 Astra max-effort co-master; no further agents. Work and verification
use the isolated zeros-pr767 tree. The master reviews/pushes; the owner merges.

- Symptom: the native repository-instruction sentinel failed after the SDK
  upgrade. Cause: its text decoder changed from `fs.promises.readFile` to an
  opened descriptor's `readFile`. Rule: observe every actual read path, then
  assert the native assembled rule and negative setting-source controls before
  adding an instruction workaround. Encoded in the native MCP probe and tests.
- Symptom: automatic Cursor summaries disappeared into unknown events and
  `/compact` was ordinary text. Cause: the new stream variant and SDK method had
  no consumers. Rule: inventory messages as well as tools; reconcile callback
  and stream lifecycles, keep private summary text out of narration, and never
  equate turn completion with compaction success. Encoded in Local/cloud
  translators, installed-schema coverage, persistence parity and browser smoke.
- Manual compaction owns the session from native start through completion.
  Refuse prompts, duplicate compactions and steering while it runs; a pending
  prompt's send also counts as busy. Stop/disposal fences a late run. Regressions
  first reproduced missing behavior and then the steering edge case.
- The worker still rejects manual compaction for every provider; automatic
  rows work there. This preserves the existing placement boundary explicitly.
- The bot branch predated the required merged runtime work. Compare its actual
  ancestry before interpreting unrelated reverse surface diffs. The master
  approved a normal merge of main; the branch was not rebased.

Evidence: adjacent and full suites, native instruction assembly, packaging and
browser receipts in `.context/pr767/verification.md`. Live inference and
platform-only checks are listed separately from offline evidence there.
