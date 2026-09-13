import React from "react";
import { SubscriptionConnectionPanel } from "./subscription-connection-panel";

/** Compatibility entry point for the original Cursor settings surface. */
export function CursorSubscription(props: {
  onChanged: () => Promise<unknown>;
  surfaceActive: boolean;
}) {
  return <SubscriptionConnectionPanel provider="cursor" {...props} />;
}
