import React, { useEffect, useMemo } from "react";
import {
  WorkerPoolContextProvider,
  useWorkerPool,
} from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";

import { resolveDiffTheme } from "../../shared/theme/diff-theme";
import { useCodeTheme } from "../../shared/theme/use-code-theme";

// @pierre/diffs owns a renderer-wide singleton behind its context. Keep one
// provider around Workbench so retained File/Changes/Review surfaces share two
// workers and one bounded AST cache instead of highlighting on the click path.
const WORKBENCH_DIFF_WORKER_POOL = {
  workerFactory: () => new DiffsWorker(),
  poolSize: 2,
  totalASTLRUCacheSize: 160,
};

function DiffWorkerThemeSync({ theme }: { theme: string }) {
  const pool = useWorkerPool();
  const resolvedTheme = useMemo(() => resolveDiffTheme(theme).theme, [theme]);
  useEffect(() => {
    void pool?.setRenderOptions({ theme: resolvedTheme }).catch(() => {
      // The component falls back to its synchronous renderer if worker setup
      // fails; a theme switch must never make the review surface unusable.
    });
  }, [pool, resolvedTheme]);
  return null;
}

export function DiffWorkerPoolProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const codeTheme = useCodeTheme();
  const theme = useMemo(
    () => resolveDiffTheme(codeTheme).theme,
    [codeTheme],
  );
  const highlighterOptions = useMemo(() => ({ theme }), [theme]);
  return (
    <WorkerPoolContextProvider
      poolOptions={WORKBENCH_DIFF_WORKER_POOL}
      highlighterOptions={highlighterOptions}
    >
      <DiffWorkerThemeSync theme={codeTheme} />
      {children}
    </WorkerPoolContextProvider>
  );
}
