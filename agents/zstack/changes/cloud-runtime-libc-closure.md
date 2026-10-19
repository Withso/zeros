Cloud dependency staging copied both libc variants of an optional native agent
package because it checked OS and CPU but ignored libc. Match the cloud
artifact's fixed glibc target before adding payload, pnpm links or binary shims;
skip incompatible optional edges and reject required ones. A resolution link
recorded before eligibility survives as a dangling link even if the package is
skipped. The retained cloud-runtime-bundle-closure regression stages a pnpm
graph, removes its source and executes the relocated compatible agent and shim,
while proving the incompatible package and its exclusive dependencies are absent.
Metadata, required-peer and original-source controls preserve the other cases.
