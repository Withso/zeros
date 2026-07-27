// ──────────────────────────────────────────────────────────
// ESLint flat config
// ──────────────────────────────────────────────────────────
//
// Scope: src/ + electron/ TypeScript files. Built dirs (dist*) and
// node_modules are ignored. The ruleset is deliberately thin — this
// config exists primarily to catch the failure modes that have bitten
// us at runtime (hooks-order violations that blank the renderer), not
// to enforce broad style. Style is owned by Prettier.
//
// Add rules incrementally and only when a real bug motivates one.
// Premature lint creep makes the suite expensive to maintain and
// trains developers to silence warnings rather than fix them.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "dist-electron/**", "dist-engine/**", "node_modules/**", "binaries/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Today's blank-screen bug — hooks declared after an early return
      // produce a different call count across renders and crash the
      // React tree. This rule is non-negotiable.
      "react-hooks/rules-of-hooks": "error",

      // Missing deps in useEffect/useCallback/useMemo. Kept as `warn`
      // because there are legitimate cases for stable identities (see
      // ChatBody's chatId/agentId/cwd-only dep array). Surface them
      // without blocking CI.
      "react-hooks/exhaustive-deps": "warn",

      // Codebase already names intentionally-unused args with `_`
      // (see column1.tsx's _newBranch). Match that convention.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // The codebase uses `any` deliberately in a few cross-boundary
      // spots (e.g. schema migrations in app-shell.tsx that walk
      // legacy chat records). Don't fight it.
      "@typescript-eslint/no-explicit-any": "off",

      // v0 / shadcn component files declare empty prop interfaces as
      // `interface Foo extends BaseProps {}` so future additions don't
      // require a churn-y refactor. That's a deliberate pattern, not a
      // mistake.
      "@typescript-eslint/no-empty-object-type": "off",

      // The runtime check pattern `typeof x === "string"` against a
      // narrowed-to-string union triggers false positives. Off.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",

      // Empty catch blocks (`catch { /* swallow */ }`) are an
      // intentional pattern around best-effort IPC + storage writes
      // throughout the codebase. The comment inside documents the
      // intent; the rule fires on the empty block regardless.
      "no-empty": ["warn", { allowEmptyCatch: true }],

      // Regex literals contain a handful of "unnecessary" escapes that
      // were left in deliberately for readability when escaping a
      // single char inside a character class. Downgrade to warn.
      "no-useless-escape": "warn",

      // Electron preload + a few CJS scripts use require() because
      // they're loaded outside the ESM bundle (preload.cjs is the
      // sandbox-bridged Node context). Off — these are real cases,
      // not lazy imports.
      "@typescript-eslint/no-require-imports": "off",

      // `let` declarations that look re-assignable but turn out not
      // to be are warnings, not errors — common during refactors.
      "prefer-const": "warn",

      // Case-block lexical declarations work fine here; the codebase
      // uses block-scoped `const`/`let` inside switch cases and there
      // are no shadowing surprises. Off.
      "no-case-declarations": "off",
    },
  },
  {
    // Standalone Node CJS host scripts run as their OWN Node subprocesses,
    // outside the bundle (the engine spawns them because bun can't do node-pty
    // I/O / @cursor/sdk's http2): src/engine/pty/pty-host.cjs and
    // src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs — plus the
    // Electron preload. They legitimately use require() + the Node global
    // environment, which the .ts/.tsx block above doesn't cover. Give them the
    // Node globals so `process`/`require`/etc. aren't flagged as undefined.
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        process: "readonly",
        require: "readonly",
        module: "writable",
        exports: "writable",
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        global: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
