"use strict";
// Minimal @cursor/sdk stand-in, handed to cursor-host.cjs via
// ZEROS_CURSOR_SDK_ENTRY. It exists so store-injection.test.ts can assert what
// the host passed the SDK without a network call, an API key, or the real
// package's 3 MB bundle.
//
// The host is a subprocess whose only channel is the NDJSON protocol, so each
// stub method encodes what it received into the field the host echoes back:
// `agentId` for create/resume, `items` for list, the run doc for store reads.

let nextInstance = 0;

class JsonlLocalAgentStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    // Identity matters: the host is supposed to memoize one store per root and
    // hand the SAME instance to create, resume, list, and store.open.
    this.instanceId = `store${++nextInstance}`;
    const identity = describe(this);
    this.runs = {
      get: async () => ({ status: "error", error: identity }),
    };
  }
}

/** Deterministic and obviously synthetic, so a test asserting on it can't be
 *  passing for the wrong reason (e.g. a real ~/.cursor path leaking in). */
function getDefaultSdkStateRoot(workspaceRef) {
  if (process.env.ZEROS_CURSOR_STUB_DEFAULT_STATE_ROOT) {
    return process.env.ZEROS_CURSOR_STUB_DEFAULT_STATE_ROOT;
  }
  return `/state-root${workspaceRef}`;
}

function describe(store) {
  return store ? `${store.instanceId}@${store.rootDir}` : "none";
}

/** What the host passed to configureCursorSdk at startup, echoed back through
 *  agent.create so a test can assert the workspace-scan TTL the host chose (and
 *  that it chose NOTHING when the operator set the env var). */
let configuredScanTtlMs = "unset";
function configureCursorSdk(options) {
  const value = options && options.local && options.local.workspaceScanCacheTtlMs;
  if (value === undefined) return;
  // Mirror the real SDK's validation so a bad value fails here too.
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Workspace scan cache TTL must be a positive number of milliseconds, got ${value}`,
    );
  }
  configuredScanTtlMs = String(value);
}

const Agent = {
  create: async (opts) => {
    if (process.env.ZEROS_CURSOR_STUB_REPORT_SCAN_TTL === "1") {
      return { agentId: `scanTtl:${configuredScanTtlMs}` };
    }
    if (process.env.ZEROS_CURSOR_STUB_RIPGREP_BOUNDARY === "1") {
      const { spawn } = require("node:child_process");
      const child = spawn(process.env.CURSOR_RIPGREP_PATH, [
        "--files",
        "--hidden",
        "--iglob",
        "**/.gitignore",
        "--iglob",
        "!**/.git/**",
        "--",
        "src",
      ]);
      child.once("error", () => {});
      child.kill();
      return { agentId: `ripgrep:${JSON.stringify(child.spawnargs.slice(1))}` };
    }
    const http2Target = process.env.ZEROS_CURSOR_STUB_HTTP2_TARGET;
    if (http2Target) {
      const http2 = require("node:http2");
      const outcome = await new Promise((resolve) => {
        const session = http2.connect(http2Target);
        const timer = setTimeout(() => finish("timeout"), 2_000);
        let finished = false;
        const finish = (value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          session.destroy();
          resolve(String(value));
        };
        session.once("connect", () => finish("connected"));
        session.once("error", (error) =>
          finish(error && error.code ? error.code : "error"),
        );
      });
      return { agentId: `http2:${outcome}` };
    }
    return {
      agentId: `create:${describe(opts && opts.local && opts.local.store)}`,
    };
  },
  resume: async (_agentId, opts) => ({
    agentId: `resume:${describe(opts && opts.local && opts.local.store)}`,
  }),
  list: async (opts) => ({
    items: [
      {
        // Agent.list takes `store` at the TOP level (ListAgentsOptions), not
        // under `local` — both are recorded so a regression that puts it in the
        // wrong place is visible rather than merely absent.
        top: describe(opts && opts.store),
        nested: describe(opts && opts.local && opts.local.store),
      },
    ],
  }),
};

const Cursor = { models: { list: async () => [] } };

module.exports = {
  Agent,
  Cursor,
  JsonlLocalAgentStore,
  getDefaultSdkStateRoot,
  configureCursorSdk,
};
