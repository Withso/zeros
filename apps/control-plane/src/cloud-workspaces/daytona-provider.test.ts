import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";

import {
  DaytonaTransportError,
  DaytonaWorkspaceProvider,
  mapDaytonaState,
  type DaytonaClientLike,
  type DaytonaWorkspaceProviderConfig,
} from "./daytona-provider.js";

const config: DaytonaWorkspaceProviderConfig = {
  apiKey: "test-key-do-not-use",
  apiUrl: "https://api.example.test",
  target: "eu",
  snapshotId: "snap-pinned",
  architecture: "linux/amd64",
  cpuMillicores: 2_000,
  memoryMiB: 4_096,
  storageMiB: 20_480,
  operationTimeoutSeconds: 30,
  autoArchiveMinutes: 10_080,
};

type FakeSandbox = Awaited<ReturnType<DaytonaClientLike["get"]>>;

function sandbox(
  workspaceId: string,
  generation = 1,
  state = "started",
): FakeSandbox {
  const value = {
    id: `provider-${workspaceId}-${generation}`,
    state,
    target: "eu",
    labels: {
      zeros_managed: "true",
      zeros_workspace: workspaceId,
      zeros_generation: String(generation),
    },
    snapshot: "snap-pinned",
    cpu: 2,
    memory: 4,
    disk: 20,
    public: false,
    errorReason: undefined,
    autoStopInterval: 0,
    autoArchiveInterval: 10_080,
    autoDeleteInterval: -1,
  };
  return value as FakeSandbox;
}

function fakeClient(resources: FakeSandbox[]): DaytonaClientLike {
  return {
    async create(params) {
      const created = sandbox(
        params.labels.zeros_workspace!,
        Number(params.labels.zeros_generation),
      );
      resources.push(created);
      return created;
    },
    async get(resourceId) {
      const found = resources.find((item) => item.id === resourceId);
      if (!found)
        throw new DaytonaTransportError("missing", { statusCode: 404 });
      return found;
    },
    async *list(query) {
      for (const item of resources) {
        if (
          Object.entries(query.labels).every(
            ([key, value]) => item.labels[key] === value,
          )
        ) {
          yield item;
        }
      }
    },
    async start(resourceId) {
      const found = await this.get(resourceId);
      found.state = "started";
      return found;
    },
    async stop(resourceId) {
      const found = await this.get(resourceId);
      found.state = "stopped";
      return found;
    },
    async archive(resourceId) {
      const found = await this.get(resourceId);
      found.state = "archived";
      return found;
    },
    async delete(resourceId) {
      const index = resources.findIndex((item) => item.id === resourceId);
      if (index < 0) {
        throw new DaytonaTransportError("missing", { statusCode: 404 });
      }
      resources.splice(index, 1);
    },
  };
}

function createInput(workspaceId = randomUUID()) {
  return {
    workspaceId,
    generation: 1,
    imageRef: "snap-pinned",
    architecture: "linux/amd64" as const,
    cpuMillicores: 2_000,
    memoryMiB: 4_096,
    storageMiB: 20_480,
    idempotencyKey: randomUUID(),
  };
}

describe("DaytonaWorkspaceProvider", () => {
  it("maps provider lifecycle states without treating unknown values as ready", () => {
    expect(mapDaytonaState("started")).toBe("running");
    expect(mapDaytonaState("stopped")).toBe("stopped");
    expect(mapDaytonaState("archived")).toBe("archived");
    expect(mapDaytonaState("paused")).toBe("stopped");
    expect(mapDaytonaState("destroying")).toBe("deleting");
    expect(mapDaytonaState("a-new-provider-state")).toBe("unknown");
  });

  it("returns the existing immutable-label match instead of creating twice", async () => {
    const workspaceId = randomUUID();
    const resources = [sandbox(workspaceId)];
    const client = fakeClient(resources);
    const create = vi.spyOn(client, "create");
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(
      provider.create(createInput(workspaceId)),
    ).resolves.toMatchObject({
      resourceId: resources[0]!.id,
      workspaceId,
      generation: 1,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("hydrates sparse list results before validating the pinned resource contract", async () => {
    const workspaceId = randomUUID();
    const complete = sandbox(workspaceId);
    const client = fakeClient([complete]);
    client.list = async function* () {
      yield {
        id: complete.id,
        state: complete.state,
        target: complete.target,
        labels: complete.labels,
      } as FakeSandbox;
    };
    const get = vi.spyOn(client, "get");
    const create = vi.spyOn(client, "create");
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(
      provider.create(createInput(workspaceId)),
    ).resolves.toMatchObject({
      resourceId: complete.id,
      workspaceId,
      generation: 1,
    });
    expect(get).toHaveBeenCalledWith(complete.id);
    expect(create).not.toHaveBeenCalled();
  });

  it("recovers a create timeout by finding the committed provider resource", async () => {
    const workspaceId = randomUUID();
    const resources: FakeSandbox[] = [];
    const client = fakeClient(resources);
    client.create = vi.fn(async (params) => {
      resources.push(
        sandbox(
          params.labels.zeros_workspace!,
          Number(params.labels.zeros_generation),
        ),
      );
      throw new DaytonaTransportError("response lost", {
        statusCode: 408,
        transportCode: "ECONNABORTED",
      });
    });
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(
      provider.create(createInput(workspaceId)),
    ).resolves.toMatchObject({ workspaceId, state: "running" });
    expect(resources).toHaveLength(1);
  });

  it("fails closed when provider identity labels resolve to duplicates", async () => {
    const workspaceId = randomUUID();
    const first = sandbox(workspaceId);
    const second = sandbox(workspaceId);
    second.id = `${second.id}-duplicate`;
    const client = fakeClient([first, second]);
    const create = vi.spyOn(client, "create");
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(
      provider.create(createInput(workspaceId)),
    ).rejects.toMatchObject({
      code: "provider_identity_ambiguous",
      retryable: false,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("does not let a database generation select an unconfigured image", async () => {
    const client = fakeClient([]);
    const provider = new DaytonaWorkspaceProvider(config, client);
    await expect(
      provider.create({
        ...createInput(),
        imageRef: "snap-attacker-selected",
      }),
    ).rejects.toMatchObject({
      code: "provider_generation_mismatch",
      retryable: false,
    });
  });

  it("rejects resource drift instead of silently using provider defaults", async () => {
    const client = fakeClient([]);
    const provider = new DaytonaWorkspaceProvider(config, client);
    await expect(
      provider.create({ ...createInput(), memoryMiB: 8_192 }),
    ).rejects.toMatchObject({
      code: "provider_generation_mismatch",
      retryable: false,
    });
  });

  it("durably observes stop before archive and verifies delete through absence", async () => {
    const workspaceId = randomUUID();
    const item = sandbox(workspaceId);
    const resources = [item];
    const client = fakeClient(resources);
    const stop = vi.spyOn(client, "stop");
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.archive(item.id)).resolves.toMatchObject({
      state: "stopped",
    });
    expect(stop).toHaveBeenCalledOnce();
    await expect(provider.archive(item.id)).resolves.toMatchObject({
      state: "archived",
    });
    await expect(provider.delete(item.id)).resolves.toBeUndefined();
    await expect(provider.inspect(item.id)).resolves.toBeNull();
  });

  it("normalizes a conflict that cannot be recovered as a provider failure", async () => {
    const client = fakeClient([]);
    client.create = vi.fn(async () => {
      throw new DaytonaTransportError("occupied", { statusCode: 409 });
    });
    const provider = new DaytonaWorkspaceProvider(config, client);
    await expect(provider.create(createInput())).rejects.toMatchObject({
      code: "provider_request_failed",
      retryable: false,
    });
  });

  it("sends the exact private, pinned resource contract through the generated API client", async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: IncomingHttpHeaders;
      body: unknown;
    }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: rawBody ? JSON.parse(rawBody) : null,
      });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify({ items: [], nextCursor: null }));
        return;
      }
      const body = JSON.parse(rawBody) as Record<string, unknown>;
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          id: "provider-contract-test",
          state: "creating",
          target: body.target,
          labels: body.labels,
          snapshot: body.snapshot,
          cpu: body.cpu,
          memory: body.memory,
          disk: body.disk,
          public: body.public,
          autoStopInterval: body.autoStopInterval,
          autoArchiveInterval: body.autoArchiveInterval,
          autoDeleteInterval: body.autoDeleteInterval,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const port = (server.address() as AddressInfo).port;
      const provider = new DaytonaWorkspaceProvider({
        ...config,
        apiUrl: `http://127.0.0.1:${port}`,
      });
      const input = createInput();
      await expect(provider.create(input)).resolves.toMatchObject({
        state: "provisioning",
        workspaceId: input.workspaceId,
      });

      expect(requests).toHaveLength(2);
      const lookupUrl = new URL(requests[0]!.url!, "http://test.invalid");
      expect(requests[0]).toMatchObject({ method: "GET" });
      expect(JSON.parse(lookupUrl.searchParams.get("labels")!)).toEqual({
        zeros_managed: "true",
        zeros_workspace: input.workspaceId,
        zeros_generation: "1",
      });
      expect(requests[1]).toMatchObject({
        method: "POST",
        headers: {
          authorization: "Bearer test-key-do-not-use",
          "x-daytona-source": "zeros-control-plane",
          "x-daytona-sdk-version": "0.190.1",
        },
        body: {
          name: `zeros-${input.workspaceId}-g1`,
          snapshot: "snap-pinned",
          target: "eu",
          public: false,
          cpu: 2,
          memory: 4,
          disk: 20,
          autoStopInterval: 0,
          autoArchiveInterval: 10_080,
          autoDeleteInterval: -1,
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
