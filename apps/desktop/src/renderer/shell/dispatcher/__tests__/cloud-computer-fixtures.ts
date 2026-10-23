import type { CloudComputerRepository } from "../../../features/settings/cloud-computer-v2-create-gate";

export const computerOrg = "11111111-1111-4111-8111-111111111111";
export const otherComputerOrg = "33333333-3333-4333-8333-333333333333";
export const computerUser = "44444444-4444-4444-8444-444444444444";

export function computerRepository(owner: string, name: string, defaultBranch: string | null = "main"): CloudComputerRepository {
  return { id: `${owner}/${name}`.toLowerCase(), owner, name, defaultBranch };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
