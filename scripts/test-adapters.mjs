#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// test-adapters.mjs — adapter contract tests
// ──────────────────────────────────────────────────────────
//
// Replays every fixture in scripts/fixtures/*.jsonl through the
// matching translator and compares the emitted sessionUpdate
// sequence against the adjacent *.expected.json.
//
// Why: when a vendor ships a new stream-json event (e.g. Codex
// adds `turn.aborted`), the translator's `onUnknown` hook fires
// and the fixture's expected list drifts. That's exactly the
// early-warning we want in CI.
//
// The translators live in TS source; we compile them inline with
// esbuild so this script doesn't need a separate build step. esbuild
// is pinned at ^0.21 as a direct devDep in package.json so top-level
// resolution stays stable for the build scripts that import it —
// without the pin, hoisting picks arbitrarily between Vite 5.4's
// 0.21 and Vite 7's 0.27.
//
// Usage:
//   pnpm test:adapters              # run all, fail on mismatch
//   pnpm test:adapters --write      # regenerate expected.json files
// ──────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const TMP_DIR = path.join(ROOT, ".zeros", "adapter-tests");

const WRITE = process.argv.includes("--write");

// Per-translator metadata. Add an entry when shipping a new adapter.
// `translatorPath` is the TS source relative to repo root; `className`
// is the exported class the fixture runner will instantiate.
//
// Codex used to live here as `CodexStreamTranslator` against the
// per-turn `codex exec --json` stream. As of B4 (2026-05-24) Codex
// runs through `codex app-server` JSON-RPC instead, and its event
// translator (`CodexAppServerTranslator`) is exercised by vitest unit
// tests at src/engine/agents/adapters/codex/__tests__/. The fixture
// format here (newline-delimited stream JSON) doesn't map cleanly to
// JSON-RPC notifications, so we kept the vitest path instead of
// converting fixtures.
const TRANSLATORS = {
  ClaudeStreamTranslator: {
    translatorPath: "src/engine/agents/adapters/claude/translator.ts",
    className: "ClaudeStreamTranslator",
    terminalFlag: "sawResult",
  },
};

async function compileTranslator(translatorPath, outFile) {
  await build({
    entryPoints: [path.join(ROOT, translatorPath)],
    outfile: outFile,
    format: "esm",
    platform: "node",
    target: "node20",
    bundle: true,
    // `node:` builtins stay external; translators only depend on
    // `node:crypto` + type-only imports from `../../types`.
    external: ["node:*"],
  });
}

async function runFixture(fixtureBase) {
  const fixturePath = path.join(FIXTURES_DIR, `${fixtureBase}.jsonl`);
  const expectedPath = path.join(FIXTURES_DIR, `${fixtureBase}.expected.json`);

  if (!fs.existsSync(expectedPath)) {
    throw new Error(`missing ${fixtureBase}.expected.json`);
  }
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf-8"));
  const spec = TRANSLATORS[expected.translator];
  if (!spec) {
    throw new Error(
      `unknown translator "${expected.translator}" — add it to TRANSLATORS in test-adapters.mjs`,
    );
  }

  // Compile the TS translator to an ESM file we can dynamically
  // import. One compile per fixture is wasteful but simple; our
  // fixture count is tiny and build() is milliseconds.
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outFile = path.join(TMP_DIR, `${fixtureBase}.translator.mjs`);
  await compileTranslator(spec.translatorPath, outFile);

  const mod = await import(pathToFileURL(outFile).href);
  const Translator = mod[spec.className];
  if (!Translator) {
    throw new Error(
      `translator bundle has no export named ${spec.className}`,
    );
  }

  const actualUpdates = [];
  const unknown = [];
  const translator = new Translator({
    sessionId: "fixture-sess",
    emit: (n) => actualUpdates.push(n?.update?.sessionUpdate ?? "<no-update>"),
    onUnknown: (e) => unknown.push(e),
  });

  const fixture = fs.readFileSync(fixturePath, "utf-8");
  for (const line of fixture.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `${fixtureBase}.jsonl: invalid JSON line: ${trimmed.slice(0, 80)}…`,
      );
    }
    translator.feed(parsed);
  }

  const terminalFlag = spec.terminalFlag;
  const actual = {
    expectedUpdates: actualUpdates,
    stopReason: translator.stopReason,
    [terminalFlag]: translator[terminalFlag],
  };

  if (WRITE) {
    const next = {
      ...expected,
      expectedUpdates: actualUpdates,
      stopReason: translator.stopReason,
      [terminalFlag]: translator[terminalFlag],
    };
    fs.writeFileSync(expectedPath, JSON.stringify(next, null, 2) + "\n");
    return {
      name: fixtureBase,
      status: "written",
      unknown,
    };
  }

  const mismatches = [];

  if (
    expected.expectedUpdates.join(",") !== actualUpdates.join(",")
  ) {
    mismatches.push(
      `updates mismatch:\n  expected: ${JSON.stringify(expected.expectedUpdates)}\n  actual:   ${JSON.stringify(actualUpdates)}`,
    );
  }
  if (expected.stopReason !== translator.stopReason) {
    mismatches.push(
      `stopReason mismatch: expected=${expected.stopReason} actual=${translator.stopReason}`,
    );
  }
  if (expected[terminalFlag] !== translator[terminalFlag]) {
    mismatches.push(
      `${terminalFlag} mismatch: expected=${expected[terminalFlag]} actual=${translator[terminalFlag]}`,
    );
  }
  if (unknown.length > 0) {
    mismatches.push(
      `onUnknown fired ${unknown.length}× — new events Claude/Codex ship that the translator doesn't recognise yet. Snippet: ${JSON.stringify(unknown[0]).slice(0, 120)}…`,
    );
  }

  return {
    name: fixtureBase,
    status: mismatches.length === 0 ? "pass" : "fail",
    mismatches,
    unknown,
  };
}

async function main() {
  const entries = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.replace(/\.jsonl$/, ""));

  if (entries.length === 0) {
    console.log("No fixtures found in scripts/fixtures/. See the README there.");
    return;
  }

  let failures = 0;
  for (const name of entries) {
    try {
      const result = await runFixture(name);
      if (result.status === "pass") {
        console.log(`  ✓ ${name}`);
      } else if (result.status === "written") {
        console.log(`  ✎ ${name} (rewrote expected.json)`);
      } else {
        failures += 1;
        console.log(`  ✗ ${name}`);
        for (const m of result.mismatches ?? []) {
          console.log(
            `      ${m.replace(/\n/g, "\n      ")}`,
          );
        }
      }
    } catch (err) {
      failures += 1;
      console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures > 0) {
    console.log(`\n${failures} fixture${failures === 1 ? "" : "s"} failed`);
    process.exit(1);
  }
  console.log(`\n${entries.length} fixture${entries.length === 1 ? "" : "s"} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
