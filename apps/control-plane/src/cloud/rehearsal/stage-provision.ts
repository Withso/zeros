// Stage provision: the fixture repositories the other stages need and Alpha does not have yet. Only
// Withso/zeros-dev-fixture-* names (guard.ts), each private with one initial commit; recorded so cleanup removes
// exactly what this run created unless --keep-fixtures.
import { type StageContext } from "./contract.js";
import { assertRepository } from "./guard.js";
import { check } from "./steps.js";

export const FIXTURE_TWO = "Withso/zeros-dev-fixture-two";

export async function stageProvision(ctx: StageContext): Promise<Record<string, number>> {
  const wanted = [ctx.repositories.two ?? FIXTURE_TWO];
  let created = 0, present = 0;
  for (const repository of wanted.map(assertRepository)) {
    ctx.step(`repository_${repository === FIXTURE_TWO ? "two" : "named"}`);
    if (await ctx.ports.github.repositoryExists(repository)) { present++; continue; }
    await ctx.ports.github.createRepository(repository);
    ctx.state.created.repositories.push(repository);
    await ctx.save();
    check(await ctx.ports.github.repositoryExists(repository), "repository_created", "not_visible");
    created++;
  }
  ctx.repositories.two ??= FIXTURE_TWO;
  return { created, present };
}
