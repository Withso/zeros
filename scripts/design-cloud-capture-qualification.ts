// Run on the immutable Linux capture image as its coordinator user. This
// probes source tools and rendering; it does not qualify a hosted bridge.
import { createServer } from "node:http";
import { readdir, stat, readFile, writeFile } from "node:fs/promises";
import { startCloudDesignCapture } from "../apps/desktop/src/engine/design/capture-cloud";
import { createDesignCaptureRenderer } from "../apps/desktop/src/engine/design/capture-client";
import {
  initializeDesignDocument,
  createDesignFrame,
  readDesignWebDocumentState,
} from "../apps/desktop/src/engine/design/document";
import { designDirectoryEntry } from "../apps/desktop/src/engine/design/metadata";
import { designDirectoryNameFor } from "../apps/desktop/src/engine/design/directory-registry";
import { DesignCodeTools } from "../apps/desktop/src/engine/design/code-tools";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const assert = (ok: unknown, label: string) => {
  if (!ok) throw new Error(label);
  console.log("PASS", label);
};
async function workers() {
  const found: string[] = [];
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (
        (await stat(`/proc/${pid}`)).uid === 10002 &&
        !(await readFile(`/proc/${pid}/stat`, "utf8"))
          .split(") ")[1]!
          .startsWith("Z")
      )
        found.push(pid);
    } catch {}
  }
  return found;
}
async function main() {
  process.env.ZEROS_CLOUD_PORT ??= "39111";
  const root = await mkdtemp(
    path.join(tmpdir(), "zeros-cloud-capture-fixture-"),
  );
  let networkReads = 0;
  const network = createServer((_request, response) => {
    networkReads++;
    response.end("fixture");
  });
  await new Promise<void>((resolve) => network.listen(0, "127.0.0.1", resolve));
  const endpoint = network.address();
  if (!endpoint || typeof endpoint === "string")
    throw new Error("Network fixture missing");
  let service;
  try {
    service = await startCloudDesignCapture();
    if (!service) throw new Error("Cloud capture admission missing");
  } catch (error) {
    await new Promise<void>((resolve) => network.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const request = (signal?: AbortSignal) =>
    fetch(`${service.url}/capture`, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${service.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        revision: "fixture-v1",
        width: 320,
        height: 240,
        html: `<body style="background:red"><img src="http://127.0.0.1:${endpoint.port}/blocked"><script>fetch('http://127.0.0.1:${endpoint.port}/script')</script></body>`,
      }),
    });
  let tools: DesignCodeTools | undefined;
  const started = performance.now();
  try {
    const first = await request();
    assert(
      first.status === 200,
      "Dedicated sandboxed cloud worker returns a bounded PNG",
    );
    const reply = await first.json();
    const png = Buffer.from(reply.data, "base64");
    assert(
      png.readUInt32BE(16) === 320 && png.readUInt32BE(20) === 240,
      "Cloud capture matches exact viewport",
    );
    assert(
      networkReads === 0,
      "Cloud capture blocks network and authored scripts",
    );
    assert(
      (await workers()).length === 0,
      "Completed cloud capture retains no worker/browser processes",
    );
    const concurrent = await Promise.all([request(), request(), request()]);
    assert(
      concurrent.filter((reply) => reply.ok).length === 1 &&
        concurrent.filter((reply) => reply.status === 429).length === 2,
      "Cloud captures share one global admission slot",
    );
    for (const response of concurrent) await response.body?.cancel();
    const abort = new AbortController();
    const pending = request(abort.signal).catch((error) => error);
    for (let n = 0; n < 100 && !(await workers()).length; n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    abort.abort();
    await pending;
    for (let n = 0; n < 200 && (await workers()).length; n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(
      (await workers()).length === 0,
      "Cancellation reaps the cloud capture process group",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await initializeDesignDocument(root);
    const frame = await createDesignFrame(root);
    const state = await readDesignWebDocumentState(root, frame.file);
    const directory = designDirectoryNameFor(root),
      directoryId = designDirectoryEntry(root, directory)!.id;
    tools = new DesignCodeTools(
      {
        workspaceId: "fixture",
        workspacePath: root,
        directory,
        directoryId,
        actorId: "fixture-agent",
        assertCurrent() {},
      },
      {
        renderer: createDesignCaptureRenderer(root, {
          url: service.url,
          token: service.token,
        }),
      },
    );
    const call = async (name: string, input: unknown) =>
      JSON.parse(
        (await tools!.callTool(name, input, new AbortController().signal))
          .content[0].text as string,
      );
    const nodeId = /<main data-oid="([^"]+)"/.exec(
      state.files[frame.file]!,
    )![1]!;
    await call("design_proposal_create", {
      transaction: {
        schemaVersion: 1,
        transactionId: "cloud-proposal",
        actor: { kind: "agent", id: "fixture-agent" },
        createdAt: Date.now(),
        documentId: state.documentId,
        baseRevision: state.revision,
        intent: "Cloud captured proposal",
        operations: [
          {
            operationId: "text",
            type: "node.set-text",
            nodeId,
            text: "Cloud proposal",
          },
        ],
      },
    });
    const evidence = await call("design_result_create", {
      requestId: "cloud-evidence",
      createdAt: Date.now(),
      documentId: state.documentId,
      expectedRevision: state.revision,
      proposalId: "cloud-proposal",
      capture: true,
      width: 320,
      height: 240,
    });
    assert(
      evidence.artifacts["before.png"] &&
        evidence.artifacts["after.png"] &&
        evidence.baseRevision === state.revision &&
        evidence.revision !== state.revision,
      "Headless Code tools persist source-bound before/after cloud evidence",
    );
    assert(
      (await workers()).length === 0,
      "Result generation leaves no browser process",
    );
    await writeFile(
      "/tmp/zeros-design-cloud-qualification.json",
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          renderer: reply.renderer,
          checkedAt: new Date().toISOString(),
          elapsedMs: performance.now() - started,
          activeWorkers: await workers(),
          networkReads,
          hostedCloud: false,
          limitation:
            "Production capture worker on a Linux VM fixture; deployed Daytona admission/bridge qualification is separate.",
        },
        null,
        2,
      ),
    );
  } finally {
    tools?.dispose();
    await service.stop();
    await new Promise<void>((resolve) => network.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Cloud capture qualification failed.",
  );
  process.exitCode = 1;
});
