# CodeQL: Unix-socket clients and fixed temporary paths

Target: `skills/zstack-review` (security boundaries) and `playbooks/ci-red.md`.

- **Symptom.** #822 got a critical "server-side request forgery" alert on the
  worker's credential client, then "insecure temporary file" alerts on its
  test fixtures.
- **Cause.** CodeQL models `new net.Socket().connect(path)` with a path read
  from the environment as a request-forgery sink. It does not flag
  `net.connect(path)` once the path passes an allowlist check. Fixed `/tmp/...`
  paths in tests count as insecure temporary files even in test code.
- **Rule.** Validate the socket path against the exact allowed shape
  (directory pattern, file name, no `..`) and connect with `net.connect`.
  Create test directories with `mkdtemp(join(tmpdir(), ...))`. Fix the alert;
  never dismiss it.
