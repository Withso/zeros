import { spawn } from "node:child_process";

export type PublicationProcessOptions = {
  signal: AbortSignal;
  timeoutMs?: number;
  terminationGraceMs?: number;
  spawnProcess?: typeof spawn;
};

export function runPublicationCommand(
  command: string,
  args: string[],
  options: PublicationProcessOptions,
): Promise<void> {
  if (options.signal.aborted)
    return Promise.reject(new Error("VM OCI image publication cancelled"));
  const timeoutMs = options.timeoutMs ?? 90 * 60_000;
  const graceMs = options.terminationGraceMs ?? 5_000;
  if (
    ![timeoutMs, graceMs].every(
      (value) => Number.isInteger(value) && value > 0 && value <= 90 * 60_000,
    )
  ) {
    return Promise.reject(
      new Error("VM OCI image publication deadline is invalid"),
    );
  }
  return new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? spawn)(command, args, {
      stdio: "inherit",
    });
    let finished = false;
    let failure: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      options.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error: Error) => {
      if (finished || failure) return;
      failure = error;
      // The CLI must release the workflow to its builder/credential cleanup even
      // when graceful termination is ignored. Detached BuildKit is removed there.
      escalation = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* Cleanup still needs control if the process has disappeared. */
        } finally {
          child.unref();
          finish(error);
        }
      }, graceMs);
      try {
        child.kill("SIGTERM");
      } catch {
        /* Escalation remains scheduled. */
      }
    };
    const abort = () =>
      terminate(new Error("VM OCI image publication cancelled"));
    const deadline = setTimeout(
      () => terminate(new Error("VM OCI image publication timed out")),
      timeoutMs,
    );
    child.on("error", () => {
      const error = new Error("VM OCI image build/publish failed");
      if (child.pid === undefined) finish(error);
      else terminate(error);
    });
    child.once("close", (code, signal) =>
      finish(
        failure ??
          (code === 0 && !signal
            ? undefined
            : new Error("VM OCI image build/publish failed")),
      ),
    );
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  });
}
