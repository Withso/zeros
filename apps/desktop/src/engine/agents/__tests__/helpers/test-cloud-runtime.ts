import type { CloudRuntimeRoot } from "../../containment/cloud-runtime-root.mjs";
import type { CloudWorkerConfiguration } from "../../containment/cloud-worker-config";

/** A consumer fixture, not an authority override. Resolver tests use real trees. */
export function testCloudRuntime(): CloudRuntimeRoot {
  const runtimeId = `r1-${"a".repeat(64)}`;
  const root = `/opt/zeros-infra/${runtimeId}`;
  const binRoot = `${root}/bin`;
  const libRoot = `${root}/lib/zeros`;
  return {
    schema: "zeros.active-runtime/v1", profile: "v4", runtimeId, root,
    manifestSha256: "a".repeat(64), baseCompatibilityId: `bc1-${"b".repeat(64)}`,
    installerReceiptSha256: "c".repeat(64),
    bootId: "12345678-1234-4234-8234-123456789abc",
    supervisorSessionId: "22345678-1234-4234-8234-123456789abc",
    cgroupRoot: "/sys/fs/cgroup/system.slice/zeros-host.service",
    workerRoot: `${root}/worker`, binRoot, libRoot, node: `${binRoot}/node`,
    startEngine: `${binRoot}/start-engine.sh`, engineNamespace: `${binRoot}/cloud-engine-namespace`,
    processSupervisor: `${binRoot}/cloud-process-supervisor`,
    helpers: {
      setup: `${libRoot}/setup-cloud-workspace.mjs`, attester: `${libRoot}/attest-cloud-worker.mjs`,
      supervisor: `${libRoot}/cloud-worker-supervisor.mjs`, ensureSupervisor: `${libRoot}/ensure-cloud-worker-supervisor.mjs`,
      launcher: `${libRoot}/cloud-engine-launcher.mjs`, setupProcess: `${libRoot}/cloud-setup-process.mjs`,
      profile: `${libRoot}/cloud-runtime-profile.mjs`, consumeAdmission: `${libRoot}/consume-cloud-admission.mjs`,
      gitAskpass: `${libRoot}/cloud-git-askpass.mjs`, installPreviewLinks: `${libRoot}/install-cloud-preview-links.mjs`,
      installGithubCredential: `${libRoot}/install-cloud-github-credential.mjs`, githubRefreshRequest: `${libRoot}/cloud-github-refresh-request.mjs`,
    },
  };
}

export function testCloudWorker(): CloudWorkerConfiguration {
  const runtime = testCloudRuntime();
  return {version:4,backend:"cloud-worker",profile:"zeros-cloud-worker-v4",uid:10001,gid:10001,
    toolchain:{node:runtime.node,supervisor:`${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs`,
      bwrap:"/usr/bin/bwrap",setpriv:"/usr/bin/setpriv"}};
}
