import { runCloudEngineRootKernelFixture } from "./cloud-engine-root-kernel-fixture";

runCloudEngineRootKernelFixture().then(
  result => process.stdout.write(JSON.stringify(result) + "\n"),
  error => {
    const message = typeof error?.message === "string" && /^[a-z][a-z0-9_]{1,100}$/.test(error.message)
      ? error.message : "runtime_kernel_fixture_refused";
    process.stdout.write(JSON.stringify({ failed: true, cause: message }) + "\n");
    process.exitCode = 1;
  },
);
