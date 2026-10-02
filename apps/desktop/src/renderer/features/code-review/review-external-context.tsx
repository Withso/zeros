import { createContext, useContext, type ReactNode } from "react";
import type { CodeReviewExternalSource } from "./review-thread-model";

const ExternalReviewContext = createContext<
  CodeReviewExternalSource | undefined
>(undefined);

export function CodeReviewExternalProvider({
  value,
  children,
}: {
  value: CodeReviewExternalSource | undefined;
  children: ReactNode;
}) {
  return (
    <ExternalReviewContext.Provider value={value}>
      {children}
    </ExternalReviewContext.Provider>
  );
}

export function useCodeReviewExternal(): CodeReviewExternalSource | undefined {
  return useContext(ExternalReviewContext);
}
