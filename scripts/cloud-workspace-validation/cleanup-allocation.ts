import { makeDaytona, qualificationAllocationStore, withCloudValidationMutationLock } from "./config";
import { cleanupQualificationAllocation } from "./lib/qualification-allocation";

withCloudValidationMutationLock(() => cleanupQualificationAllocation(makeDaytona(), qualificationAllocationStore))
  .catch(() => {
    console.error("Qualification allocation cleanup could not be verified; private intent retained.");
    process.exitCode = 1;
  });
