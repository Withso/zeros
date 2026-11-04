import {
  CloudGithubCheckoutSchema,
  type CloudGithubCheckout,
} from "@zeros/protocol/cloud-github-pr";
import { WorkspaceError } from "./scope";

export type GithubCheckout = Omit<CloudGithubCheckout, "sequence">;
export type ReportGithubCheckout = (
  value: CloudGithubCheckout,
) => Promise<void>;

/** One monotonic stream per worker boot. A lost acknowledgement is retried on
 * the next observation; no failed read becomes confirmed branch metadata. */
export class GithubCheckoutReporter {
  private sequence = 0;
  private acknowledged = "";
  private flight?: Promise<GithubCheckout>;
  private disposed = false;
  constructor(
    private readonly read: () => Promise<GithubCheckout>,
    private readonly send: ReportGithubCheckout,
    private readonly nextSequence: () => number = () => ++this.sequence,
  ) {}
  report(): Promise<GithubCheckout> {
    if (this.disposed) return Promise.reject(new WorkspaceError("WORKSPACE_UNAVAILABLE", "Checkout reporting is closed."));
    if (this.flight) return this.flight;
    const flight = (async () => {
      const value = await this.read(),
        signature = JSON.stringify(value);
      if (this.disposed) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "Checkout reporting is closed.");
      if (signature !== this.acknowledged) {
        await this.send(
          CloudGithubCheckoutSchema.parse({
            ...value,
            sequence: this.nextSequence(),
          }),
        );
        this.acknowledged = signature;
      }
      return value;
    })().finally(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    this.flight = flight;
    return flight;
  }
  async fresh(): Promise<GithubCheckout> {
    await this.flight?.catch(() => {});
    return this.report();
  }
  async flush(): Promise<void> { await this.flight?.catch(() => {}); }
  async dispose(): Promise<void> { this.disposed = true; await this.flush(); }
}
