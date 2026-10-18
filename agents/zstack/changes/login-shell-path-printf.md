# Print probed PATH with printf, not echo

A Design build style source failed with `node: command not found` (exit 127)
although node was installed. One line of `/etc/paths.d/homebrew` held a literal
backslash-n, and the engine probed the login PATH with `$SHELL -ilc 'echo
$PATH'`. zsh's `echo` expanded it, `pathFromProbeOutput` kept the last line,
and every repository script ran with `PATH=/opt/homebrew/sbin`. The probe result
is cached for the engine's life, so fixing the file needed a full quit and
reopen of Zeros. Print probed values with `printf '%s\n'`; shells' `echo`
differs on backslashes. Encoded in `login-shell-path.test.ts`, which runs the
real probe command through zsh, /bin/sh, bash and dash, and in case
`login-shell-path-backslash-entry`.
