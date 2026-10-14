# Literal, complete package export substitution

CodeQL on PR #510 flagged a single-occurrence replacement in the Design
Tailwind package-export resolver. Repeated target wildcards left a literal `*`
in the resolved path, and replacement-string `$` sequences could alter the
matched subpath. Substitute every wildcard with a callback that returns the
literal match. Keep regressions for repeated wildcards, nested subpaths,
`$&`, `$$`, and rejection of targets outside the package in
`design/__tests__/style-tailwind.test.ts`. The four positive regressions failed
before the fix; CodeQL analysis remains separate verification from unit tests.
