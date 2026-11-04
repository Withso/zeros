export const CODE_REVIEW_SCHEMA = `
      -- No workspaces FK: local-main and opened repository roots are semantic
      -- owners without a workspaces row. Legacy diff_comments remain intact.
      CREATE TABLE code_review_threads (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        anchor_json TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
        resolved_by TEXT,
        resolved_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((resolved = 0 AND resolved_by IS NULL AND resolved_at IS NULL)
          OR (resolved = 1 AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
      );
      CREATE INDEX idx_code_review_workspace_path ON code_review_threads(workspace_id, file_path, created_at);
      CREATE INDEX idx_code_review_workspace_created ON code_review_threads(workspace_id, created_at, id);
      CREATE TABLE code_review_comments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES code_review_threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK (seq > 0),
        author_json TEXT NOT NULL,
        body TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 20000),
        created_at INTEGER NOT NULL,
        UNIQUE(thread_id, seq)
      );
      CREATE TABLE code_review_requests (
        workspace_id TEXT NOT NULL,
        actor_key TEXT NOT NULL,
        request_id TEXT NOT NULL,
        signature TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES code_review_threads(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, actor_key, request_id)
      );
      CREATE TRIGGER code_review_anchor_immutable BEFORE UPDATE OF id, workspace_id, file_path, anchor_json, created_at ON code_review_threads
        BEGIN SELECT RAISE(ABORT, 'Review anchors are immutable'); END;
      CREATE TRIGGER code_review_comment_immutable BEFORE UPDATE ON code_review_comments
        BEGIN SELECT RAISE(ABORT, 'Review comments are immutable'); END;
    `;
