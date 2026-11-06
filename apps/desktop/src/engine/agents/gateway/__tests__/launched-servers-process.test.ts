import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SCRUBBED_COMMAND_ENV_NAMES } from "../../../env/launcher-env";
import { HostExecutionBoundary } from "../../containment/host-boundary";
import { createRepoTaskBoundaryFactory } from "../../containment/repo-task-boundary";
import { LaunchedMcpServers } from "../launched-servers";

const AMBIENT = "ZEROS_FIXTURE_ENGINE_SECRET";
const previousAmbient = process.env[AMBIENT];
afterEach(() => {
  if (previousAmbient === undefined) delete process.env[AMBIENT];
  else process.env[AMBIENT] = previousAmbient;
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("launched MCP server process", () => {
  it("sees only the scrubbed basics and its own variables through the real boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-mcp-env-"));
    // The engine's own environment, which a boundary must not pass on.
    process.env[AMBIENT] = "ambient-secret";
    const pool = new LaunchedMcpServers(
      createRepoTaskBoundaryFactory(new HostExecutionBoundary({ projectRoot: root })),
    );
    try {
      const port = await freePort();
      const marker = path.join(root, "env.json");
      const own = "ZEROS_MCP_0123456789ABCDEF0123456789ABCDEF_TOKEN";
      const result = await pool.resolve(
        [{
          name: "probe",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.env)); require("node:net").createServer((s) => s.end()).listen(${port}, "127.0.0.1");`, marker],
          env: { PLAIN: "plain-value" },
          envFromEnv: { TOKEN: own },
          listenUrl: `http://127.0.0.1:${port}/mcp`,
        }],
        root,
        {
          HOME: root,
          LANG: "C.UTF-8",
          PATH: [path.join(root, "zeros-git-auth-fixture"), "/usr/bin", "/bin"].join(path.delimiter),
          [own]: "own-secret",
          ZEROS_MCP_FEDCBA9876543210FEDCBA9876543210_TOKEN: "other-server-secret",
          ZEROS_LOCAL_TOKEN: "engine-token",
          ZEROS_MCP_GATEWAY_CAPABILITY: "gateway-capability",
          ZEROS_GIT_AUTH_SOCKET: "/tmp/broker.sock",
          CURSOR_API_KEY: "provider-secret",
        },
        "owner",
        root,
        false,
      );
      expect(result).toEqual({ servers: [{ name: "probe", transport: "http", url: `http://127.0.0.1:${port}/mcp` }], unavailable: [] });
      const env = JSON.parse(await readFile(marker, "utf8")) as Record<string, string>;
      expect(env).toMatchObject({
        HOME: root,
        LANG: "C.UTF-8",
        PATH: ["/usr/bin", "/bin"].join(path.delimiter),
        PLAIN: "plain-value",
        TOKEN: "own-secret",
      });
      // macOS sets __CF_USER_TEXT_ENCODING in every process itself.
      const allowed = new Set<string>([...SCRUBBED_COMMAND_ENV_NAMES, "PLAIN", "TOKEN", "__CF_USER_TEXT_ENCODING"]);
      expect(Object.keys(env).filter((name) => !allowed.has(name))).toEqual([]);
      expect(JSON.stringify(env)).not.toMatch(/ambient-secret|other-server-secret|engine-token|gateway-capability|broker\.sock|provider-secret|zeros-git-auth/);
    } finally {
      await pool.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
