import { describe, expect, it } from "vitest";

import {
  appBundleName,
  describeProcess,
  isZerosBundle,
  sanitizeCommandLine,
} from "../process-labels";

const APP = "/Applications/Zeros.app/Contents/MacOS/Zeros";

function label(command: string, args: string | null, isEngine = false) {
  return describeProcess({ command, args, isEngine, appExecutable: APP });
}

describe("describeProcess", () => {
  it("names Zeros hosts that re-run the app binary as Node by their script", () => {
    expect(
      label(APP, `${APP} /Applications/Zeros.app/Contents/Resources/pty-host.cjs`),
    ).toEqual({ name: "Terminal host", kind: "helper" });
    expect(
      label(APP, `${APP} /Applications/Zeros.app/Contents/Resources/cursor-host.cjs`),
    ).toEqual({ name: "Cursor", kind: "agent" });
    expect(
      label(APP, `${APP} /x/host-process-supervisor.mjs --pending /y -- /z/claude`),
    ).toEqual({ name: "Agent supervisor", kind: "helper" });
    expect(label(APP, `${APP} /x/some-helper.cjs`)).toEqual({
      name: "some-helper",
      kind: "helper",
    });
  });

  it("names agent runtimes and the engine", () => {
    expect(label("/Applications/Zeros.app/Contents/Resources/claude", "claude --output-format stream-json")).toEqual({ name: "Claude Code", kind: "agent" });
    expect(label("/x/codex-runtime/bin/codex", "codex app-server")).toEqual({ name: "Codex", kind: "agent" });
    expect(label("/x/zeros-engine", null, true)).toEqual({ name: "Engine", kind: "sidecar" });
  });

  it("names interpreter-run tools by package or script, with readable subcommands", () => {
    expect(label("node", "node /w/node_modules/.bin/../typescript/bin/tsc --noEmit").name).toBe("tsc");
    expect(label("node", "node node_modules/vitest/vitest.mjs run --config vitest.config.ts").name).toBe("vitest run");
    expect(label("node", "node /w/node_modules/vite/bin/vite.js build").name).toBe("vite build");
    expect(label("node", "node /opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs typecheck").name).toBe("pnpm typecheck");
    expect(
      label("node", "node --experimental-import-meta-resolve --require /w/node_modules/vitest/suppress.cjs /w/node_modules/vitest/dist/workers/forks.js").name,
    ).toBe("vitest worker");
    expect(label("node", "node scripts/check-ui-consistency.mjs --prune").name).toBe("check-ui-consistency");
    expect(label("node", "node -e console.log(1)").name).toBe("node");
    expect(label("/bin/zsh", "/bin/zsh -lc pnpm typecheck").name).toBe("zsh");
    // Without argv the executable basename remains.
    expect(label("/usr/bin/git", null).name).toBe("git");
  });

  it("bounds and cleans labels", () => {
    const long = `node /w/${"a".repeat(200)}.js`;
    expect(label("node", long).name.length).toBeLessThanOrEqual(60);
    expect(label("bad\u0007name", null).name).toBe("bad name");
  });
});

describe("sanitizeCommandLine", () => {
  const HOME = "/Users/alice";
  it("removes credentials, header and env values, and URL userinfo", () => {
    const clean = sanitizeCommandLine(
      `codex app-server -c mcp_servers.d.url="http://127.0.0.1:5/mcp" -c mcp_servers.d.http_headers={ "X-Zeros-Key" = "s3cr3tvalue" } -c mcp_servers.d.env={ A = "b" } --token abc123 --api-key=xyz git -c http.extraheader=AUTHORIZATION:basic_abc https://user:pass@example.com/repo GITHUB_TOKEN=ghp_${"a".repeat(36)}`,
      HOME,
    );
    expect(clean).not.toContain("s3cr3tvalue");
    expect(clean).not.toContain("abc123");
    expect(clean).not.toContain("xyz");
    expect(clean).not.toContain("basic_abc");
    expect(clean).not.toContain("user:pass");
    expect(clean).not.toContain("ghp_");
    expect(clean).toContain("mcp_servers.d.url=");
    expect(clean).toContain("https://[redacted]@example.com/repo");
  });

  it("replaces the home directory, strips control characters and truncates", () => {
    expect(sanitizeCommandLine(`node ${HOME}/zeros/x.js\u0000 a`, HOME)).toBe(
      "node ~/zeros/x.js a",
    );
    const long = sanitizeCommandLine(`node ${"x".repeat(1_000)}`, HOME);
    expect(long.length).toBe(400);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("Zeros bundle detection", () => {
  it("matches release-channel bundles only", () => {
    expect(appBundleName("/Applications/Zeros Alpha.app/Contents/MacOS/Zeros Alpha")).toBe("Zeros Alpha");
    expect(isZerosBundle("Zeros")).toBe(true);
    expect(isZerosBundle("Zeros Beta")).toBe(true);
    expect(isZerosBundle("Zeroscope")).toBe(false);
    expect(isZerosBundle("Zeros Helper (Renderer)")).toBe(false);
    expect(isZerosBundle(null)).toBe(false);
  });
});
