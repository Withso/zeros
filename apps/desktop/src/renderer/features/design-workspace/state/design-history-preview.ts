interface Entry {
  frame: string;
  before: string;
  after: string;
  beforeState: string;
  afterState: string;
  key?: string;
  time: number;
}
export interface DesignHistoryPrediction {
  frame: string;
  target: string;
}
interface Session {
  entries: Entry[];
  cursor: number;
  confirmedState: string;
  pending: DesignHistoryPrediction[];
}

/** Visual predictions only. The engine owns history; an untracked edit makes
 * prediction unavailable until a new confirmed local transition is recorded. */
export class DesignHistoryPreview {
  private sessions = new Map<string, Session>();

  record(
    workspace: string,
    frame: string,
    before: string,
    after: string,
    beforeState: string,
    afterState: string,
    key?: string,
    time = Date.now(),
  ) {
    if (before === after) return;
    let session = this.sessions.get(workspace);
    if (
      !session ||
      session.confirmedState !== beforeState ||
      session.pending.length
    ) {
      session = {
        entries: [],
        cursor: 0,
        confirmedState: beforeState,
        pending: [],
      };
      this.sessions.delete(workspace);
      this.sessions.set(workspace, session);
      while (this.sessions.size > 16)
        this.sessions.delete(this.sessions.keys().next().value!);
    }
    session.entries.splice(session.cursor);
    const previous = session.entries.at(-1);
    if (
      key &&
      previous?.key === key &&
      previous.frame === frame &&
      time >= previous.time &&
      time - previous.time <= 750
    ) {
      Object.assign(previous, { after, afterState, time });
    } else
      session.entries.push({
        frame,
        before,
        after,
        beforeState,
        afterState,
        key,
        time,
      });
    if (session.entries.length > 64) session.entries.shift();
    session.cursor = session.entries.length;
    session.confirmedState = afterState;
  }

  take(
    workspace: string,
    state: string,
    direction: "undo" | "redo",
  ): DesignHistoryPrediction | null {
    const session = this.sessions.get(workspace);
    if (!session) return null;
    if (session.confirmedState !== state) {
      this.clear(workspace);
      return null;
    }
    const index = direction === "undo" ? session.cursor - 1 : session.cursor;
    const entry = session.entries[index];
    if (!entry) return null;
    session.cursor += direction === "undo" ? -1 : 1;
    const prediction = {
      frame: entry.frame,
      target: direction === "undo" ? entry.before : entry.after,
    };
    session.pending.push(prediction);
    return prediction;
  }

  confirm(
    workspace: string,
    prediction: DesignHistoryPrediction,
    state: string,
  ) {
    const session = this.sessions.get(workspace);
    if (!session) return;
    session.pending = session.pending.filter(
      (candidate) => candidate !== prediction,
    );
    session.confirmedState = state;
  }

  pendingTarget(workspace: string, frame: string): string | undefined {
    return this.sessions
      .get(workspace)
      ?.pending.filter((entry) => entry.frame === frame)
      .at(-1)?.target;
  }

  clear(workspace?: string) {
    if (workspace) this.sessions.delete(workspace);
    else this.sessions.clear();
  }
}
