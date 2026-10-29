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
  New prompts wait through its success or failure; Stop cancels that wait
  before native send, even before summarize returns a run. Compaction itself
  refuses duplicate compactions and every preparing or unsettled prompt;
  steering remains queued while it runs. Stop/disposal fences a late run.
- Review caught a prompt-admission regression: a boolean prompt lock also
  rejected the engine's intentional overlap after releasing a ghost prompt.
  Count in-flight prompts only for compaction admission; settling an older
  prompt must not clear a newer prompt's busy state. Regressions cover overlap,
  pending sends, configuration preparation, summary success/failure and Stop.
- A published compaction row must settle before disposal fences its emitter.
  Flush unconfirmed rows as failed before marking the session retired; late
  native completion cannot change them. Tests cover session and adapter disposal
  without relying on native cancellation to finish the summary stream.
- The worker still rejects manual compaction for every provider; automatic
  rows work there. This preserves the existing placement boundary explicitly.
- The bot branch predated the required merged runtime work. Compare its actual
  ancestry before interpreting unrelated reverse surface diffs. The master
  approved a normal merge of main; the branch was not rebased.

Evidence: adjacent and full suites, native instruction assembly, packaging and
browser receipts in `.context/pr767/verification.md`. Live inference and
platform-only checks are listed separately from offline evidence there.
