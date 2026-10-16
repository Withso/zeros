# Synthetic runtime archive fixtures

This directory contains a disposable archive's public signing key, signed
InRelease, compressed Packages index and nine synthetic `.deb` packages. Package
versions are `1.2.3-1`; font payloads and copyright strings are test text, and the
LFS file is a tiny generated fixture executable. None is an upstream package or
functional font/LFS qualification.

The signing key was generated in a temporary GnuPG home for these fixtures; its
private key was destroyed. Only its public key/fingerprint and signatures remain.
To regenerate, build root-owned synthetic package metadata/payloads with
`dpkg-deb --root-owner-group --build`, record their lengths/SHA-256 in Packages,
compress with xz, record that index in Release, and clear-sign Release with a
fresh disposable key. Update `lock.json`, export the public key and destroy the
temporary private-key home. Keep every URL/identity synthetic. Tests intercept
all fetches and use these bytes offline; they verify changed archives, changed
versions, missing indexes and untrusted signatures are rejected.

Mirror tests address these same synthetic bytes by their pinned SHA-256 and
intercept both sources; the mirror field is recomputed when a test changes the
lock. `make-extract-case.py` generates the six independent archive review cases
(ordinary, writable root, chained/direct link escapes, relative parent file and
link as parent), plus ownership, duplicate-root, cycle and safe-link cases.
No package is installed and no package script is executed.

`scalable-font.ts` generates the closure probe's original minimal TrueType
fonts: an empty .notdef, one rectangular outline and distinct family/full/
PostScript identities. These fonts use no upstream data or compiler. Real
fontconfig scans validate their names, scalability and Unicode mapping before
the probe exercises them with a controlled system-font catalog.
The generator can set the SFNT revision independently of the family so the
ordinary CI test gives competing system copies a higher `fontversion` and
verifies they cannot shadow the runtime's fonts. Stock-only families must still
resolve, including after the system catalog has been cached.
