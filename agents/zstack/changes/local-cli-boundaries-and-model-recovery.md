# Local CLI boundaries and provider recovery

Seven findings from review of the Local CLI and provider changes became
retained regressions before their fixes:

- Response writes followed a predictable temporary symlink or hard link, and
  redirecting the drop directory also redirected publication. Create a fresh
  file exclusively, reject links in all path components, keep Linux operations
  relative to pinned directories, and never recursively clean an agent-writable
  tree. Optional transports fail closed when the host cannot enforce that.
  A native macOS probe also caught that `O_NOFOLLOW` and `O_NOFOLLOW_ANY` are
  mutually exclusive (`EINVAL`); a Linux pass cannot prove Darwin open flags.
- Message-file containment and size checks were separated from the read by a
  mutable pathname. Open without following path components, then inspect and
  read that descriptor with a byte bound. Race tests replace both the file
  after validation and an ancestor directory after canonical resolution.
- A saved chat result obscured a refused or unknown request state. Consult the
  outcome before metadata; keep failure codes and retry details when asynchronous
  sends settle. Test both immediate failures and failures after `starting`.
  Do not infer retryability from the code alone: a busy chat creation is terminal
  while a busy message send can be retried.
- Summary projection ignored its requested turn. Test named and missing turns,
  including steered user messages, against a multi-turn transcript.
- A recreated Claude query hid missing restoration on the persistent query.
  Keep a pushable query alive across turns and assert native model control
  before the next input, with both initial and newer manual selections.
- Cursor's cached settings skipped the original selection when the cache became
  invalid. Retry every not-yet-attempted requested selection before denying its
  model; test terminal and thrown refusals over three turns in one cache window.

Encoded in `local-orchestration/__tests__/{dropbox,admission,service,transcript}.test.ts`
and the Claude `adapter.test.ts` and Cursor `model-passing.test.ts` suites under
`apps/desktop/src/engine/`. These were review findings in an uncommitted change;
the adjacent regressions are their executable checks.
