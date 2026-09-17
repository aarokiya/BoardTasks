-- BoardTasks schema v1. Stable local UUID primary keys; Google ids are secondary.

CREATE TABLE task_lists (
  id               TEXT PRIMARY KEY,
  remote_id        TEXT UNIQUE,
  title            TEXT NOT NULL,
  color            TEXT NOT NULL DEFAULT 'gray',
  position         INTEGER NOT NULL DEFAULT 0,
  is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  deleted          INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  etag             TEXT,
  updated_at       TEXT,
  local_updated_at TEXT NOT NULL,
  rev              INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_task_lists_order ON task_lists(deleted, position);

CREATE TABLE tasks (
  id               TEXT PRIMARY KEY,
  remote_id        TEXT UNIQUE,
  list_id          TEXT NOT NULL REFERENCES task_lists(id) ON DELETE CASCADE,
  title            TEXT NOT NULL DEFAULT '',
  notes            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'needsAction' CHECK (status IN ('needsAction','completed')),
  due              TEXT,                      -- civil 'YYYY-MM-DD'
  due_time         TEXT,                      -- 'HH:mm' LOCAL ONLY
  completed_at     TEXT,
  parent_id        TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  position         TEXT,                      -- server opaque position
  sort_key         TEXT NOT NULL,             -- local fractional index
  priority         INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  flagged          INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1)),
  hidden           INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0,1)),
  deleted          INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1)),
  remote_deleted   INTEGER NOT NULL DEFAULT 0 CHECK (remote_deleted IN (0,1)),
  web_view_link    TEXT,
  links_json       TEXT NOT NULL DEFAULT '[]',
  etag             TEXT,
  updated_at       TEXT,                      -- server 'updated'
  base_json        TEXT,                      -- last-known server state for 3-way merge
  dirty_fields     TEXT NOT NULL DEFAULT '[]',
  conflict_json    TEXT,
  created_at       TEXT NOT NULL,
  local_updated_at TEXT NOT NULL,
  rev              INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_tasks_list        ON tasks(list_id, deleted, status, sort_key);
CREATE INDEX idx_tasks_due         ON tasks(deleted, status, due) WHERE deleted = 0;
CREATE INDEX idx_tasks_parent      ON tasks(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_tasks_remote      ON tasks(remote_id);
CREATE INDEX idx_tasks_conflict    ON tasks(conflict_json) WHERE conflict_json IS NOT NULL;

CREATE VIRTUAL TABLE tasks_fts USING fts5(title, notes, content='tasks', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, notes) VALUES (new.rowid, new.title, new.notes);
END;
CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, notes) VALUES ('delete', old.rowid, old.title, old.notes);
END;
CREATE TRIGGER tasks_fts_au AFTER UPDATE OF title, notes ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, notes) VALUES ('delete', old.rowid, old.title, old.notes);
  INSERT INTO tasks_fts(rowid, title, notes) VALUES (new.rowid, new.title, new.notes);
END;

CREATE TABLE outbox (
  id              TEXT PRIMARY KEY,
  seq             INTEGER NOT NULL,           -- FIFO ordering
  op              TEXT NOT NULL,
  entity          TEXT NOT NULL CHECK (entity IN ('task','list')),
  entity_id       TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  base_etag       TEXT,
  base_updated_at TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','inflight','blocked','parked','done')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  blocked_passes  INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  last_error_code TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_outbox_ready  ON outbox(status, next_attempt_at, seq);
CREATE INDEX idx_outbox_entity ON outbox(entity_id, status, seq);

CREATE TABLE sync_state (
  scope              TEXT PRIMARY KEY,          -- 'global' | 'list:<localId>'
  watermark          TEXT,                      -- max server `updated` seen
  last_full_sync_at  TEXT,
  last_delta_sync_at TEXT,
  last_success_at    TEXT,
  last_error         TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  server_skew_ms     INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE github_links (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  url               TEXT NOT NULL,
  host              TEXT NOT NULL,
  owner             TEXT NOT NULL,
  repo              TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('issue','pull')),
  number            INTEGER NOT NULL,
  title             TEXT,
  state             TEXT,
  author            TEXT,
  author_avatar_url TEXT,
  labels_json       TEXT NOT NULL DEFAULT '[]',
  checks            TEXT,
  review_decision   TEXT,
  remote_updated_at TEXT,
  fetched_at        TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_github_links_stale ON github_links(fetched_at);

CREATE TABLE notifications_sent (
  task_id   TEXT NOT NULL,
  fire_at   TEXT NOT NULL,
  sent_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, fire_at)
);

CREATE TABLE trash (
  task_id     TEXT PRIMARY KEY,
  snapshot    TEXT NOT NULL,
  deleted_at  TEXT NOT NULL
);
