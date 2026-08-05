# Third-party source licenses

This directory preserves upstream license texts for source or assets copied
into the repository. Keep one lowercase directory per upstream project and do
not modify its license text.

Package-manager dependencies are inventoried separately in the generated
[`THIRD-PARTY-LICENSES.txt`](../THIRD-PARTY-LICENSES.txt). Human-readable
provenance, version pins, trademark notes, and release-review requirements live
in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).

When adding copied, adapted, generated, or branded material:

1. Confirm that its terms allow the intended use and distribution.
2. Store the exact upstream license or notice here when required.
3. Record the source, version or retrieval date, paths, and modifications in
   `THIRD-PARTY-NOTICES.md`.
4. Add a source header to modified files when the license requires one.
5. Run `pnpm check:licenses` and the applicable packaging checks.

A public URL, package download, or brand-kit link is provenance, not by itself
an open-source license or permission for every use.
