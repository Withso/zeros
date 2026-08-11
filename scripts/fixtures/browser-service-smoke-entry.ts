import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app } from "electron";

import { startZerosBrowserService } from "../../apps/desktop/electron/browser/service";

async function listen(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return address.port;
}

app
  .whenReady()
  .then(async () => {
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "zeros-browser-smoke-artifacts-"),
    );
    const movedWorkspaceRoot = await mkdtemp(
      join(tmpdir(), "zeros-browser-smoke-workspace-"),
    );
    const fixture = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>Zeros browser smoke</title>
        <button aria-label="Pay now" onclick="document.querySelector('#result').textContent='paid'">Pay now</button>
        <input type="file" aria-label="Evidence file">
        <div id="result"></div>
        <script>
          const role = new URLSearchParams(location.search).get('role');
          if (role === 'writer') localStorage.setItem('zeros-browser-smoke', 'private');
          if (role === 'reader') document.querySelector('#result').textContent = localStorage.getItem('zeros-browser-smoke') || 'isolated';
        </script>`);
    });
    let service: Awaited<ReturnType<typeof startZerosBrowserService>> | null =
      null;
    try {
      const fixturePort = await listen(fixture);
      const confirmations: string[] = [];
      service = await startZerosBrowserService({
        artifactRoot,
        onConfirmationRequest: (request) => {
          confirmations.push(request.category);
          queueMicrotask(() =>
            service?.respondToConfirmation(request.id, "allow-once"),
          );
        },
      });
      const request = async (
        path: string,
        body: unknown,
        token = service!.token,
      ) =>
        fetch(`${service!.baseUrl}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });

      const denied = await request(
        "/v1/sessions/acquire",
        { version: 1, owner: owner("conversation-a", artifactRoot) },
        "wrong-token",
      );
      assert.equal(denied.status, 401);

      const acquired = await request("/v1/sessions/acquire", {
        version: 1,
        owner: owner("conversation-a", artifactRoot),
      });
      assert.equal(acquired.ok, true);
      const first = (await acquired.json()) as { browserSessionId: string };
      const reacquired = await request("/v1/sessions/acquire", {
        version: 1,
        owner: owner("conversation-a", artifactRoot),
      });
      assert.equal(
        ((await reacquired.json()) as { browserSessionId: string })
          .browserSessionId,
        first.browserSessionId,
      );
      const moved = await request("/v1/sessions/acquire", {
        version: 1,
        owner: owner("conversation-a", movedWorkspaceRoot),
      });
      assert.equal(
        ((await moved.json()) as { browserSessionId: string }).browserSessionId,
        first.browserSessionId,
      );
      const uploadPath = join(movedWorkspaceRoot, "evidence.txt");
      await writeFile(uploadPath, "browser upload evidence", { mode: 0o600 });

      const invoke = async (tool: string, args: unknown = {}) => {
        const response = await request(
          `/v1/sessions/${first.browserSessionId}/invoke`,
          { version: 1, tool, arguments: args },
        );
        assert.equal(response.ok, true);
        return (await response.json()) as {
          success: boolean;
          content: Array<{ type: string; text?: string; data?: string }>;
        };
      };
      const opened = await invoke("open", {
        url: `http://127.0.0.1:${fixturePort}/?role=writer`,
      });
      assert.equal(opened.success, true);
      const snapshot = JSON.parse(opened.content[0]!.text!) as {
        title: string;
        elements: Array<{ ref: string; name: string }>;
      };
      assert.equal(snapshot.title, "Zeros browser smoke");
      const payRef = snapshot.elements.find(
        ({ name }) => name === "Pay now",
      )?.ref;
      const uploadRef = snapshot.elements.find(
        ({ name }) => name === "Evidence file",
      )?.ref;
      assert(payRef);
      assert(uploadRef);
      assert.equal((await invoke("click", { ref: payRef })).success, true);
      assert.equal(
        (await invoke("upload", { ref: uploadRef, path: uploadPath })).success,
        true,
      );
      assert.deepEqual(confirmations, ["payment", "file-upload"]);

      const screenshot = await invoke("screenshot");
      assert.equal(
        screenshot.content.some(({ type }) => type === "image"),
        true,
      );
      assert.equal((await invoke("trace")).success, true);

      const second = await service.acquire(
        owner("conversation-b", artifactRoot),
      );
      const reader = await service.invoke({
        version: 1,
        browserSessionId: second.browserSessionId,
        tool: "open",
        arguments: { url: `http://127.0.0.1:${fixturePort}/?role=reader` },
      });
      assert.match(
        reader.content[0]!.type === "text" ? reader.content[0].text : "",
        /isolated/,
      );

      const wrongDelete = await fetch(
        `${service.baseUrl}/v1/sessions/${first.browserSessionId}/invoke`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${service.token}` },
        },
      );
      assert.equal(wrongDelete.status, 404);
      assert.equal((await invoke("snapshot")).success, true);

      assert.equal(await service.revokeConfirmationSurface(), 0);
      assert.equal((await invoke("snapshot")).success, false);
      const afterSurfaceReset = await service.acquire(
        owner("conversation-a", movedWorkspaceRoot),
      );
      assert.equal(afterSurfaceReset.browserSessionId, first.browserSessionId);
      const reopened = await invoke("open", {
        url: `http://127.0.0.1:${fixturePort}/?role=reader`,
      });
      assert.match(
        reopened.content[0]!.type === "text" ? reopened.content[0].text : "",
        /isolated/,
      );

      const closed = await fetch(
        `${service.baseUrl}/v1/sessions/${first.browserSessionId}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${service.token}` },
        },
      );
      assert.equal(closed.status, 204);
    } finally {
      if (service) await service.stop();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(artifactRoot, { recursive: true, force: true });
      await rm(movedWorkspaceRoot, { recursive: true, force: true });
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

function owner(conversationId: string, workspaceRoot: string) {
  return {
    workspaceId: "workspace-smoke",
    conversationId,
    workspaceRoot,
  };
}
