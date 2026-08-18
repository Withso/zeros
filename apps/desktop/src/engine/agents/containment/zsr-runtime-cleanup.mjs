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

/** Keep teardown attached to every post-initialization exit, including a
 * validation failure that occurs after SRT has produced its wrapper but before
 * the provider process exists. The options object may hold mutable runtime
 * state (for example a cgroup allocated by `action`); cleanup reads it only
 * after the action settles. */
export async function withZsrRuntimeCleanup(options, action) {
  try {
    return await action();
  } finally {
    await cleanupZsrRuntime(options);
  }
}
