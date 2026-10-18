import { createContext, useContext, useEffect, useState, type RefObject } from "react";
import { observeElementActivity } from "@/renderer/shared/lib/element-activity";

/** Undefined preserves the existing scheduling policy. Local owning surfaces
 * supply their active flag; the shared primitives never infer an owner. */
export const ActivityScope = createContext<boolean | undefined>(undefined);

export function useElementActivity(ref: RefObject<Element>, enabled = true): boolean {
  const scope = useContext(ActivityScope);
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (scope !== true || !enabled || !ref.current) return;
    return observeElementActivity(ref.current, setActive);
  }, [scope, enabled, ref]);
  return scope === undefined || (scope && active);
}
