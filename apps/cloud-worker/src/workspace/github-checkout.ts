import {
  CloudGithubCheckoutSchema,
  type CloudGithubCheckout,
} from "@zeros/protocol/cloud-github-pr";

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
  constructor(
    private readonly read: () => Promise<GithubCheckout>,
    private readonly send: ReportGithubCheckout,
  ) {}
  report(): Promise<GithubCheckout> {
    if (this.flight) return this.flight;
    const flight = (async () => {
      const value = await this.read(),
        signature = JSON.stringify(value);
      if (signature !== this.acknowledged) {
        await this.send(
          CloudGithubCheckoutSchema.parse({
            ...value,
            sequence: ++this.sequence,
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
}
