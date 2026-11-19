import React from "react";
import { SubscriptionConnectionPanel } from "./subscription-connection-panel";

export function CursorSubscription(props: {
  onChanged: () => Promise<unknown>;
  surfaceActive: boolean;
}) {
  return <SubscriptionConnectionPanel provider="cursor" {...props} />;
}
