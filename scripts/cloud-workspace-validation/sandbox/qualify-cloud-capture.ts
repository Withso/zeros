import { createCloudDesignCaptureHost } from "../../../apps/desktop/src/engine/design/capture-cloud";
import { assertDesignCapturePng } from "../../../apps/desktop/src/engine/design/capture-service";

// The parent runs this inside the exact engine view. Exercise the production
// capture host, separate UID, sandboxed Chromium and PNG validation together.
async function main() {
  const started = performance.now();
  const result = await createCloudDesignCaptureHost()(
    {
      version: 1,
      html: "<!doctype html><style>body{margin:0;background:#123456}</style><body>Capture</body>",
      revision: "cloud-runtime-qualification",
      width: 80,
      height: 48,
      colorScheme: "light",
    },
    AbortSignal.timeout(30000),
  );
  assertDesignCapturePng(result.bytes, 80, 48);
  process.stdout.write(
    `${JSON.stringify({
      secure: true,
      renderer: result.renderer,
      bytes: result.bytes.length,
      durationMs: Math.round(performance.now() - started),
    })}\n`,
  );
}

main().catch(() => {
  process.stdout.write(
    `${JSON.stringify({ secure: false, error: "Sandboxed cloud capture did not qualify" })}\n`,
  );
  process.exitCode = 1;
});
