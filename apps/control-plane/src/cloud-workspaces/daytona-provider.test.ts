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
  autoStopMinutes: 0,
  autoArchiveMinutes: 10_080,
  autoDeleteMinutes: -1,
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
    async createSshAccess(resourceId, expiresInMinutes) {
      return {
        id: "ssh-access-1",
        sandboxId: resourceId,
        token: "ssh-token-abcdefghijklmnopqrstuvwxyz",
        expiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
        sshCommand:
          "ssh ssh-token-abcdefghijklmnopqrstuvwxyz@ssh.app.daytona.io",
      };
    },
    async revokeSshAccess(resourceId) {
      return this.get(resourceId);
    },
    async getPreviewUrl(resourceId, port) {
      return {
        sandboxId: resourceId,
        url: `https://${port}-${resourceId}.proxy.daytona.work`,
        token: "preview-token-abcdefghijklmnopqrstuvwxyz",
      };
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

  it("propagates a rate-limit delay without immediately probing again", async () => {
    const client = fakeClient([]);
    const list = vi.spyOn(client, "list");
    client.create = vi.fn(async () => {
      throw new DaytonaTransportError("rate limited", {
        statusCode: 429,
        headers: { "retry-after-sandbox-create": "7" },
      });
    });
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.create(createInput())).rejects.toMatchObject({
      code: "provider_temporarily_unavailable",
      retryable: true,
      retryAfterMs: 7_000,
    });
    expect(list).toHaveBeenCalledTimes(1);
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

  it("rejects a create response for a different immutable workspace generation", async () => {
    const input = createInput();
    const client = fakeClient([]);
    client.create = vi.fn(async () => sandbox(randomUUID(), 2));
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.create(input)).rejects.toMatchObject({
      code: "provider_identity_mismatch",
      retryable: false,
    });
  });

  it("rejects a list result that violates the immutable-label filter", async () => {
    const input = createInput();
    const client = fakeClient([]);
    client.list = async function* () {
      yield sandbox(randomUUID(), 2);
    };
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.find(input)).rejects.toMatchObject({
      code: "provider_identity_mismatch",
      retryable: false,
    });
  });

  it("rejects a detail response for a different exact sandbox id", async () => {
    const workspaceId = randomUUID();
    const requested = sandbox(workspaceId);
    const different = { ...sandbox(workspaceId), id: `${requested.id}-other` };
    const client = fakeClient([requested]);
    client.get = vi.fn(async () => different);
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.inspect(requested.id)).rejects.toMatchObject({
      code: "provider_resource_mismatch",
      retryable: false,
    });
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

  it("mints and revokes bounded SSH access without trusting the provider command", async () => {
    const workspaceId = randomUUID();
    const item = sandbox(workspaceId);
    const client = fakeClient([item]);
    const createSshAccess = vi.spyOn(client, "createSshAccess");
    const revokeSshAccess = vi.spyOn(client, "revokeSshAccess");
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.createSshAccess(item.id, 15)).resolves.toMatchObject({
      providerAccessId: "ssh-access-1",
      credential: "ssh-token-abcdefghijklmnopqrstuvwxyz",
      host: "ssh.app.daytona.io",
      command: "ssh ssh-token-abcdefghijklmnopqrstuvwxyz@ssh.app.daytona.io",
    });
    expect(createSshAccess).toHaveBeenCalledWith(item.id, 15);

    await expect(provider.revokeSshAccess(item.id)).resolves.toBeUndefined();
    expect(revokeSshAccess).toHaveBeenCalledWith(item.id, undefined);
  });

  it("fails closed on an SSH response for another sandbox or executable command text", async () => {
    const item = sandbox(randomUUID());
    const client = fakeClient([item]);
    const revokeSshAccess = vi.spyOn(client, "revokeSshAccess");
    client.createSshAccess = vi.fn(async () => ({
      id: "ssh-access-1",
      sandboxId: "another-sandbox",
      token: "ssh-token-abcdefghijklmnopqrstuvwxyz",
      expiresAt: new Date(Date.now() + 15 * 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      sshCommand:
        "ssh ssh-token-abcdefghijklmnopqrstuvwxyz@ssh.app.daytona.io; touch /tmp/no",
    }));
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.createSshAccess(item.id, 15)).rejects.toMatchObject({
      code: "provider_access_response_invalid",
      retryable: false,
    });
    expect(revokeSshAccess).toHaveBeenCalledWith(item.id, undefined);
  });

  it("returns only a validated private preview endpoint contract", async () => {
    const item = sandbox(randomUUID());
    const client = fakeClient([item]);
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.getPreviewEndpoint(item.id, 4_173)).resolves.toEqual({
      url: `https://4173-${item.id}.proxy.daytona.work/`,
      headerName: "x-daytona-preview-token",
      headerValue: "preview-token-abcdefghijklmnopqrstuvwxyz",
    });
  });

  it("rejects preview endpoints outside the pinned Daytona proxy suffix", async () => {
    const item = sandbox(randomUUID());
    const client = fakeClient([item]);
    client.getPreviewUrl = vi.fn(async () => ({
      sandboxId: item.id,
      url: "https://169.254.169.254/latest/meta-data",
      token: "preview-token-abcdefghijklmnopqrstuvwxyz",
    }));
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(
      provider.getPreviewEndpoint(item.id, 4_173),
    ).rejects.toMatchObject({
      code: "provider_access_response_invalid",
      retryable: false,
    });
  });

  it("revokes all SSH access before stop, archive, or delete can proceed", async () => {
    const workspaceId = randomUUID();
    const item = sandbox(workspaceId);
    const resources = [item];
    const client = fakeClient(resources);
    const calls: string[] = [];
    client.revokeSshAccess = vi.fn(async (resourceId) => {
      calls.push(`revoke:${resourceId}`);
      return client.get(resourceId);
    });
    client.stop = vi.fn(async (resourceId) => {
      calls.push(`stop:${resourceId}`);
      const found = await client.get(resourceId);
      found.state = "stopped";
      return found;
    });
    client.archive = vi.fn(async (resourceId) => {
      calls.push(`archive:${resourceId}`);
      const found = await client.get(resourceId);
      found.state = "archived";
      return found;
    });
    client.delete = vi.fn(async (resourceId) => {
      calls.push(`delete:${resourceId}`);
      resources.splice(0, resources.length);
    });
    const provider = new DaytonaWorkspaceProvider(config, client);

    await provider.stop(item.id);
    await provider.archive(item.id);
    await provider.delete(item.id);

    expect(calls).toEqual([
      `revoke:${item.id}`,
      `stop:${item.id}`,
      `revoke:${item.id}`,
      `archive:${item.id}`,
      `revoke:${item.id}`,
      `delete:${item.id}`,
    ]);
  });

  it("revokes SSH but does not redispatch stop for an already-stopped sandbox", async () => {
    const item = sandbox(randomUUID(), 1, "stopped");
    const client = fakeClient([item]);
    const revokeSshAccess = vi.spyOn(client, "revokeSshAccess");
    const stop = vi.spyOn(client, "stop");
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.stop(item.id)).resolves.toMatchObject({
      resourceId: item.id,
      state: "stopped",
    });
    expect(revokeSshAccess).toHaveBeenCalledWith(item.id, undefined);
    expect(stop).not.toHaveBeenCalled();
  });

  it("revokes SSH but does not move an already-archived sandbox backwards", async () => {
    const item = sandbox(randomUUID(), 1, "archived");
    const client = fakeClient([item]);
    const revokeSshAccess = vi.spyOn(client, "revokeSshAccess");
    const stop = vi.spyOn(client, "stop");
    const archive = vi.spyOn(client, "archive");
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.archive(item.id)).resolves.toMatchObject({
      resourceId: item.id,
      state: "archived",
    });
    expect(revokeSshAccess).toHaveBeenCalledWith(item.id, undefined);
    expect(stop).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
  });

  it("does not redispatch lifecycle mutations while Daytona is already converging", async () => {
    const cases = [
      { operation: "start" as const, state: "starting" },
      { operation: "stop" as const, state: "stopping" },
      { operation: "archive" as const, state: "archiving" },
    ];

    for (const itemCase of cases) {
      const item = sandbox(randomUUID(), 1, itemCase.state);
      const client = fakeClient([item]);
      const start = vi.spyOn(client, "start");
      const stop = vi.spyOn(client, "stop");
      const archive = vi.spyOn(client, "archive");
      const provider = new DaytonaWorkspaceProvider(config, client);

      await expect(
        provider[itemCase.operation](item.id),
      ).resolves.toMatchObject({
        resourceId: item.id,
      });
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(archive).not.toHaveBeenCalled();
    }
  });

  it("keeps an eventually deleting sandbox retryable after a repeated delete conflict", async () => {
    const item = sandbox(randomUUID(), 1, "destroying");
    const client = fakeClient([item]);
    client.delete = vi.fn(async () => {
      throw new DaytonaTransportError("delete already in progress", {
        statusCode: 409,
      });
    });
    const provider = new DaytonaWorkspaceProvider(config, client);

    await expect(provider.delete(item.id)).rejects.toMatchObject({
      code: "provider_delete_unverified",
      retryable: true,
    });
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

  it("sends bounded SSH and private-preview calls through the pinned generated client", async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: IncomingHttpHeaders;
    }> = [];
    const resourceId = "provider-contract-test";
    const credential = "ssh-token-abcdefghijklmnopqrstuvwxyz";
    const server = createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
      });
      response.setHeader("content-type", "application/json");
      const url = new URL(request.url!, "http://test.invalid");
      if (
        request.method === "POST" &&
        url.pathname === `/sandbox/${resourceId}/ssh-access`
      ) {
        response.statusCode = 201;
        response.end(
          JSON.stringify({
            id: "ssh-access-1",
            sandboxId: resourceId,
            token: credential,
            expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sshCommand: `ssh ${credential}@ssh.app.daytona.io`,
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        url.pathname === `/sandbox/${resourceId}/ports/4173/preview-url`
      ) {
        response.end(
          JSON.stringify({
            sandboxId: resourceId,
            url: `https://4173-${resourceId}.proxy.daytona.work`,
            token: "preview-token-abcdefghijklmnopqrstuvwxyz",
          }),
        );
        return;
      }
      if (
        request.method === "DELETE" &&
        url.pathname === `/sandbox/${resourceId}/ssh-access`
      ) {
        response.end(JSON.stringify({ id: resourceId }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "unexpected contract request" }));
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
      await expect(
        provider.createSshAccess(resourceId, 15),
      ).resolves.toMatchObject({
        credential,
        host: "ssh.app.daytona.io",
      });
      await expect(
        provider.getPreviewEndpoint(resourceId, 4_173),
      ).resolves.toEqual({
        url: `https://4173-${resourceId}.proxy.daytona.work/`,
        headerName: "x-daytona-preview-token",
        headerValue: "preview-token-abcdefghijklmnopqrstuvwxyz",
      });
      await expect(
        provider.revokeSshAccess(resourceId),
      ).resolves.toBeUndefined();

      expect(
        requests.map((request) => {
          const url = new URL(request.url!, "http://test.invalid");
          return {
            method: request.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            authorization: request.headers.authorization,
            source: request.headers["x-daytona-source"],
            sdkVersion: request.headers["x-daytona-sdk-version"],
          };
        }),
      ).toEqual([
        {
          method: "POST",
          path: `/sandbox/${resourceId}/ssh-access`,
          query: { expiresInMinutes: "15" },
          authorization: "Bearer test-key-do-not-use",
          source: "zeros-control-plane",
          sdkVersion: "0.190.1",
        },
        {
          method: "GET",
          path: `/sandbox/${resourceId}/ports/4173/preview-url`,
          query: {},
          authorization: "Bearer test-key-do-not-use",
          source: "zeros-control-plane",
          sdkVersion: "0.190.1",
        },
        {
          method: "DELETE",
          path: `/sandbox/${resourceId}/ssh-access`,
          query: {},
          authorization: "Bearer test-key-do-not-use",
          source: "zeros-control-plane",
          sdkVersion: "0.190.1",
        },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
