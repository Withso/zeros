import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTOMATIC_REPOSITORY_ICON_PATHS,
  detectAutomaticRepositoryIcon,
  getRepositoryIconChoice,
  setRepositoryIconChoice,
} from "../repository-icons";

class MemStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
  get length(): number {
    return this.values.size;
  }
}

describe("repository icons", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: Storage }).localStorage =
      new MemStorage() as unknown as Storage;
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("keeps the documented repository-file priority", () => {
    expect(AUTOMATIC_REPOSITORY_ICON_PATHS).toEqual([
      "public/apple-touch-icon.png",
      "apple-touch-icon.png",
      "public/favicon.svg",
      "favicon.svg",
      "public/favicon.png",
      "public/icon.png",
      "public/logo.png",
      "favicon.png",
      "app/icon.png",
      "src/app/icon.png",
      "public/favicon.ico",
      "favicon.ico",
      "app/favicon.ico",
      "static/favicon.ico",
      "src-tauri/icons/icon.png",
      "assets/icon.png",
      "src/assets/icon.png",
    ]);
  });

  it("uses the documented automatic lookup order and stops at the first image", async () => {
    const target = "public/favicon.png";
    const reader = vi.fn(async (_root: string, path: string) =>
      path === target
        ? { kind: "image", dataUrl: "data:image/png;base64,ICON" }
        : { kind: "error" },
    );

    await expect(
      detectAutomaticRepositoryIcon("/repo", reader),
    ).resolves.toEqual({
      imageUrl: "data:image/png;base64,ICON",
      source: { kind: "repository-file", path: target },
    });
    expect(reader.mock.calls.map((call) => call[1])).toEqual(
      AUTOMATIC_REPOSITORY_ICON_PATHS.slice(
        0,
        AUTOMATIC_REPOSITORY_ICON_PATHS.indexOf(target) + 1,
      ),
    );
  });

  it("falls back cleanly when no candidate is a readable image", async () => {
    const reader = vi.fn(async () => ({ kind: "text" }));
    const avatarReader = vi.fn(async () => null);
    await expect(
      detectAutomaticRepositoryIcon("/repo", reader, avatarReader),
    ).resolves.toEqual({ imageUrl: null, source: null });
    expect(reader).toHaveBeenCalledTimes(
      AUTOMATIC_REPOSITORY_ICON_PATHS.length,
    );
    expect(avatarReader).toHaveBeenCalledOnce();
    expect(avatarReader).toHaveBeenCalledWith("/repo");
  });

  it("continues past thrown, non-image, and empty-image candidates", async () => {
    const target = "public/favicon.svg";
    const reader = vi.fn(async (_root: string, path: string) => {
      if (path === "public/apple-touch-icon.png") {
        throw new Error("unreadable");
      }
      if (path === "apple-touch-icon.png") return { kind: "text" };
      if (path === target) {
        return { kind: "image", dataUrl: "data:image/svg+xml;base64,ICON" };
      }
      return { kind: "image" };
    });

    await expect(
      detectAutomaticRepositoryIcon("/repo", reader),
    ).resolves.toEqual({
      imageUrl: "data:image/svg+xml;base64,ICON",
      source: { kind: "repository-file", path: target },
    });
    expect(reader.mock.calls.map((call) => call[1])).toEqual([
      "public/apple-touch-icon.png",
      "apple-touch-icon.png",
      target,
    ]);
  });

  it("uses the GitHub repository owner avatar only after every file misses", async () => {
    const reader = vi.fn(async () => ({ kind: "error" }));
    const avatarReader = vi.fn(async () => ({
      login: "acme",
      type: "org" as const,
      avatarUrl: "https://avatars.githubusercontent.com/u/123?v=4",
    }));

    await expect(
      detectAutomaticRepositoryIcon("/repo", reader, avatarReader),
    ).resolves.toEqual({
      imageUrl: "https://avatars.githubusercontent.com/u/123?v=4",
      source: {
        kind: "github-avatar",
        login: "acme",
        ownerType: "org",
      },
    });
    expect(reader).toHaveBeenCalledTimes(
      AUTOMATIC_REPOSITORY_ICON_PATHS.length,
    );
    expect(avatarReader).toHaveBeenCalledOnce();
  });

  it("does not query GitHub when a repository file wins", async () => {
    const reader = vi.fn(async () => ({
      kind: "image",
      dataUrl: "data:image/png;base64,LOCAL",
    }));
    const avatarReader = vi.fn(async () => ({
      login: "unused",
      type: "user" as const,
      avatarUrl: "https://avatars.githubusercontent.com/u/1",
    }));

    await detectAutomaticRepositoryIcon("/repo", reader, avatarReader);
    expect(reader).toHaveBeenCalledOnce();
    expect(avatarReader).not.toHaveBeenCalled();
  });

  it("degrades to the initial when the GitHub fallback throws", async () => {
    const reader = vi.fn(async () => null);
    const avatarReader = vi.fn(async () => {
      throw new Error("offline");
    });

    await expect(
      detectAutomaticRepositoryIcon("/repo", reader, avatarReader),
    ).resolves.toEqual({ imageUrl: null, source: null });
  });

  it("persists and clears a repository-local override", () => {
    setRepositoryIconChoice("/repo/", { kind: "emoji", value: "🚀" });
    expect(getRepositoryIconChoice("/repo")).toEqual({
      kind: "emoji",
      value: "🚀",
    });

    setRepositoryIconChoice("/repo", null);
    expect(getRepositoryIconChoice("/repo")).toBeNull();
  });
});
