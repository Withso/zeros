// Fixture-only render causes. Reused fibers carry old PerformedWork flags;
// never count them or descend into an unchanged child list after a bailout.
interface Fiber {
  tag: number;
  flags: number;
  type: { displayName?: string; name?: string } | string | null;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate: Fiber | null;
  memoizedProps: Record<string, unknown> | null;
  memoizedState: Hook | null;
}
interface Hook {
  memoizedState: unknown;
  queue?: unknown;
  next: Hook | null;
}
const label = (fiber: Fiber | null) =>
  typeof fiber?.type === "function" || typeof fiber?.type === "object"
    ? fiber.type?.displayName || fiber.type?.name || "Anonymous"
    : "";
function cause(fiber: Fiber): string {
  const previous = fiber.alternate;
  if (!previous) return "mount";
  let left = previous.memoizedState,
    right = fiber.memoizedState,
    index = 0;
  while (left && right) {
    if (right.queue && !Object.is(left.memoizedState, right.memoizedState))
      return `state#${index}`;
    left = left.next;
    right = right.next;
    index++;
  }
  const before = previous.memoizedProps ?? {},
    after = fiber.memoizedProps ?? {};
  const changed = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].filter((key) => !Object.is(before[key], after[key]));
  return changed.length
    ? `props:${changed.join(",")}`
    : `parent-same-props<-${label(fiber.return)}`;
}
const fixture = window as unknown as {
  streamRenderCounts: Record<string, number>;
  streamRenderCauses: Record<string, Record<string, number>>;
  __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown;
};
fixture.streamRenderCounts = {};
fixture.streamRenderCauses = {};
let previousFibers = new WeakSet<Fiber>();
const renderers = new Map<number, unknown>();
fixture.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers,
  inject(renderer: unknown) {
    renderers.set(1, renderer);
    return 1;
  },
  onCommitFiberRoot(_id: number, root: { current: Fiber }) {
    const seen = new WeakSet<Fiber>();
    function visit(start: Fiber | null) {
      for (let fiber = start; fiber; fiber = fiber.sibling) {
        seen.add(fiber);
        const name = label(fiber);
        if (
          name &&
          [0, 1, 11, 14, 15].includes(fiber.tag) &&
          !previousFibers.has(fiber) &&
          fiber.flags & 1
        ) {
          fixture.streamRenderCounts[name] =
            (fixture.streamRenderCounts[name] ?? 0) + 1;
          const causes = (fixture.streamRenderCauses[name] ??= {});
          const reason = cause(fiber);
          causes[reason] = (causes[reason] ?? 0) + 1;
        }
        if (!fiber.alternate || fiber.child !== fiber.alternate.child)
          visit(fiber.child);
      }
    }
    visit(root.current);
    previousFibers = seen;
  },
  onCommitFiberUnmount() {},
};
