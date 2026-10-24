import { describe, expect, it } from "vitest";
import { CloudComputerRepositorySnapshots } from "../cloud-computer-repository-snapshots";
const account = "11111111-1111-4111-8111-111111111111";
const organization = "22222222-2222-4222-8222-222222222222";
const owner = JSON.stringify([account, organization]);
const repository = { id: "example/project", owner: "Example", name: "Project", defaultBranch: "trunk" };
function storage() {
  const rows = new Map<string, string>();
  return { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); } };
}
describe("Cloud Computer catalog recovery", () => {
  it("restores a confirmed repository list synchronously while marking it for background revalidation", () => {
    const disk = storage();
    new CloudComputerRepositorySnapshots(disk, "backend-a").set(owner, { data: [repository], updatedAt: Date.now() });
    const restored = new CloudComputerRepositorySnapshots(disk, "backend-a");
    expect(restored.get(owner)).toEqual({ data: [repository], updatedAt: 0 });
    expect(restored.get(JSON.stringify([organization, account]))).toBeUndefined();
    expect(new CloudComputerRepositorySnapshots(disk, "backend-b").get(owner)).toBeUndefined();
  });
  it("persists confirmed removal and no-build states instead of resurrecting the old repository", () => {
    const disk = storage(), cache = new CloudComputerRepositorySnapshots(disk, "backend");
    cache.set(owner, { data: [repository], updatedAt: Date.now() });
    for (const data of [[], null]) {
      cache.set(owner, { data, updatedAt: Date.now() });
      expect(new CloudComputerRepositorySnapshots(disk, "backend").get(owner)?.data).toEqual(data);
    }
  });
  it("refuses malformed cached repositories and foreign snapshot shapes", () => {
    const disk = storage(), cache = new CloudComputerRepositorySnapshots(disk, "backend");
    cache.set(owner, { data: [{ ...repository, id: "foreign/owner" }], updatedAt: Date.now() });
    expect(cache.get(owner)).toBeUndefined();
    cache.set("not-an-owner", { data: [repository], updatedAt: Date.now() });
    expect(cache.get("not-an-owner")).toBeUndefined();
  });
  it("keeps recent large catalogs recoverable instead of writing a snapshot too large to reload", () => {
    const disk = storage(), cache = new CloudComputerRepositorySnapshots(disk, "backend");
    const repositories = Array.from({ length: 200 }, (_, index) => {
      const name = `repo-${index}-${"r".repeat(90)}`;
      return { id: `example/${name}`, owner: "example", name, defaultBranch: "b".repeat(255) };
    });
    const owners = Array.from({ length: 16 }, (_, index) =>
      JSON.stringify([account, `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`]));
    for (const key of owners) cache.set(key, { data: repositories, updatedAt: Date.now() });
    const restored = new CloudComputerRepositorySnapshots(disk, "backend");
    expect(restored.get(owners.at(-1)!)?.data).toEqual(repositories);
    expect(restored.get(owners[0])).toBeUndefined();
  });
});
