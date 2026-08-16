import { execFile } from "node:child_process";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { AgentFilesystemTerritory } from "../../../types";
import {
  claudeTerritoryEditDenyRules,
  claudeTerritorySandbox,
} from "../adapter";
import { resolveClaudeCli } from "../binary-resolver";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

interface Fixture {
  root: string;
  design: string;
  territory: AgentFilesystemTerritory;
}

async function fixture(designName = "Zeros Design"): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-claude-territory-"));
  roots.push(root);
  const design = path.join(root, designName);
  await Promise.all([
    mkdir(path.join(root, "code"), { recursive: true }),
    mkdir(path.join(design, "nested"), { recursive: true }),
    mkdir(path.join(root, ".zeros"), { recursive: true }),
    mkdir(path.join(root, ".claude-config"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "code", "writable.txt"), "before\n"),
    writeFile(path.join(design, "existing.txt"), "before\n"),
    writeFile(path.join(design, "replace.txt"), "before\n"),
    writeFile(path.join(design, "draft.tmp"), "ignored\n"),
    writeFile(path.join(root, ".zeros", "settings.toml"), "[design]\n"),
  ]);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  return {
    root,
    design,
    territory: {
      agentRole: "code",
      workspaceRoot: root,
      designDirectory: design,
      protectedDesignDirectories: [design],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [
          design,
          path.join(root, ".zeros"),
          path.join(root, ".git"),
        ],
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

type AssistantBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

function sseEvents(blocks: AssistantBlock[], stopReason: string): string {
  const events: Array<[string, Record<string, unknown>]> = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_${Date.now()}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-20250514",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
  ];
  blocks.forEach((block, index) => {
    events.push([
      "content_block_start",
      {
        type: "content_block_start",
        index,
        content_block:
          block.type === "tool_use"
            ? { type: "tool_use", id: block.id, name: block.name, input: {} }
            : { type: "text", text: "" },
      },
    ]);
    events.push([
      "content_block_delta",
      {
        type: "content_block_delta",
        index,
        delta:
          block.type === "tool_use"
            ? {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              }
            : { type: "text_delta", text: block.text },
      },
    ]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push([
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
  ]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("");
}

async function withMockClaude<T>(
  firstTurn: AssistantBlock[],
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  let inferenceRequests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
      // Drain the request before answering so the SDK can reuse its socket.
    }
    if (request.url === "/api/hello") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    inferenceRequests += 1;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.end(
      inferenceRequests === 1
        ? sseEvents(firstTurn, "tool_use")
        : sseEvents([{ type: "text", text: "done" }], "end_turn"),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock Claude server did not publish a TCP port.");
    }
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runPinnedClaude(opts: {
  fixture: Fixture;
  baseUrl: string;
  sandbox?: ReturnType<typeof claudeTerritorySandbox>;
  allowBash?: boolean;
}): Promise<SDKMessage[]> {
  const cli = resolveClaudeCli({});
  if (!cli.path || cli.source !== "bundled") {
    throw new Error("The pinned Claude runtime is unavailable to this test.");
  }
  const deny = claudeTerritoryEditDenyRules(opts.fixture.territory);
  const q = query({
    prompt: "Perform the supplied tool calls.",
    options: {
      cwd: opts.fixture.root,
      pathToClaudeCodeExecutable: cli.path,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_BASE_URL: opts.baseUrl,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        CLAUDE_CONFIG_DIR: path.join(opts.fixture.root, ".claude-config"),
      },
      permissionMode: "acceptEdits",
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      settings: {
        disableAllHooks: true,
        permissions: {
          allow: opts.allowBash ? ["Bash"] : [],
          deny,
        },
      },
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      persistSession: false,
      maxTurns: 3,
    },
  });
  const messages: SDKMessage[] = [];
  try {
    for await (const message of q) messages.push(message);
  } finally {
    q.close();
  }
  return messages;
}

describe("Claude code-territory enforcement", () => {
  it("blocks real built-in Write/Edit calls in the pinned runtime", async () => {
    const current = await fixture();
    const codeFile = path.join(current.root, "code", "writable.txt");
    const designFile = path.join(current.design, "existing.txt");

    await withMockClaude(
      [
        {
          type: "tool_use",
          id: "toolu_code_write",
          name: "Write",
          input: { file_path: codeFile, content: "after\n" },
        },
        {
          type: "tool_use",
          id: "toolu_design_write",
          name: "Write",
          input: { file_path: designFile, content: "overwritten\n" },
        },
        {
          type: "tool_use",
          id: "toolu_design_edit",
          name: "Edit",
          input: {
            file_path: designFile,
            old_string: "before",
            new_string: "edited",
          },
        },
      ],
      (baseUrl) =>
        runPinnedClaude({ fixture: current, baseUrl }).then(() => undefined),
    );

    await expect(readFile(codeFile, "utf8")).resolves.toBe("after\n");
    await expect(readFile(designFile, "utf8")).resolves.toBe("before\n");
  }, 20_000);

  const runtimeRequired = process.env.ZEROS_REQUIRE_CONTAINMENT_RUNTIME === "1";
  (runtimeRequired ? it : it.skip)(
    "blocks the shell/Git attack matrix in Claude's real production sandbox",
    async () => {
      const current = await fixture();
      const attack = String.raw`
        const fs = require("node:fs");
        const path = require("node:path");
        const cp = require("node:child_process");
        const root = process.cwd();
        const design = (...p) => path.join(root, "Zeros Design", ...p);
        const code = (...p) => path.join(root, "code", ...p);
        const attempt = (fn) => { try { fn(); } catch {} };
        attempt(() => fs.writeFileSync(code("writable.txt"), "after\n"));
        attempt(() => fs.writeFileSync(design("existing.txt"), "overwrite\n"));
        attempt(() => fs.appendFileSync(design("existing.txt"), "append\n"));
        attempt(() => fs.truncateSync(design("existing.txt"), 0));
        attempt(() => fs.writeFileSync(design("nested", "new.txt"), "new\n"));
        attempt(() => fs.writeFileSync(design("draft.tmp"), "changed\n"));
        attempt(() => {
          fs.writeFileSync(code("replacement.tmp"), "replacement\n");
          fs.renameSync(code("replacement.tmp"), design("replace.txt"));
        });
        attempt(() => fs.renameSync(design("existing.txt"), code("stolen.txt")));
        attempt(() => {
          fs.symlinkSync(design("existing.txt"), code("design-link"));
          fs.appendFileSync(code("design-link"), "through-link\n");
        });
        attempt(() => {
          fs.linkSync(design("existing.txt"), code("design-hardlink"));
          fs.appendFileSync(code("design-hardlink"), "through-hardlink\n");
        });
        attempt(() => fs.writeFileSync(path.join(root, ".zeros", "settings.toml"), "changed\n"));
        attempt(() => fs.writeFileSync(path.join(root, ".git", "HEAD"), "changed\n"));
        attempt(() => cp.execFileSync("git", ["add", "--", "code/writable.txt"], { cwd: root }));
      `;
      const encodedAttack = Buffer.from(attack, "utf8").toString("base64");

      await withMockClaude(
        [
          {
            type: "tool_use",
            id: "toolu_bash_attack",
            name: "Bash",
            input: {
              command:
                `${JSON.stringify(process.execPath)} -e ` +
                `"eval(Buffer.from('${encodedAttack}','base64').toString())"`,
              description: "Run containment attack matrix",
            },
          },
        ],
        (baseUrl) =>
          runPinnedClaude({
            fixture: current,
            baseUrl,
            sandbox: claudeTerritorySandbox(current.territory),
            allowBash: true,
          }).then(() => undefined),
      );

      await expect(
        readFile(path.join(current.root, "code", "writable.txt"), "utf8"),
      ).resolves.toBe("after\n");
      await expect(
        readFile(path.join(current.design, "existing.txt"), "utf8"),
      ).resolves.toBe("before\n");
      await expect(
        readFile(path.join(current.design, "draft.tmp"), "utf8"),
      ).resolves.toBe("ignored\n");
      await expect(
        readFile(path.join(current.root, ".zeros", "settings.toml"), "utf8"),
      ).resolves.toBe("[design]\n");
      await expect(
        readFile(path.join(current.root, ".git", "HEAD"), "utf8"),
      ).resolves.toMatch(/^ref: refs\/heads\/main\s*$/);
      const staged = await execFileAsync(
        "git",
        ["diff", "--cached", "--name-only"],
        { cwd: current.root },
      );
      expect(staged.stdout.trim()).toBe("");
    },
    30_000,
  );
});
