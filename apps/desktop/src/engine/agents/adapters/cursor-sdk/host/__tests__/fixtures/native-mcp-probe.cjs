"use strict";
// Real pinned SDK, credential-free private subprocess. The test parent owns
// HOME/project and a network namespace; marker-only servers never serve tools.
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
let skillRead = false;
let repoAgentsRead = false;
let repoRuleRead = false;
let repoAgentsRule = false;
let repoAlwaysRule = false;
const readApis = new Set();
function observeRead(filename, content, api) {
  if (String(filename).endsWith("/skills/admitted-skill/SKILL.md")) skillRead = true;
  if (String(filename).endsWith("/AGENTS.md") && String(content).includes("CURSOR_AGENTS_SENTINEL")) {
    repoAgentsRead = true;
    readApis.add(api);
  }
  if (String(filename).endsWith("/.cursor/rules/always.mdc") && String(content).includes("CURSOR_RULE_SENTINEL")) repoRuleRead = true;
}
const readFile = fsp.readFile;
fsp.readFile = async function(filename, ...args) {
  const content = await readFile.call(this, filename, ...args);
  observeRead(filename, content, "readFile");
  return content;
};
// SDK 1.2 decodes text through an opened descriptor. Observe the real bytes
// without replacing them, and keep the older readFile path covered too.
const open = fsp.open;
fsp.open = async function(filename, ...args) {
  const handle = await open.call(this, filename, ...args);
  const read = handle.readFile;
  handle.readFile = async function(...options) {
    const content = await read.apply(this, options);
    observeRead(filename, content, "FileHandle.readFile");
    return content;
  };
  return handle;
};
// The SDK has no public assembled-rules API. Observe its protobuf rule
// construction at the executor module boundary, keeping the native parser,
// setting-source filtering and resulting objects unchanged. This proves the
// file's contents become an always-applied agent rule, beyond merely opening it.
const executorModule = "./src/agent/local-executor.ts";
const sdkDir = path.dirname(process.argv[2]);
const executorChunk = fs.readdirSync(sdkDir).filter(name => /^\d+\.js$/.test(name))
  .map(name => path.join(sdkDir, name)).find(name => fs.readFileSync(name, "utf8").includes(executorModule));
if (!executorChunk) throw new Error("Native Cursor executor module not found");
const chunk = require(executorChunk);
const factory = chunk.modules[executorModule];
chunk.modules[executorModule] = function(module, exports, nativeRequire) {
  const observedRequire = new Proxy(nativeRequire, {
    apply(target, receiver, args) {
      const value = Reflect.apply(target, receiver, args);
      if (!String(args[0]).endsWith("/cursor_rules_pb.js")) return value;
      return new Proxy(value, { get(target, key) {
        const member = Reflect.get(target, key);
        if (typeof member !== "function" || member.typeName !== "agent.v1.CursorRule") return member;
        return new Proxy(member, { construct(target, args) {
          const rule = Reflect.construct(target, args);
          if (rule.type?.type?.case === "global") {
            if (rule.fullPath?.endsWith("/AGENTS.md") && rule.content?.includes("CURSOR_AGENTS_SENTINEL")) repoAgentsRule = true;
            if (rule.fullPath?.endsWith("/.cursor/rules/always.mdc") && rule.content?.includes("CURSOR_RULE_SENTINEL")) repoAlwaysRule = true;
          }
          return rule;
        } });
      } });
    },
  });
  return factory.call(this, module, exports, observedRequire);
};
const { createAgentPlatform, JsonlLocalAgentStore } = require(process.argv[2]);
(async () => {
  const options = JSON.parse(process.argv[3]);
  const sameEngineIdentity = process.getuid() === Number(process.argv[5]) && process.getgid() === Number(process.argv[6]) &&
    process.geteuid() === Number(process.argv[5]) && process.getegid() === Number(process.argv[6]);
  if (!sameEngineIdentity) throw new Error("Wrong engine identity");
  const stateProbe = path.join(process.env.HOME, ".cursor-state-write-probe");
  fs.writeFileSync(stateProbe, "ordinary provider state", { flag: "wx" });
  fs.unlinkSync(stateProbe);
  const stateWritable = true;
  const platform = await createAgentPlatform({ localStore: new JsonlLocalAgentStore(path.join(process.env.HOME, "store")), workspaceRef: options.cwd });
  const release = await platform.prewarmLocalWorkspace(options);
  // Rule/skill discovery starts asynchronously during prewarm. Keep positive
  // controls alive until actual SDK reads finish, with a fixed deadline.
  const expectRepo = options.local.settingSources.includes("project") && fs.existsSync(path.join(options.cwd, "AGENTS.md"));
  const expectSkill = process.argv[4] === "engine-home" && Object.keys(options.mcpServers).length > 0;
  const deadline = Date.now() + 3000;
  while (((expectRepo && (!repoAgentsRule || !repoAlwaysRule)) || (expectSkill && !skillRead)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  await release();
  process.stdout.write(JSON.stringify({ skillRead, repoAgentsRead, repoRuleRead, repoAgentsRule, repoAlwaysRule, readApis: [...readApis], sameEngineIdentity, stateWritable }) + "\n");
  process.stdout.write("native_prewarm_ok");
  process.exit(0);
})().catch(() => process.exit(1));
