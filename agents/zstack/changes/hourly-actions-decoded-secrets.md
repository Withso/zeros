## Mask decoded Actions credentials before use

The hourly fixture arrived as one base64 Actions secret. GitHub masks that
exact string, so its decoded password, private seed and native auth tokens
were not registered for masking in this public repository's logs.

Register raw and JSON-escaped decoded values with stdout-only `::add-mask::`
commands before fixture validation or file writes. Escape workflow-command
characters, cover rejected token fields too, and never send masks through the
evidence writer. Public artifacts need their own strict schema and no-secret
test: log masking does not sanitize an uploaded file.

`zeros-dev-hourly-main.test.ts` captures mask commands without printing test
keys, exercises a rejected token containing command delimiters, and proves
that an exception carrying secret values cannot enter evidence or the actual
signed receipt. The hourly artifact/workflow suites retain the upload allowlist.
