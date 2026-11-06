# A macOS TMPDIR needs your own group

Target: `gotchas.md` (the macOS `TMPDIR` entry).

- **Symptom.** With `TMPDIR` under `/private/tmp`, the Design gitignore
  suite failed with `Managed Git check_ignore failed (command_failed)`. It
  passed with the default `TMPDIR`.
- **Cause.** macOS gives a new file its directory's group, and
  `/private/tmp` belongs to `wheel`. The suite checks that Git's private
  temporary files carry the process's group.
- **Rule.** Replace "Set `TMPDIR` under `/private/tmp`" with: create a
  private directory there with `mktemp`, give it your own group and use it
  (`export TMPDIR="$(mktemp -d /private/tmp/zs.XXXXXX)" && chgrp "$(id -g)" "$TMPDIR"`).
  Another user can plant a fixed name in a shared folder first; `mktemp`
  makes a new directory that only you can open. The path stays canonical and
  short enough for Unix socket paths.
- **Encoded in.** Guidance only.
