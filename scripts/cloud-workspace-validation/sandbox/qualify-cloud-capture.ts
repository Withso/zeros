import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCloudDesignCaptureHost } from "../../../apps/desktop/src/engine/design/capture-cloud";
import { assertDesignCapturePng } from "../../../apps/desktop/src/engine/design/capture-service";
import { createCloudQualificationRuntime, type CloudQualificationRuntime } from "./cloud-qualification-runtime";

export const createCloudCaptureQualificationRuntime = createCloudQualificationRuntime;

/** Observe the fixed PNG worker, not the parent or supervisor. The VM is the
 * boundary; capture shares the engine identity and original Host registry. */
export async function qualifyCloudCapture(context: CloudQualificationRuntime = createCloudQualificationRuntime()) {
  const started = performance.now(), { configuration, workloads, boundary, custody } = context;
  custody.assertLive();
  let observed: {uid:number;gid:number} | null = null;
  const result = await createCloudDesignCaptureHost(boundary, {onIdentity: identity => {observed={...identity};}})(
    {version:1,html:"<!doctype html><style>body{margin:0;background:#123456}</style><body>Capture</body>",
      revision:"cloud-runtime-qualification",width:80,height:48,colorScheme:"light"},
    AbortSignal.timeout(30000));
  assertDesignCapturePng(result.bytes,80,48);
  assert.deepEqual(observed,{uid:configuration.uid,gid:configuration.gid});
  const inspection = await workloads.inspect();
  assert(inspection.complete && !inspection.pendingLaunches && !inspection.failedRetirements && !inspection.workloadPids.length);
  custody.assertLive();
  // The fixed, pinned worker always requests chromiumSandbox:true; its actual
  // PNG/identity is observed only after the original Host launch has retired.
  return {sameEngineIdentity:true,chromiumSandbox:true,renderer:result.renderer,bytes:result.bytes.length,durationMs:Math.round(performance.now()-started)};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  qualifyCloudCapture().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(()=>{
    process.stdout.write(`${JSON.stringify({sameEngineIdentity:false,error:"Cloud capture did not qualify"})}\n`);
    process.exitCode=1;
  });
}
