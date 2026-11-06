import path from "node:path";
import { describe, expect, it } from "vitest";
import { mcpServerEnvironment } from "../mcp-process-env";

describe("stdio MCP server environment", () => {
  it("drops PATH when only Zeros credential shims were on it", () => {
    const shims = ["/tmp/zeros-git-auth-a", "/tmp/zeros-git-auth-b"].join(path.delimiter);
    expect(
      mcpServerEnvironment(
        { HOME: "/home/user", PATH: shims, ZEROS_LOCAL_TOKEN: "engine-secret" },
        { TOKEN: "own" },
      ),
    ).toEqual({ HOME: "/home/user", TOKEN: "own" });
  });

  it("keeps the rest of PATH without the shims", () => {
    expect(
      mcpServerEnvironment({
        PATH: ["/tmp/zeros-git-auth-a", "/usr/bin", "/bin"].join(path.delimiter),
      }),
    ).toEqual({ PATH: ["/usr/bin", "/bin"].join(path.delimiter) });
  });
});
