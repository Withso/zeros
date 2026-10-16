import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listClaudeModels } from "../agent-runtime/models.mjs";

describe("installed Claude SDK listing protocol", () => {
  it("requests initialization metadata without writing a prompt to the CLI", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-claude-list-"));
    const input = join(directory, "requests.jsonl"),
      cli = join(directory, "cli.cjs");
    writeFileSync(
      cli,
      `const fs = require('node:fs');
const lines = require('node:readline').createInterface({ input: process.stdin });
lines.on('line', line => {
  fs.appendFileSync(process.argv[2], line + '\\n');
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const response = message.request.subtype === 'initialize' ? { models: [{ value: 'fixture-model', displayName: 'Fixture', description: 'Offline fixture' }], commands: [], account: null } : {};
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } }) + '\\n');
  }
});
`,
    );
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const models = await listClaudeModels(sdk, {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          CLAUDE_CONFIG_DIR: directory,
        },
        pathToClaudeCodeExecutable: cli,
        spawnClaudeCodeProcess: () =>
          spawn(process.execPath, [cli, input], {
            cwd: directory,
            env: { PATH: process.env.PATH, HOME: directory },
            stdio: ["pipe", "pipe", "pipe"],
          }),
      });
      expect(models.map((model: any) => model.value)).toEqual([
        "fixture-model",
      ]);
      const messages = readFileSync(input, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        messages.some(
          (message) =>
            message.type === "control_request" &&
            message.request.subtype === "initialize",
        ),
      ).toBe(true);
      expect(
        messages.some(
          (message) =>
            message.type === "user" ||
            message.type === "assistant" ||
            message.prompt,
        ),
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
