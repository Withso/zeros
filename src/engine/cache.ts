// ──────────────────────────────────────────────────────────
// Engine Cache — Selector index, file cache, token index
// ──────────────────────────────────────────────────────────
//
// Builds and maintains three Map-based caches:
//   1. Selector index: CSS selector → source locations
//   2. File content cache: path → content + mtime
//   3. Token index: CSS custom property → value + location
//
// Built once on startup (~200ms for 50 files), updated
// incrementally per-file on change (<5ms).
//
// ──────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import postcss from "postcss";
import { findCSSFiles } from "./discovery";

export interface SourceLocation {
  file: string;       // absolute path
  relPath: string;    // relative to project root
  line: number;       // 1-based
  column: number;     // 0-based
  selector: string;   // the matched selector text
}

export interface FileEntry {
  content: string;
  mtime: number;
}

export interface TokenEntry {
  value: string;
  file: string;       // relative path
  line: number;
}

export class EngineCache {
  private selectorIndex = new Map<string, SourceLocation[]>();
  private fileCache = new Map<string, FileEntry>();
  private tokenIndex = new Map<string, TokenEntry>();
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Build the full index from scratch. Called once on startup.
   */
  async buildIndex(): Promise<void> {
    const cssFiles = await findCSSFiles(this.root);

    for (const absPath of cssFiles) {
      this.indexFile(absPath);
    }
  }

  /**
   * Re-index a single file. Called on file change.
   */
  updateFile(absPath: string): void {
    // Remove old entries for this file
    this.removeFileEntries(absPath);

    // Re-index if the file still exists
    if (fs.existsSync(absPath)) {
      this.indexFile(absPath);
    }
  }

  /**
   * Remove all entries for a deleted file.
   */
  removeFile(absPath: string): void {
    this.removeFileEntries(absPath);
    this.fileCache.delete(absPath);
  }

  /**
   * Look up a selector in the index.
   */
  resolveSelector(selector: string): SourceLocation[] | undefined {
    return this.selectorIndex.get(selector);
  }

  /**
   * Get cached file content. Returns null if not cached.
   */
  getFileContent(absPath: string): string | null {
    const entry = this.fileCache.get(absPath);
    if (!entry) return null;

    // Check if the file has been modified externally
    try {
      const stat = fs.statSync(absPath);
      if (stat.mtimeMs !== entry.mtime) {
        // File changed — re-read
        const content = fs.readFileSync(absPath, "utf-8");
        this.fileCache.set(absPath, { content, mtime: stat.mtimeMs });
        return content;
      }
    } catch {
      return null;
    }

    return entry.content;
  }

  /**
   * Read file content, using cache when possible.
   */
  readFile(absPath: string): string | null {
    const cached = this.getFileContent(absPath);
    if (cached !== null) return cached;

    try {
      const content = fs.readFileSync(absPath, "utf-8");
      const stat = fs.statSync(absPath);
      this.fileCache.set(absPath, { content, mtime: stat.mtimeMs });
      return content;
    } catch {
      return null;
    }
  }

  /**
   * Get all design tokens (CSS custom properties).
   */
  getTokens(): Map<string, TokenEntry> {
    return this.tokenIndex;
  }

  /**
   * Get all selectors in the index.
   */
  getAllSelectors(): Map<string, SourceLocation[]> {
    return this.selectorIndex;
  }

  /**
   * Cache statistics for debugging.
   */
  stats(): { selectors: number; files: number; tokens: number } {
    return {
      selectors: this.selectorIndex.size,
      files: this.fileCache.size,
      tokens: this.tokenIndex.size,
    };
  }

  // ── Private ────────────────────────────────────────────

  private indexFile(absPath: string): void {
    let content: string;
    try {
      content = fs.readFileSync(absPath, "utf-8");
    } catch {
      return;
    }

    const stat = fs.statSync(absPath);
    const relPath = path.relative(this.root, absPath);
    this.fileCache.set(absPath, { content, mtime: stat.mtimeMs });

    let root: postcss.Root;
    try {
      root = postcss.parse(content, { from: absPath });
    } catch {
      // Skip files that can't be parsed (e.g. CSS-in-JS artifacts)
      return;
    }

    // Index selectors
    root.walkRules((rule) => {
      const line = rule.source?.start?.line ?? 0;
      const column = rule.source?.start?.column ? rule.source.start.column - 1 : 0;
      const selector = rule.selector;

      // Store the full compound selector
      this.addSelectorEntry(selector, {
        file: absPath,
        relPath,
        line,
        column,
        selector,
      });

      // Also store individual selectors from a comma-separated list
      if (selector.includes(",")) {
        const parts = selector.split(",").map((s) => s.trim());
        for (const part of parts) {
          if (part && part !== selector) {
            this.addSelectorEntry(part, {
              file: absPath,
              relPath,
              line,
              column,
              selector: part,
            });
          }
        }
      }
    });

    // Index tokens (CSS custom properties)
    root.walkDecls((decl) => {
      if (decl.prop.startsWith("--")) {
        const line = decl.source?.start?.line ?? 0;
        this.tokenIndex.set(decl.prop, {
          value: decl.value,
          file: relPath,
          line,
        });
      }
    });
  }

  private addSelectorEntry(key: string, location: SourceLocation): void {
    const existing = this.selectorIndex.get(key);
    if (existing) {
      existing.push(location);
    } else {
      this.selectorIndex.set(key, [location]);
    }
  }

  private removeFileEntries(absPath: string): void {
    // Remove from selector index
    for (const [key, locations] of this.selectorIndex) {
      const filtered = locations.filter((loc) => loc.file !== absPath);
      if (filtered.length === 0) {
        this.selectorIndex.delete(key);
      } else {
        this.selectorIndex.set(key, filtered);
      }
    }

    // Remove from token index
    const relPath = path.relative(this.root, absPath);
    for (const [key, entry] of this.tokenIndex) {
      if (entry.file === relPath) {
        this.tokenIndex.delete(key);
      }
    }
  }
}
