"use strict";
// Real pinned SDK, credential-free private subprocess. The test parent owns
// HOME/project and a network namespace; marker-only servers never serve tools.
const { createAgentPlatform, JsonlLocalAgentStore } = require(process.argv[2]);
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
let skillRead = false;
let repoAgentsRead = false;
let repoRuleRead = false;
const readFile = fsp.readFile;
fsp.readFile = async function(filename, ...args) {
  const content = await readFile.call(this, filename, ...args);
  if (String(filename).endsWith("/skills/admitted-skill/SKILL.md")) skillRead = true;
  if (String(filename).endsWith("/AGENTS.md") && String(content).includes("CURSOR_AGENTS_SENTINEL")) repoAgentsRead = true;
  if (String(filename).endsWith("/.cursor/rules/always.mdc") && String(content).includes("CURSOR_RULE_SENTINEL")) repoRuleRead = true;
  return content;
};
(async () => {
  const options = JSON.parse(process.argv[3]);
  if (process.argv[4] === "immutable") {
    if (process.getuid() !== 10001 || process.getgid() !== 10001) throw new Error("Wrong worker identity");
    try { fs.writeFileSync(path.join(process.env.HOME, ".cursor/mcp.json"), "{}"); throw new Error("Mutable Cursor config"); }
    catch (error) { if (!["EROFS", "EACCES", "EPERM"].includes(error.code)) throw error; }
  }
  const platform = await createAgentPlatform({ localStore: new JsonlLocalAgentStore(path.join(process.env.HOME, "store")), workspaceRef: options.cwd });
  const release = await platform.prewarmLocalWorkspace(options);
  // Rule/skill discovery starts asynchronously during prewarm. Keep positive
  // controls alive until actual SDK reads finish, with a fixed deadline.
  const expectRepo = options.local.settingSources.includes("project") && fs.existsSync(path.join(options.cwd, "AGENTS.md"));
  const expectSkill = process.argv[4] === "immutable" && Object.keys(options.mcpServers).length > 0;
  const deadline = Date.now() + 3000;
  while (((expectRepo && (!repoAgentsRead || !repoRuleRead)) || (expectSkill && !skillRead)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  await release();
  process.stdout.write(JSON.stringify({ skillRead, repoAgentsRead, repoRuleRead }) + "\n");
  process.stdout.write("native_prewarm_ok");
  process.exit(0);
})().catch(() => process.exit(1));
