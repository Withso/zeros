import { useState } from "react";
import { TurnUsageCard } from "../features/agent/turn-usage-card";
import { Button } from "../shared/ui/primitives/button";

export function TurnUsageFixture() {
  const [active, setActive] = useState(true);
  const [cost, setCost] = useState(5.34);
  return (
    <section
      id="turn-usage-fixture"
      className="mx-auto flex max-w-3xl flex-wrap items-center gap-4 py-4 text-xs"
    >
      <div data-usage-provider="claude">
        <TurnUsageCard
          agentId="claude"
          enabled={active}
          startedAt={1_789_480_000_000}
          endedAt={1_789_480_123_000}
          durationMs={123_000}
          usage={{
            accountingVersion: 1,
            costKind: "estimated",
            inputTokens: 214405,
            outputTokens: 657,
            cacheReadTokens: 213376,
            totalCostUsd: cost,
          }}
        />
      </div>
      <div data-usage-provider="codex">
        <TurnUsageCard
          agentId="codex"
          startedAt={1_789_480_000_000}
          endedAt={1_789_480_123_000}
          durationMs={123_000}
          usage={{
            accountingVersion: 1,
            inputTokens: 415,
            outputTokens: 30,
            cacheReadTokens: 200,
          }}
        />
      </div>
      <div data-usage-provider="cursor">
        <TurnUsageCard
          agentId="cursor"
          startedAt={1_789_480_000_000}
          endedAt={1_789_480_123_000}
          durationMs={123_000}
          usage={{
            accountingVersion: 1,
            costKind: "reported",
            totalCostUsd: 0,
          }}
        />
      </div>
      <Button onClick={() => setActive(!active)}>Toggle usage owner</Button>
      <Button onClick={() => setCost(5.39)}>Settle late usage</Button>
    </section>
  );
}
