// Run on the immutable Linux capture image as its non-root engine user. This
// probes source tools and rendering; it does not qualify a hosted bridge.
import { createServer } from "node:http";
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
import { fileURLToPath } from "node:url";
import { createCloudCaptureQualificationRuntime } from "./cloud-workspace-validation/sandbox/qualify-cloud-capture";
import { inspectCloudQualificationWorkloads, type CloudQualificationRuntime } from "./cloud-workspace-validation/sandbox/cloud-qualification-runtime";
import {
  expectedCloudCaptureRenderer,
  writeCloudCaptureReport,
} from "./design-cloud-capture-report";
const assert = (ok: unknown, label: string) => {
  if (!ok) throw new Error(label);
  console.log("PASS", label);
};
async function workers(context: CloudQualificationRuntime) {
  const current = await inspectCloudQualificationWorkloads(context);
  return current.workloadPids.length + current.pendingLaunches;
}
async function main() {
  const context = createCloudCaptureQualificationRuntime();
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
    service = await startCloudDesignCapture(context.boundary);
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
      "Pinned same-user cloud worker returns a bounded PNG with Chromium sandbox",
    );
    const reply = await first.json();
    const renderer = expectedCloudCaptureRenderer();
    assert(reply.renderer === renderer, "Cloud capture uses the pinned renderer");
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
      (await workers(context)) === 0,
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
    for (let n = 0; n < 100 && !(await workers(context)); n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(await workers(context) > 0, "Cancellation observes an original capture workload before Stop");
    abort.abort();
    await pending;
    for (let n = 0; n < 200 && (await workers(context)); n++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert(
      (await workers(context)) === 0,
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
    const call = async (name: string, input: unknown) => {
      const response = await tools!.callTool(name, input, new AbortController().signal);
      const content = response.content[0];
      if (content?.type !== "text") throw new Error("Design tool response was not text");
      return JSON.parse(content.text);
    };
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
      (await workers(context)) === 0,
      "Result generation leaves no browser process",
    );
    const reportFile = await writeCloudCaptureReport({
      platform: process.platform,
      arch: process.arch,
      renderer,
      checkedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      activeWorkers: await inspectCloudQualificationWorkloads(context),
      networkReads,
      hostedCloud: false,
      limitation:
        "Production capture worker on a Linux VM fixture; deployed Boat admission/bridge qualification is separate.",
    });
    console.log("Qualification report:", reportFile);
  } finally {
    tools?.dispose();
    await service.stop();
    await new Promise<void>((resolve) => network.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Cloud capture qualification failed."); process.exitCode = 1; });
}
