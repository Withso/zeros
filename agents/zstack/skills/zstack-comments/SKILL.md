---
name: zstack-comments
description: "Keep Zeros comments to the non-obvious why: run a fresh-context comment pass over a diff before review, apply the Zeros keep-list, and prove comment cleanups change nothing else with scripts/zstack/comments.mjs."
globs: "**"
---

# zstack-comments

`RULES.md` §7: a comment states only a non-obvious why that the code cannot
show. That is an invariant, a trust or security boundary, a compatibility
contract, an ordering or concurrency requirement, or a quirk of an external
platform, provider or protocol.

## Pass over a diff

Run this after implementing and before `zstack-review`, with fresh eyes. An
author defends its own comments: in single-session mode, re-read the diff cold
as a separate pass; with co-masters or subagents, the agent that did not write
the code runs it. For each added or changed comment:

- Delete narration of what the code does, restated names or types, dividers,
  history and ticket narratives (the PR records them), change logs and
  commented-out code.
- Shorten an essay to the one sentence that carries the reason.
- A comment explaining a surprise in our own code is a refactor flag: rename,
  extract, type or restructure until the code says it, then delete the comment.
  Report flags you cannot fix within the task's scope.
- A constraint comment ("do not remove", "must run before X") becomes a test,
  type or lint where one can hold it (principle 18), then goes.
- Keep everything on the keep-list.

## Keep-list

Never edit or remove these as cleanup:

- **Functional comments.** SQL migrations and their `-- zeros-migration:`
  headers (checksummed and immutable), `@generated` markers and GENERATED or
  DO NOT MODIFY headers, generator markers (`agent-brief`, `workspace-brief`,
  `zeros-agent-runtime-dashboard`, `@generated tokens:`), `lock_purpose` tags,
  workflow `# vX` pins that Renovate reads, and shebangs.
- **Directives.** `eslint-disable*`, `@ts-expect-error`, `@ts-ignore`,
  `@ts-nocheck`, `@ts-check`, `prettier-ignore`, `/// <reference`,
  `/* global */`, `@vitest-environment`, `@vite-ignore`, `#__PURE__`, coverage
  ignores, `@jsx*`, JSDoc types in JavaScript files, and the repository's own
  scanner markers: `check:ui ignore-line` and `ignore-next` (never add or
  remove a line between `ignore-next` and its target), `gitleaks:allow` and
  `check-secrets:allow-*`.
- **Generated and vendored trees.** `codex/generated/**`,
  `engine/design/generated/**` and `third_party/**`.
- **Legal notices.** License, copyright, SPDX and NOTICE headers (§6).
- **Contracts.** Notes that a persisted or externally observable identifier is
  a compatibility contract (`AGENTS.md` requires them), and the public API
  documentation in `packages/protocol` (trim its narration, keep the contract).
- **Invariants.** Security boundaries, ordering and concurrency requirements,
  and external platform or provider quirks.

## Cleaning existing code

Clean in small, area-scoped PRs that change nothing but comments.

1. Pick targets: `node scripts/zstack/comments.mjs report --top 40 <paths>`
   lists comment-only lines per file, densest first.
2. Edit only comments, reading the code around each one first. When a comment
   holds an invariant the code cannot express, keep it as one sentence.
3. Prove it: `node scripts/zstack/comments.mjs verify --base origin/main` must
   report no problems. It starts at the merge base, like `git diff
   origin/main...`, and compares each file's parsed structure and token text
   with comments and layout removed. JSX text counts too: a comment between two
   text runs separates two children, so removing it fails. Protected comments
   must keep their text, order and the code they attach to, so removing,
   adding, moving or reordering one fails, and so do protected paths, added or
   removed files, mode changes and files other than JavaScript and TypeScript.
4. Run the touched test directories, `pnpm typecheck`, `pnpm lint` and
   `pnpm check:ui`.
5. After the squash merge, the next cleanup PR adds that commit to
   `.git-blame-ignore-revs`.

`agents/zstack/comment-debt.json` records the repository's divider-comment
lines, and `scripts/__tests__/zstack-comments.test.ts` fails when they grow.
Lower the number when a cleanup removes dividers.
