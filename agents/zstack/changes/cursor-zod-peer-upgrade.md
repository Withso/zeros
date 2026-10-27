# Retiring a provider dependency exception

The desktop Cursor pin advanced while the standalone cloud worker retained the
older SDK. That kept its private vulnerable zod copy in the shared lockfile,
while the audit guard still required the previous desktop pin. The merged
license bundle also lacked the new desktop platform package.

For a provider upgrade, trace every deployable importer, advertised version,
native driver constant and package test before retiring an audit exception.
Refresh the lockfile, run the frozen install so the worker's installed graph
matches, and regenerate licenses after all pins agree. Prove the vulnerable
package is absent from both lock entries and resolved dependency edges; a root
manifest version alone is not that proof. Review declaration changes against
the installed SDK, separating zod typing changes from product capabilities.

Encoded in `scripts/__tests__/audit-exceptions.test.ts`, the worker's
`src/__tests__/package.test.ts`, the existing optional-platform inventory test
in `scripts/__tests__/repository-layout.test.ts`, and the fingerprinted runtime
surface decisions. The audit regression rejects the retired advisory and every
zod copy below its patched floor in the root and control-plane graphs.
