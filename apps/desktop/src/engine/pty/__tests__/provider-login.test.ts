import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { providerLoginCommand } from "../provider-login";

it.each(["claude", "codex"] as const)(
  "starts %s login without echoing bootstrap commands or selecting inherited API credentials",
  (provider) => {
    const root = mkdtempSync(path.join(tmpdir(), "zeros-login-"));
    const binary = path.join(root, "runtime 'quoted' name");
    writeFileSync(
      binary,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY, openai: process.env.OPENAI_API_KEY, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, noColor: process.env.NO_COLOR, term: process.env.TERM }));\n`,
      { mode: 0o700 },
    );
    try {
      const output = execFileSync(
        "/bin/sh",
        ["-c", providerLoginCommand(provider, binary)],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: "unused",
            OPENAI_API_KEY: "unused",
            CLAUDE_CODE_OAUTH_TOKEN: "unused",
            NO_COLOR: "1",
            TERM: "xterm-256color",
          },
        },
      );
      expect(JSON.parse(output)).toEqual({
        args:
          provider === "claude" ? ["auth", "login", "--claudeai"] : ["login"],
        term: "xterm-256color",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
