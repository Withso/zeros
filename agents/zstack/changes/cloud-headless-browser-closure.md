# Probe the executable selected by the real launch options

Symptom: the cloud archive carried an unused full Chromium download, and its
asset probe required that binary even though capture launches the headless shell.
Cause: Playwright's `chromium.executablePath()` names headed Chromium; it does not
describe `launch({ headless: true })` without a channel.
Rule: shrinking a native closure must verify the executable selected by the real
caller, with fallback binaries absent. Keep sandboxing, fonts, notices and
positive teardown in the verification.
Encoded in `cloud-runtime-browser-closure.test.ts` (actual installer dry-run and
production closure namespace, including missing, wrong and escaped shell
controls) and `cloud-runtime-system-assets-native.test.ts` (pinned sandboxed
default headless launch, fonts, PNG and exact process exit). Runtime/base
qualification remains separate from offline closure evidence.
