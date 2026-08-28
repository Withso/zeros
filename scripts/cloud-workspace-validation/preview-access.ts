import { ENGINE_CLOUD_PORT, loadState } from "./config";
import { makeQualifiedControlPlaneProvider } from "./control-plane-provider";
import { requireHttpRoundTrip } from "./lib/qualification-gates";

async function main() {
  const state = loadState();
  const provider = makeQualifiedControlPlaneProvider();
  const endpoint = await provider.getPreviewEndpoint(
    state.sandboxId,
    ENGINE_CLOUD_PORT,
  );
  const target = new URL(endpoint.url);
  target.pathname = "/health";

  const response = await fetch(target, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers: {
      [endpoint.headerName]: endpoint.headerValue,
      "x-daytona-skip-last-activity-update": "true",
    },
  });
  try {
    requireHttpRoundTrip("private preview /health round trip", response.status);
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
  console.log(
    "\n  \x1b[32m✓ private preview works\x1b[0m — the production adapter's server-side header token returned 200.\n",
  );
}

main().catch((error) => {
  console.error("\n  ✗ private preview qualification failed:\n", error);
  process.exit(1);
});
