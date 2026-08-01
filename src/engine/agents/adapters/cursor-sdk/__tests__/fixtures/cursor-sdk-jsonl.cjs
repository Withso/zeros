"use strict";

class JsonlLocalAgentStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.runs = {
      get: async ({ agentId, runId }) => ({
        agentId,
        runId,
        status: "error",
        error: "fixture-error",
      }),
    };
  }
}

let sharedStore = null;
function requireStore(store, operation) {
  if (!(store instanceof JsonlLocalAgentStore)) {
    throw new Error(`${operation} did not receive JsonlLocalAgentStore`);
  }
  if (sharedStore && sharedStore !== store) {
    throw new Error(`${operation} did not receive the shared workspace store`);
  }
  sharedStore = store;
}

module.exports = {
  JsonlLocalAgentStore,
  getDefaultSdkStateRoot: (cwd) => `${cwd}/.cursor-sdk-test-store`,
  Agent: {
    create: async (opts) => {
      requireStore(opts && opts.local && opts.local.store, "Agent.create");
      return {
        agentId: "fixture-agent",
        send: async () => {
          throw new Error("not used");
        },
        close() {},
      };
    },
    resume: async (_agentId, opts) => {
      requireStore(opts && opts.local && opts.local.store, "Agent.resume");
      return { agentId: "fixture-agent", close() {} };
    },
    list: async (opts) => {
      requireStore(opts && opts.store, "Agent.list");
      return { items: [] };
    },
  },
  Cursor: { models: { list: async () => [] } },
};
