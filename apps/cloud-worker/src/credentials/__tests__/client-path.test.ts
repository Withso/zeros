import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { askpass, brokerRequest, runGh } from "../client";
import { GithubBroker } from "../github";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const privatePath = "/tmp/zeros-github-12345678-1234-4234-9234-123456789abc/github.sock";

it.each([
  { name: "empty", path: "" },
  { name: "relative", path: privatePath.slice(1) },
  { name: "other service", path: "/var/run/docker.sock" },
  { name: "legacy shared socket", path: "/home/user/.local/share/zeros/cloud-worker/github.sock" },
  { name: "other temporary directory", path: privatePath.replace("/tmp/", "/var/tmp/") },
  { name: "extra prefix", path: "/other" + privatePath },
  { name: "extra suffix", path: privatePath + "/other.sock" },
  { name: "other filename", path: privatePath.replace("github.sock", "other.sock") },
  { name: "traversal", path: privatePath.replace("github.sock", "../github.sock") },
  { name: "uppercase UUID", path: privatePath.replace("9abc", "9ABC") },
  { name: "other UUID version", path: privatePath.replace("-4234-", "-3234-") },
  { name: "other UUID variant", path: privatePath.replace("-9234-", "-1234-") },
  { name: "short instance ID", path: "/tmp/zeros-github-fixture/github.sock" },
  { name: "retired private alias", path: privatePath.replace("github.sock", ".retire-fixture/socket") },
  { name: "trailing newline", path: privatePath + "\n" },
  { name: "trailing carriage return", path: privatePath + "\r" },
  { name: "trailing line ending", path: privatePath + "\r\n" },
  { name: "trailing NUL", path: privatePath + "\0" },
])("rejects $name before dialing", async ({ path }) => {
  const dial = vi.spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket) {
    queueMicrotask(() => this.emit("error", Object.assign(new Error("fixture refused"), { code: "EACCES" })));
    return this;
  });
  await expect(brokerRequest(path, "token")).rejects.toMatchObject({ reason: "unavailable" });
  expect(dial).not.toHaveBeenCalled();
});

it.each(["askpass", "gh", "changed"])("refuses a reachable foreign socket through %s", async caller => {
  const directory = await mkdtemp(join(tmpdir(), "unrelated-broker-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const broker = new GithubBroker(join(directory, "github.sock"), async () => {
    requests++; return { token: "fixture-foreign", expiresAt: Date.now() + 120_000 };
  }, () => { requests++; });
  cleanups.push(() => broker.dispose()); await broker.start();
  const execute = vi.fn(async () => 0);
  const request = caller === "askpass" ? askpass("Password for 'https://github.com': ", broker.socketPath)
    : caller === "gh" ? runGh(["pr", "list"], { GH_ZEROS_BROKER_SOCKET: broker.socketPath }, execute)
      : brokerRequest(broker.socketPath, "changed");
  await expect(request).rejects.toMatchObject({ reason: "unavailable" });
  expect(requests).toBe(0); expect(execute).not.toHaveBeenCalled();
});

it("accepts the worker's private socket format for askpass, gh and change notifications", async () => {
  let changed = 0;
  const broker = new GithubBroker(`/tmp/zeros-github-${randomUUID()}/github.sock`, async purpose => ({
    token: `fixture-${purpose}`, expiresAt: Date.now() + 120_000,
  }), () => { changed++; });
  cleanups.push(() => broker.dispose()); await broker.start();
  expect(await askpass("Password for 'https://github.com': ", broker.socketPath)).toBe("fixture-git");
  const execute = vi.fn(async (_args: string[], environment: NodeJS.ProcessEnv) => {
    expect(environment.GH_TOKEN).toBe("fixture-gh"); return 0;
  });
  expect(await runGh(["pr", "create"], { GH_ZEROS_BROKER_SOCKET: broker.socketPath }, execute)).toBe(0);
  expect(execute).toHaveBeenCalledTimes(1); expect(changed).toBe(1);
});
