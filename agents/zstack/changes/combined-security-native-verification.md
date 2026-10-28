# Combined security and native verification

- Browser smoke probes used IPv4 while the development server could bind to
  IPv6 localhost. Pin the runner to the same loopback address and retain the
  private-file serving rules. Both browser smoke entrypoints use `ui-smoke`
  mode, with the full harness scan and HMR disabled; the configuration suite
  checks these launch contracts.
- A FIFO test failed before reading its fixture because Node 22 could not
  import a CommonJS TypeScript module's named ESM export. Use the matching
  `tsx/cjs` loader, preserve the child deadline and expose bounded diagnostics.
  Linux-specific device fixtures must explicitly select Linux and supply
  descriptor-bound mount metadata on native hosts; selecting the platform alone
  does not supply `/proc` on macOS. The separate default-host case retains real
  kernel reads on Linux.
- The packaged worker fixture compared an in-flight request against a mutable
  token expectation after reading its body. Record the header's generation,
  atomically replace the token file, and require the specifically induced new
  history mutation to use the rotated credential. Unknown credentials still
  fail authentication.
- The native media smoke attempted to run the Linux-only worker reader on
  macOS. Keep that implementation on Linux. Report the Mac cloud-response
  fixture explicitly and run both hosts so native playback and the real worker
  reader each have evidence. Do not broaden worker filesystem authority to
  make a cross-platform harness pass.
- Test subprocesses use CI's `umask 022`. A private runner may retain `077` for
  its own evidence and secrets, but that mode makes ordinary context fixtures
  private and correctly excludes them from the context graph. Preserve explicit
  private-file fixtures and every privacy assertion.
- Full migration-replay cases use the migration ladder's explicit 30-second
  test budget. A five-second unit deadline timed out while all SQL transactions
  were still progressing; keep every approval and schema assertion. Custom
  local PostgreSQL clusters must also provide the `postgres` administrative
  role that the CI service and hosted authority check expect, without granting
  it to the runtime fixture.
- Git's `config --file` replaces its target, so reopening `config.lock` after
  those edits lost ownership of the lock. Stage Git rewrites privately, hold
  the original exclusive descriptor, verify its pathname before publishing and
  never remove a replacement lock. The remote-repair regression swaps the lock
  after Git's last rewrite and requires both configurations to survive intact.
- OAuth callback metadata flowed into an authorization-generation hash. Build
  that public fingerprint from confirmed database identity and revision fields.
  Equivalent UUID spellings must also share the same advisory-lock key; the
  database regressions hold the canonical lock across both mutation paths.
  Use that confirmed identity for credential envelope bindings and revocation
  notifications too; an uppercase save must decrypt through its stored identity.
- A trailing-punctuation regexp became quadratic on long internal punctuation
  runs in pasted links. A backward suffix scan preserves link parsing and runs
  in linear time; the regression isolates adversarial input in a bounded child.
- File-open analysis can overlook Darwin's numeric read-only flags. Keep the
  no-follow flags and supply an explicit private mode; do not add create/write
  flags or combine the incompatible Darwin no-follow variants. Tests inspect
  and read one held descriptor instead of reopening a checked pathname.
- A later CodeQL run also flagged a callback selected from a keyed map. Keep
  each refresh callback on its captured queue record, while map keys coalesce
  repeated requests. Settings tests retain one read per exact Local,
  organization-local and cloud root across repeated listener broadcasts.
- Forward Vitest path filters directly through a pnpm script. An extra `--`
  puts those paths in Vitest's pass-through options and can silently run the
  whole root suite. Confirm the matched file count before labeling a receipt
  as an adjacent run; retain the actual scope and any interrupted run.
