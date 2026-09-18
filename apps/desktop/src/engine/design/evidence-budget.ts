import { AsyncLocalStorage } from "node:async_hooks";

/** Bound the expensive composition/artifact work across all workspaces and
 * actors, before allocating source bundles. Saturation has no retained queue. */
export class DesignEvidenceBudget {
  private running = 0;
  private readonly owner = new AsyncLocalStorage<{ active: boolean }>();
  constructor(private readonly limit = 2) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.owner.getStore()?.active) return work();
    if (this.running >= this.limit)
      throw new Error(
        "Design evidence capacity reached. Wait for an active result to finish.",
      );
    this.running++;
    const owner = { active: true };
    try {
      return await this.owner.run(owner, work);
    } finally {
      owner.active = false;
      this.running--;
    }
  }
}
export const designEvidenceBudget = new DesignEvidenceBudget();
