import type { ExecutionContexts } from "./execution-contexts";
import type { PersonalEnvironments } from "./personal-env";
import { sweepContext } from "./process-sweep";

type Reason = Parameters<ExecutionContexts["retire"]>[1];
const ATTEMPTS = 5;

/** The context's owner has stopped its driver, shell, operation or setup. Kill
 * whatever still carries the context, erase the person's files once nothing
 * does, then post the receipt; a lost receipt or a survivor is retried. The
 * control plane keeps the chat's handover barrier until a receipt with 0 lands. */
export async function retireContext(contexts: ExecutionContexts, contextId: string, reason: Reason,
  options: { personal?: PersonalEnvironments; sweep?: (contextId: string) => Promise<number>; signal?: AbortSignal } = {}): Promise<void> {
  const sweep = options.sweep ?? sweepContext;
  for (let attempt = 0; attempt < ATTEMPTS && !options.signal?.aborted; attempt++) {
    try {
      const processes = await sweep(contextId);
      if (processes === 0) await options.personal?.erase(contextId);
      await contexts.retire(contextId, reason, processes);
      if (processes === 0) return;
    } catch { /* retried below */ }
    await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
  }
}
