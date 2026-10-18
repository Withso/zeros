import { createContext, useContext } from "react";
import type { LocalLinkScheme } from "@zeros/protocol/local-orchestration";
import type { LocalLinkIndex } from "./model";

export interface LocalLinksContextValue {
  enabled: boolean;
  scheme: LocalLinkScheme;
  index: LocalLinkIndex | null;
  navigate: (href: string) => void;
}

export const LocalLinksContext = createContext<LocalLinksContextValue>({
  enabled: false,
  scheme: "zeros",
  index: null,
  navigate: () => {},
});
export const useLocalLinks = () => useContext(LocalLinksContext);
