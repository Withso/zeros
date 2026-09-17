import type { SessionNotification } from "../../types";

type Role = "text" | "thought";
type Unit = {
  id: string;
  role: Role;
  text: string;
  source: "delta" | "step" | "stream";
  stepSeen: boolean;
  mirrored: number;
  mirrorText: string;
  callbackMirrored: number;
  boundary: number;
};

/** Cursor's text callbacks have no message id. Match their ordered, one-use
 * stream mirrors within this run. Tool/role boundaries still own display ids;
 * a completed step can replace only the delta unit it actually completes. */
export class CursorTextReconciliation {
  private readonly units: Unit[] = [];
  private readonly emitted = new Map<string, string>();
  private readonly groups = new Map<string, Unit[]>();
  private readonly durations = new Map<string, number>();
  private readonly finalIds = new Set<string>();
  private lastText: Unit | undefined;
  private finalResult: string | undefined;
  private endedText: Unit | undefined;
  private lastThought: Unit | undefined;
  private lastStreamThought: Unit | undefined;
  private lastStreamUnit: Unit | undefined;
  private boundarySequence = 0;
  private readonly pendingSteps: Unit[] = [];
  private readonly mirrors: Unit[] = [];

  constructor(
    private readonly emit: (update: SessionNotification["update"]) => void,
  ) {}

  get hasFinalAnswer(): boolean {
    return this.finalIds.size > 0;
  }

  boundary(): void {
    this.pendingSteps.length = 0;
    this.endedText = undefined;
    this.boundarySequence++;
  }

  /** A native turn may finish while the SDK keeps this run open for children.
   * Keep that report final and give the continuation its own display identity. */
  endTurn(): void {
    const last = this.units.at(-1);
    if (!last || last.boundary !== this.boundarySequence) return;
    const report = last.role === "text" ? last : undefined;
    if (report) this.publish(report, undefined, undefined, true);
    this.boundary();
    this.endedText = report;
  }

  streamToolBoundary(): void {
    this.lastStreamUnit = undefined;
  }

  /** A usage frame closes the stream's own last unit. Callback delivery may
   * already be ahead in a later turn, whose text/identity must stay open. */
  endStreamTurn(): boolean {
    const last = this.lastStreamUnit;
    this.lastStreamUnit = undefined;
    if (!last) return false;
    const report = last.role === "text" ? last : undefined;
    if (report) this.publish(report, undefined, undefined, true);
    if (last.boundary !== this.boundarySequence) return false;
    this.boundary();
    this.endedText = report;
    return true;
  }

  delta(id: string, role: Role, text: string): void {
    let unit = this.units.at(-1);
    if (unit?.id === id && unit.source === "stream" && !unit.stepSeen) {
      const remaining = unit.text.slice(unit.callbackMirrored);
      if (remaining.startsWith(text)) {
        unit.callbackMirrored += text.length;
        return;
      }
      if (!remaining) {
        unit.source = "delta";
        this.mirrors.push(unit);
      }
    }
    if (!unit || unit.id !== id || unit.source !== "delta" || unit.stepSeen) {
      unit = this.create(id, role, "delta");
      this.pendingSteps.push(unit);
      this.mirrors.push(unit);
    }
    unit.text += text;
    unit.mirrorText += text;
    this.publish(unit, undefined, text);
  }

  step(id: string, role: Role, text: string, durationMs?: number): void {
    const index = this.pendingSteps.findIndex((unit) => unit.role === role);
    const unit =
      index < 0
        ? this.create(id, role, "step")
        : this.pendingSteps.splice(index, 1)[0];
    if (index < 0) this.mirrors.push(unit);
    unit.stepSeen = true;
    if (text.startsWith(unit.mirrorText)) unit.mirrorText = text;
    if (unit.source === "stream" && !this.mirrors.includes(unit))
      this.mirrors.push(unit);
    unit.text = text;
    this.publish(unit, durationMs);
  }

  stream(id: string, role: Role, text: string, durationMs?: number): void {
    const index = this.mirrors.findIndex(
      (unit) => unit.role === role && unit.mirrored < unit.mirrorText.length,
    );
    const mirror = this.mirrors[index];
    if (mirror) {
      this.lastStreamUnit = mirror;
      if (role === "thought") this.lastStreamThought = mirror;
      const remaining = mirror.mirrorText.slice(mirror.mirrored);
      if (mirror.stepSeen && text === mirror.text) {
        mirror.mirrored = mirror.mirrorText.length;
        if (durationMs !== undefined) this.publish(mirror, durationMs);
        return;
      }
      if (remaining.startsWith(text)) {
        mirror.mirrored += text.length;
        if (durationMs !== undefined) this.publish(mirror, durationMs);
        return;
      }
      // Some transports deliver a completed text snapshot instead of the
      // incremental mirror. Its suffix belongs to this still-open unit.
      if (!mirror.stepSeen && text.startsWith(remaining)) {
        mirror.text += text.slice(remaining.length);
        mirror.mirrorText = mirror.text;
        mirror.mirrored = mirror.mirrorText.length;
        this.publish(mirror, durationMs);
        return;
      }
      // A missing mirror must not suppress a later stream-only message. Drop
      // this exhausted correlation opportunity, retaining its visible text.
      this.mirrors.splice(index, 1);
    }
    let unit = this.units.at(-1);
    if (!unit || unit.id !== id || unit.source !== "stream" || unit.stepSeen) {
      unit = this.create(id, role, "stream");
      this.pendingSteps.push(unit);
    }
    unit.text += text;
    unit.mirrorText += text;
    unit.mirrored = unit.mirrorText.length;
    this.lastStreamUnit = unit;
    if (role === "thought") this.lastStreamThought = unit;
    this.publish(unit, durationMs, text);
  }

  thinkingDuration(durationMs: number, source: "delta" | "stream"): void {
    const unit =
      source === "stream" ? this.lastStreamThought : this.lastThought;
    if (unit) this.publish(unit, durationMs);
  }

  final(id: string, text: string): void {
    if (this.finalResult === text) return;
    this.finalResult = text;
    const last =
      this.lastText?.boundary === this.boundarySequence
        ? this.lastText
        : this.endedText;
    const previous = last ? (this.emitted.get(last.id) ?? "") : "";
    if (last && previous === text) {
      this.publish(last, undefined, undefined, true);
      return;
    }
    // A final result can finish the last partial answer. An unrelated final
    // answer gets its own id so earlier commentary remains readable.
    if (last && previous && text.startsWith(previous)) {
      last.text += text.slice(previous.length);
      this.publish(last, undefined, undefined, true);
    } else {
      const unit = this.create(id, "text", "stream");
      unit.text = text;
      this.publish(unit, undefined, undefined, true);
    }
  }

  private create(id: string, role: Role, source: Unit["source"]): Unit {
    this.endedText = undefined;
    const unit: Unit = {
      id,
      role,
      source,
      text: "",
      mirrored: 0,
      mirrorText: "",
      callbackMirrored: 0,
      boundary: this.boundarySequence,
      stepSeen: false,
    };
    this.units.push(unit);
    const group = this.groups.get(id) ?? [];
    group.push(unit);
    this.groups.set(id, group);
    if (role === "text") this.lastText = unit;
    else this.lastThought = unit;
    return unit;
  }

  private publish(
    unit: Unit,
    durationMs?: number,
    appended?: string,
    final = false,
  ): void {
    const previous = this.emitted.get(unit.id) ?? "";
    const text =
      appended === undefined
        ? (this.groups.get(unit.id) ?? []).map((value) => value.text).join("")
        : previous + appended;
    if (
      text === previous &&
      (durationMs === undefined ||
        this.durations.get(unit.id) === durationMs) &&
      (!final || this.finalIds.has(unit.id))
    )
      return;
    if (durationMs !== undefined) this.durations.set(unit.id, durationMs);
    if (final) this.finalIds.add(unit.id);
    const replace = !text.startsWith(previous);
    this.emitted.set(unit.id, text);
    this.emit({
      sessionUpdate:
        unit.role === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
      messageId: unit.id,
      content: {
        type: "text",
        text: replace ? text : text.slice(previous.length),
      },
      ...(replace ? { textMode: "replace" as const } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(final ? { phase: "final_answer" as const } : {}),
    });
  }
}
