-- 稳定来源与原档版本独立于批次，追加文件不会改变历史条目身份。
CREATE TABLE import_sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  character_id TEXT NOT NULL UNIQUE REFERENCES characters(id),
  agent_id TEXT NOT NULL CHECK(agent_id='main'),
  revision INTEGER NOT NULL CHECK(revision > 0),
  manifest_sha256 TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  state_sha256 TEXT NOT NULL
);
CREATE TABLE import_objects (
  source_id TEXT NOT NULL REFERENCES import_sources(id),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(source_id,path,sha256)
);
CREATE TABLE import_record_map (
  source_id TEXT NOT NULL REFERENCES import_sources(id),
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  target_id TEXT NOT NULL UNIQUE REFERENCES context_entries(id),
  PRIMARY KEY(source_id,session_id,entry_id)
);
