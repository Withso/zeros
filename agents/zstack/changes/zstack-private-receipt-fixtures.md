# Private receipt fixtures

CodeQL found fixed `/tmp/synthetic` arguments flowing from mocked CLI tests
into the shared receipt/source helpers. The mocks hid the real writer's
rejection of a shared writable parent. Removing the mock behavior first
retained two failing CLI regressions; both now use a real owned `mkdtemp`
directory, checked at mode 0700, and the production exclusive/no-follow
mode-0600 writer. Tests read and validate the same opened descriptor; they
never reopen the checked pathname for a later assertion.

For filesystem-facing CLI tests, use real private fixtures even when other
boundaries are faked. Keep the CodeQL result separate from adjacent test
results: passing behavioral tests alone cannot establish zero new alerts.
This lesson belongs to the CI-red playbook when fragments are folded; no
shared playbook anchor or safety policy changes here.
