# Pending preview reads in a retained workbench

The full UI runner shares browser storage across scenarios. A cloud workspace
key reused by the pending-upload fixture restored an earlier File tab. Its
legitimate startup read made three global zero-read assertions fail, even
though the new preview used its Blob, retained the same URL through upload
completion, and released its lease when hidden.

Keep a real persisted File tab in the regression for Local, organization-local
and cloud. Confirm its restoration read before measuring the new upload, then
assert that opening, completing and closing that preview add no reads. This
preserves the no-extra-I/O contract without treating unrelated startup work as
an attachment read or hiding contamination by clearing browser storage.
