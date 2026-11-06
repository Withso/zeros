# A macOS TMPDIR needs your own group

Target: `gotchas.md` (the macOS `TMPDIR` entry).

- **Symptom.** With `TMPDIR` under `/private/tmp`, the Design gitignore
  suite failed with `Managed Git check_ignore failed (command_failed)`. It
  passed with the default `TMPDIR`.
- **Cause.** macOS gives a new file its directory's group, and
  `/private/tmp` belongs to `wheel`. The suite checks that Git's private
  temporary files carry the process's group.
- **Rule.** Replace "Set `TMPDIR` under `/private/tmp`" with: create a
  directory there with your own group and use it
  (`mkdir -p /private/tmp/zs && chgrp "$(id -g)" /private/tmp/zs`). The path
  stays canonical and short enough for Unix socket paths.
- **Encoded in.** Guidance only.
