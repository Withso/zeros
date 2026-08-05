// Vitest global setup — runs once per test file, BEFORE any test module is
// imported.
//
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
