import type { ProviderBinding } from "@zeros/protocol/identities";

interface ProviderIdentityChat {
  id: string;
  agentId?: string | null;
  providerBinding?: ProviderBinding | null;
}

export interface ProviderIdentityClearRequest {
  chatId: string;
  agentId: string;
  resumeId: string;
}

/** Convert only a known same-provider binding → no-binding transition into the
 * explicit DB compare-and-clear operation. Ordinary null snapshots stay
 * harmless because the engine's bulk upsert preserves its newer identity. */
export function providerIdentityClearForTransition(
  previous: ProviderIdentityChat | null | undefined,
  next: ProviderIdentityChat,
): ProviderIdentityClearRequest | null {
  const binding = previous?.providerBinding;
  if (
    !binding ||
    next.providerBinding ||
    !next.agentId ||
    next.agentId !== previous?.agentId ||
    binding.providerId !== next.agentId
  ) {
    return null;
  }
  return {
    chatId: next.id,
    agentId: next.agentId,
    resumeId: binding.resumeId,
  };
}
