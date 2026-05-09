CREATE TABLE IF NOT EXISTS db_meta (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history_records (
  id TEXT PRIMARY KEY,
  list_order INTEGER NOT NULL,
  timestamp INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  char_count INTEGER NOT NULL DEFAULT 0,
  duration_sec REAL NOT NULL DEFAULT 0,
  is_empty INTEGER NOT NULL DEFAULT 0,
  app_id TEXT,
  app_name TEXT,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_records_order ON history_records(list_order);
CREATE INDEX IF NOT EXISTS idx_history_records_timestamp ON history_records(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_history_records_favorite ON history_records(favorite, list_order);

CREATE TABLE IF NOT EXISTS manual_corrections (
  id TEXT PRIMARY KEY,
  list_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  history_id TEXT,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_corrections_order ON manual_corrections(list_order);

CREATE TABLE IF NOT EXISTS feedback_queue (
  id TEXT PRIMARY KEY,
  list_order INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  history_id TEXT,
  status TEXT,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_queue_order ON feedback_queue(list_order);

CREATE TABLE IF NOT EXISTS prompt_presets (
  id TEXT PRIMARY KEY,
  list_order INTEGER NOT NULL,
  name TEXT,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompt_presets_order ON prompt_presets(list_order);

CREATE TABLE IF NOT EXISTS app_prompt_rules (
  id TEXT PRIMARY KEY,
  list_order INTEGER NOT NULL,
  app_id TEXT,
  name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_prompt_rules_order ON app_prompt_rules(list_order);
