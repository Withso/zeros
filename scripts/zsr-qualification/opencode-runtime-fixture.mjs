#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const role = process.argv[2] ?? "runtime";
const root = path.resolve(process.argv[3] ?? "");
const fixture = path.resolve(process.argv[1]);
const designFile = path.join(root, "Zeros Design", "tracked.txt");
const codeRoot = path.join(root, "code");
const pluginMarker = "zsr-opencode-plugin-environment";

if (!path.isAbsolute(root)) throw new Error("fixture root must be absolute");

function exercise(name) {
  if (process.env.ZEROS_OPENCODE_PLUGIN_ENV !== pluginMarker) {
    throw new Error(`${name} did not inherit plugin environment`);
  }
  writeFileSync(path.join(codeRoot, `opencode-${name}.txt`), `${name}\n`);
  let designDenied = false;
  try {
    writeFileSync(designFile, `${name} escaped\n`);
  } catch {
    designDenied = true;
  }
  if (!designDenied) throw new Error(`${name} could mutate Design`);
  return { name, codeWrite: true, designDenied, pluginEnvironment: true };
}

function runChild(childRole, input = "") {
  const child = spawnSync(process.execPath, [fixture, childRole, root], {
    env: process.env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.status !== 0) {
    throw new Error(
      `${childRole} failed (${child.status ?? child.signal}): ${child.stderr}`,
    );
  }
  return JSON.parse(child.stdout.trim());
}

if (role === "shell") {
  process.stdout.write(JSON.stringify(exercise("shell")));
} else if (role === "mcp") {
  const request = readFileSync(0, "utf8");
  if (request !== '{"jsonrpc":"2.0","method":"initialize"}\n') {
    throw new Error("local MCP child did not receive its stdio request");
  }
  process.stdout.write(JSON.stringify(exercise("mcp")));
} else if (role === "grandchild") {
  process.stdout.write(JSON.stringify(exercise("grandchild")));
} else if (role === "subagent") {
  const own = exercise("subagent");
  const grandchild = runChild("grandchild");
  process.stdout.write(JSON.stringify({ ...own, grandchild }));
} else if (role === "runtime") {
  // OpenCode plugins contribute environment to the main runtime before its
  // shell, local MCP, and subagent descendants are launched.
  process.env.ZEROS_OPENCODE_PLUGIN_ENV = pluginMarker;
  const runtime = exercise("runtime");
  const shell = runChild("shell");
  const mcp = runChild("mcp", '{"jsonrpc":"2.0","method":"initialize"}\n');
  const subagent = runChild("subagent");
  process.stdout.write(JSON.stringify({ runtime, shell, mcp, subagent }));
} else {
  throw new Error(`unknown fixture role: ${role}`);
}
