/** Run every independent teardown stage even when an earlier stage fails.
 * Cleanup errors are deliberately collapsed to one path-neutral category:
 * Unix socket and cgroup failures otherwise embed private generation paths. */
export async function cleanupZsrRuntime(options) {
  let failed = false;
  try {
    await options.portPolicyControl?.close();
  } catch {
    failed = true;
  }
  if (options.sandboxManager) {
    try {
      options.sandboxManager.cleanupAfterCommand();
    } catch {
      failed = true;
    }
    try {
      await options.sandboxManager.reset();
    } catch {
      failed = true;
    }
  }
  try {
    await options.killCgroup(options.cgroupScope);
  } catch {
    failed = true;
  }
  if (failed) throw new Error("sandbox runtime cleanup failed");
}
