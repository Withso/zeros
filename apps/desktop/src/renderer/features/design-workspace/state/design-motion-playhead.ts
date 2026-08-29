import { create } from "zustand";

const MAX_MOTION_PLAYHEAD_OWNERS = 32;

interface DesignMotionPlayheadStore {
  byOwner: Record<string, number>;
  ownerOrder: string[];
}

export const useDesignMotionPlayheadStore =
  create<DesignMotionPlayheadStore>(() => ({
    byOwner: {},
    ownerOrder: [],
  }));

/** Publish one hot playhead scalar without invalidating the canvas parent. */
export function publishDesignMotionPlayhead(
  owner: string,
  playhead: number,
): void {
  if (!owner || !Number.isFinite(playhead)) return;
  const bounded = Math.min(100, Math.max(0, playhead));
  useDesignMotionPlayheadStore.setState((state) => {
    if (state.byOwner[owner] === bounded) return state;
    const ownerOrder = [
      ...state.ownerOrder.filter((candidate) => candidate !== owner),
      owner,
    ].slice(-MAX_MOTION_PLAYHEAD_OWNERS);
    const retained = new Set(ownerOrder);
    return {
      byOwner: Object.fromEntries(
        Object.entries({ ...state.byOwner, [owner]: bounded }).filter(
          ([candidate]) => retained.has(candidate),
        ),
      ),
      ownerOrder,
    };
  });
}

export function designMotionPlayhead(owner: string): number {
  return useDesignMotionPlayheadStore.getState().byOwner[owner] ?? 0;
}

export function useDesignMotionPlayhead(owner: string): number {
  return useDesignMotionPlayheadStore(
    (state) => state.byOwner[owner] ?? 0,
  );
}

export function resetDesignMotionPlayheadsForTests(): void {
  useDesignMotionPlayheadStore.setState({ byOwner: {}, ownerOrder: [] });
}
