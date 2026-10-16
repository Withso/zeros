## Cleanup must survive a runner's interruption

An end-of-process export alone loses intent when the runner is killed. Write
the initial signed artifact before product work and atomically checkpoint each
saved intent before its write. A predecessor's failed wake can be cleaned once
its exact signed workspace settles, while transient or unconfirmed deletion
must stop the next allocation. Never replace missing receipt proof with a name
prefix or provider scan.

The archive producer and download layout are one contract: request only the
verified artifact ID and explicitly flatten that one artifact into the path
the signature reader expects. Workflow regression covers this input too.

A work deadline also expires a reused cleanup signal. Reserve revocation time
independently, and retain the original failed stage when disconnect or cleanup
fails later. Validate terminal exit inside its named evidence stage. Real
signed-file and product-transport fixtures cover these rules without a live VM.
