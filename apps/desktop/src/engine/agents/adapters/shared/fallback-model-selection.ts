import type { CurrentModelUpdate } from "@zeros/protocol/agent-events";

/** Selection lifetime is independent of model observations. A response from an
 * older choice may explain its fallback, but cannot undo a newer user choice. */
export class FallbackModelSelection {
  private revision = 0;
  private turnRevision = 0;
  startedAt = 0;
  constructor(public model: string | null) {}
  beginTurn(): void {
    this.turnRevision = this.revision;
    this.startedAt = Date.now();
  }
  select(model: string): void {
    this.model = model;
    this.revision++;
  }
  adopt(
    model: string,
    fromModel: string | null,
    startedAt = this.startedAt,
  ): CurrentModelUpdate | null {
    if (
      !model.trim() ||
      model.length > 200 ||
      /\s/.test(model) ||
      [...model].some((char) => char.charCodeAt(0) < 32) ||
      this.revision !== this.turnRevision ||
      startedAt !== this.startedAt ||
      (this.model &&
        fromModel &&
        normalized(this.model) !== normalized(fromModel))
    )
      return null;
    const previousModel = this.model;
    if (previousModel === model) return null;
    this.model = model;
    return {
      sessionUpdate: "current_model_update",
      model,
      previousModel,
      turnStartedAt: this.startedAt,
    };
  }
}

function normalized(model: string): string {
  return model.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "");
}
