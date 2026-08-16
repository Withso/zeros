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

const Agent = {
  create: async (opts) => ({
    agentId: `create:${describe(opts && opts.local && opts.local.store)}`,
  }),
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
};
