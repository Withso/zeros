# A packaging dependency bump can pass PR CI and break the release ZIP

The electron-builder 26.8.1 → 26.15.0 bump passed every PR check, then every
Alpha release failed signature verification of the updater ZIP ("bundle format
is ambiguous" in `ReactiveObjC.framework`) while the DMG passed. 26.15.0 moved
from the bundled p7zip 16.02 to a downloaded 7-Zip 24.09, which follows symlinks
unless given `-snl`, so framework `Versions/Current` links became directories.
PR packaging builds only an unpacked `--dir` app, so nothing before the release
created that ZIP. When bumping electron-builder or its toolsets, reproduce the
archive step on Linux (same 7-Zip release) or rely on
`scripts/__tests__/electron-builder-mac-zip-symlinks.test.ts`, which runs the
real archive code with a recording 7za. Fixed by 26.15.4; recorded in
docs/deployment-environments.md.
