const { sheet } = await import(`/Users/arunrajkumar/.zeros-dev/qa/lib/helpers.mjs?${Date.now()}`);
import fs from "node:fs/promises";
export default async (ctx) => {
  const all = (await fs.readdir(ctx.outbox)).sort();
  const commit = all.filter((f) => f.startsWith("002-e-commit-"));
  const typing = all.filter((f) => f.startsWith("002-c-typing-"));
  // The zoomed card sits at the canvas's left; crop to it.
  const clip = { x: 641, y: 80, width: 520, height: 600 };
  return { commit: await sheet(ctx, "003-commit-sheet", commit, { clip, columns: 6, width: 230 }),
    typing: await sheet(ctx, "003-typing-sheet", typing, { clip, columns: 6, width: 230 }) };
};
