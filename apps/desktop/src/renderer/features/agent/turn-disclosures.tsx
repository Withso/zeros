import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { AgentMessage } from "./use-agent-session";
import { createTurnDisclosureStore, type DisclosureValue } from "./turn-disclosure-store";

const TurnDisclosures = createContext<ReturnType<typeof createTurnDisclosureStore> | null>(null);

/** Key this boundary by the exact workspace/chat. It lives above the working
 * stripes so a late answer phase can split them without resetting row choices. */
export function TurnDisclosureProvider({ events, subagentChildren, children }: {
  events: AgentMessage[];
  subagentChildren: ReadonlyMap<string, AgentMessage[]>;
  children: ReactNode;
}) {
  const [store] = useState(createTurnDisclosureStore);
  // Only a committed snapshot may evict choices; abandoned renders cannot.
  useLayoutEffect(() => {
    store.retain(events, subagentChildren);
  }, [store, events, subagentChildren]);
  return <TurnDisclosures.Provider value={store}>{children}</TurnDisclosures.Provider>;
}

export function useTurnDisclosure<T extends DisclosureValue>(
  messageId: string,
  disclosure: string,
  defaultValue: T,
): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(TurnDisclosures);
  // Standalone rows retain their existing component-local lifetime.
  const [localValue, setLocalValue] = useState(defaultValue);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(messageId, listener) ?? (() => {}),
    [store, messageId],
  );
  const snapshot = useCallback(() => {
    const value = store?.get(messageId, disclosure);
    return value === undefined ? localValue : value as T;
  }, [store, messageId, disclosure, localValue]);
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    if (store) store.set(messageId, disclosure, typeof next === "function" ? next(snapshot()) : next);
    else setLocalValue(next);
  }, [store, messageId, disclosure, snapshot]);
  return [value, setValue];
}
