// Vitest global setup — runs once per test file, BEFORE any test module is
// imported.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

// Why this exists: several renderer modules now under test transitively import
// `@pierre/diffs` (the agent EditCard via apps/desktop/src/renderer/features/agent/renderers/tool-edit.tsx;
// the Changes/Review tabs use it too). Its `CodeView` reads
// `globalThis.navigator.userAgent` (and `.platform`) at MODULE-LOAD time:
//
//     const { navigator } = globalThis;
//     const userAgent = navigator.userAgent;          // ← throws if navigator is undefined
//
// The test env is `environment: "node"`. Node 21+ and browsers define
// `globalThis.navigator`, but CI runs Node 20, where it is undefined — so the
// bare `import` throws "Cannot read properties of undefined (reading
// 'userAgent')" and the whole suite fails to even collect. A newer local Node
// (21+) masks the bug, which is exactly why it only surfaces on CI.
//
// Fix: install a minimal, browser-shaped `navigator` stub ONLY when the runtime
// hasn't already (so Node 21+ keeps its real one untouched). No test depends on
// `navigator` being absent (verified), and production code is unaffected — this
// file is loaded by Vitest alone.
const g = globalThis as typeof globalThis & {
  navigator?: { userAgent: string; platform: string; maxTouchPoints: number };
};
if (typeof g.navigator === "undefined") {
  g.navigator = { userAgent: "node", platform: "", maxTouchPoints: 0 };
}

// Give each test file its own Zeros app-data directory.
//
// Without ZEROS_DATA_DIR, zerosDataDir() is the machine-wide app-data directory
// (on macOS ~/Library/Application Support/com.zeros, the installed app's own),
// which every concurrently running worker shares. Whichever process opens the
// Zeros DB there first creates and migrates it, and a process that opens it in
// the meantime fails at once: `PRAGMA journal_mode = WAL` does not wait for a
// writer ("database is locked"), and a lost migration race throws ("table repos
// already exists"). An engine path that fails closed on an unreadable DB then
// fails its test intermittently, as the pre-dispatch admission cases in
// apps/desktop/src/engine/__tests__/agent-cancel-stop.test.ts did on CI.
// Replace an inherited value too: every worker inherits the same one. A test
// that needs a particular location still sets ZEROS_DATA_DIR or calls
// setZerosDbPathForTesting() itself.
const privateDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "zeros-vitest-data-"),
);
process.env.ZEROS_DATA_DIR = privateDataDir;
afterAll(() => {
  try {
    fs.rmSync(privateDataDir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Best effort: an engine a test left running may still be writing here.
  }
});
