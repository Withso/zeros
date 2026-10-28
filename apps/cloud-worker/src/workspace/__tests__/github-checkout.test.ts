import { expect, it, vi } from "vitest";
import { GithubCheckoutReporter } from "../github-checkout";

const initial = {
  branch: "topic",
  baseBranch: "main",
  headSha: "a".repeat(40),
};
it("reports confirmed branch and head changes once per boot sequence", async () => {
  const read = vi.fn(async () => initial),
    send = vi.fn(async () => {});
  const reporter = new GithubCheckoutReporter(read, send);
  await reporter.report();
  await reporter.report();
  expect(send).toHaveBeenCalledOnce();
  read.mockResolvedValue({ ...initial, baseBranch: "release" });
  await reporter.report();
  expect(send.mock.calls).toEqual([
    [{ ...initial, sequence: 1 }],
    [{ ...initial, baseBranch: "release", sequence: 2 }],
  ]);
});
it("retries unacknowledged metadata and bounds concurrent observations", async () => {
  const send = vi
    .fn(async () => {})
    .mockRejectedValueOnce(new Error("Response lost"));
  const reporter = new GithubCheckoutReporter(async () => initial, send);
  await expect(reporter.report()).rejects.toThrow("Response lost");
  await Promise.all([reporter.report(), reporter.report()]);
  expect(send.mock.calls).toEqual([
    [{ ...initial, sequence: 1 }],
    [{ ...initial, sequence: 2 }],
  ]);
});
it("reads again after a held pre-push observation before acknowledging preparation", async () => {
  let finish!: () => void;
  const read = vi.fn(async () => initial),
    send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
  const reporter = new GithubCheckoutReporter(read, send);
  const old = reporter.report();
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  read.mockResolvedValue({ ...initial, headSha: "b".repeat(40) });
  const fresh = reporter.fresh();
  finish();
  await old;
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  finish();
  await expect(fresh).resolves.toMatchObject({ headSha: "b".repeat(40) });
});
