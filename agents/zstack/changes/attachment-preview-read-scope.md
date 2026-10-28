# Pending preview reads in a retained workbench

The full UI runner shares browser storage across scenarios. A cloud workspace
key reused by the pending-upload fixture restored an earlier File tab. Its
legitimate startup read made three global zero-read assertions fail, even
though the new preview used its Blob, retained the same URL through upload
completion, and released its lease when hidden.

Keep a real persisted File tab in the regression for Local, organization-local
and cloud. Preserve its fixture bytes across navigation and confirm the restored
content is visible before measuring the new upload; a logged read can still
have failed against an empty fixture filesystem. Consume the saved filesystem
once, synchronously before tab reads, and only for its exact workspace key.
Then assert that opening, completing and closing the new preview add no reads.
This preserves the no-extra-I/O contract without treating unrelated startup
work as an attachment read or hiding contamination by clearing browser storage.
The pending-upload browser smoke retains this restoration assertion.
