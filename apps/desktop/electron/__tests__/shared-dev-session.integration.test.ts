import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

const fixtures = path.resolve("apps/desktop/electron/__tests__/fixtures");
const children: ChildProcess[] = [];
let root = "";
let server: Server | undefined;
let sequence = 0;

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }),
  );
  if (server?.listening)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

/** Await a matching worker message with bounded failure and listener cleanup. */
function waitMessage(
  child: ChildProcess,
  predicate: (message: any) => boolean,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Dev session worker timed out"));
    }, 8_000);
    const receive = (message: unknown) => {
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const exited = () => {
      cleanup();
      reject(new Error("Dev session worker exited"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", exited);
    };
    child.on("message", receive);
    child.once("exit", exited);
  });
}

/** Install the reply listener before sending a uniquely identified worker RPC. */
function command(
  child: ChildProcess,
  command: string,
  value?: unknown,
): Promise<any> {
  const id = ++sequence;
  const reply = waitMessage(child, (message) => message.id === id);
  child.send({ id, command, value });
  return reply.then((message) => {
    if (message.error) throw new Error(message.error);
    return message.result;
  });
}

describe("Dev session sharing across independent processes", () => {
  it("shares one sign-in, routes a sibling callback, rotates once, and survives a full restart", async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-shared-dev-session-"));
    const bundle = path.join(root, "worker.cjs");
    await build({
      entryPoints: [path.join(fixtures, "dev-session-worker.ts")],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "silent",
      plugins: [
        {
          name: "external-auth-fixtures",
          setup(builder) {
            builder.onResolve({ filter: /^electron$/ }, () => ({
              path: path.join(fixtures, "dev-session-electron.ts"),
            }));
            builder.onResolve(
              { filter: /(?:^|\/)workos-desktop-runtime$/ },
              () => ({ path: path.join(fixtures, "dev-session-runtime.ts") }),
            );
          },
        },
      ],
    });
    const session = {
      accessToken: "fixture-access",
      refreshToken: "fixture-refresh",
      expiresAt: Date.now() + 300_000,
      providerSubject: "user_fixture",
      sessionId: "session_fixture",
      clientKind: "desktop",
      email: "dev@example.com",
      name: "Dev",
      authenticationMethod: "GoogleOAuth",
      accountId: "00000000-0000-4000-8000-000000000001",
    };
    let rotations = 0;
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        rotations++;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            status: "active",
            session: {
              ...session,
              accessToken: "fixture-rotated-access",
              refreshToken: "fixture-rotated-refresh",
            },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    /** Boot an independent worker with shared or isolated storage and wait for
     * readiness before sending commands that could race its initialization. */
    const start = async (name: string, shared = true) => {
      const child = fork(bundle, [], {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          ZEROS_CHANNEL: "dev",
          ZEROS_TEST_INSTANCE_DIR: path.join(root, name),
          ZEROS_SHARED_SECRETS_DIR: shared ? path.join(root, "shared") : "",
          ZEROS_TEST_REFRESH_URL: `http://127.0.0.1:${port}/refresh`,
          AUTH_PROVIDER: "workos",
          AUTH_DESKTOP_CLIENT_ID: "client_desktop_alpha",
          AUTH_ISSUER:
            "https://api.workos.com/user_management/client_web_alpha",
          AUTH_JWKS_URL: "https://api.workos.com/sso/jwks/client_web_alpha",
          AUTH_AUDIENCE: "https://api-alpha.zeros.build",
          VITE_APP_BASE_URL: "https://app-alpha.zeros.build",
          VITE_CONTROL_PLANE_URL: "https://api-alpha.zeros.build",
        },
      });
      children.push(child);
      await waitMessage(child, (message) => message.event === "ready");
      return child;
    };
    const [first, second, third, isolated] = await Promise.all([
      start("a"),
      start("b"),
      start("c"),
      start("isolated", false),
    ]);
    const observed = waitMessage(
      second,
      (message) =>
        message.event === "session-changed" &&
        message.user === session.accountId,
    );
    await command(first, "install", session);
    await observed;
    const snapshots = await Promise.all(
      [first, second, third].map((child) => command(child, "read")),
    );
    expect(snapshots.map((snapshot) => snapshot.accountId)).toEqual(
      Array(3).fill(session.accountId),
    );
    expect(await command(isolated, "read")).toBeNull();
    expect(
      await readFile(path.join(root, "shared/secrets.json"), "utf8"),
    ).not.toContain(session.refreshToken);

    const state = `zeros-dev.${"s".repeat(43)}`;
    await command(first, "begin", { state });
    const delivered = waitMessage(
      first,
      (message) => message.event === "callback",
    );
    expect(
      await command(third, "deliver", { state, code: "fixture-code" }),
    ).toBe(true);
    expect((await delivered).code).toBe("fixture-code");
    expect(
      await command(second, "deliver", { state, code: "fixture-code" }),
    ).toBe(false);

    await command(first, "expire");
    const refreshed = await Promise.all(
      [first, second, third].map((child) => command(child, "read")),
    );
    expect(refreshed.map((snapshot) => snapshot.accessToken)).toEqual(
      Array(3).fill("fixture-rotated-access"),
    );
    expect(rotations).toBe(1);
    for (const child of [first, second, third]) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    const restarted = await start("restarted");
    expect(await command(restarted, "read")).toMatchObject({
      accountId: session.accountId,
      accessToken: "fixture-rotated-access",
    });
    expect(rotations).toBe(1);
  });
});
