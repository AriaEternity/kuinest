-- 葵栖初始迁移：事务和迁移历史表由迁移器管理。

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX ix_auth_sessions_owner ON auth_sessions(owner_id);
CREATE TABLE auth_throttles (
  bucket_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures >= 0),
  window_started_at INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  provider TEXT NOT NULL CHECK(provider IN ('mock','deepseek')),
  model TEXT NOT NULL,
  endpoint TEXT,
  options_json TEXT NOT NULL CHECK(json_valid(options_json)),
  compatibility_status TEXT NOT NULL CHECK(compatibility_status IN ('synthetic','unverified','verified','accepted_difference')),
  created_at INTEGER NOT NULL
);
CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  active_version_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(id, owner_id),
  FOREIGN KEY(active_version_id, id) REFERENCES character_versions(id, character_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE character_versions (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id),
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
  config_json TEXT NOT NULL CHECK(json_valid(config_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(id, character_id)
);
CREATE TABLE character_documents (
  version_id TEXT NOT NULL REFERENCES character_versions(id),
  logical_name TEXT NOT NULL,
  content BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY(version_id, logical_name)
);
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_context_user_at INTEGER,
  next_public_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_public_seq > 0),
  change_revision INTEGER NOT NULL DEFAULT 0 CHECK(change_revision >= 0),
  active_branch_id TEXT,
  UNIQUE(id, owner_id),
  FOREIGN KEY(character_id, owner_id) REFERENCES characters(id, owner_id),
  FOREIGN KEY(active_branch_id, id) REFERENCES branches(id, conversation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE branches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  parent_branch_id TEXT,
  head_entry_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(id, conversation_id),
  FOREIGN KEY(parent_branch_id, conversation_id) REFERENCES branches(id, conversation_id),
  FOREIGN KEY(head_entry_id, conversation_id) REFERENCES context_entries(id, conversation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  manifest_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('staged','validated','applied','rejected')),
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  created_at INTEGER NOT NULL
);
CREATE TABLE context_entries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  branch_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('message','compaction','branch_summary','custom_message','custom','unknown')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  source_uid TEXT,
  import_batch_id TEXT REFERENCES import_batches(id),
  created_at INTEGER NOT NULL,
  UNIQUE(id, conversation_id),
  UNIQUE(import_batch_id, source_uid),
  FOREIGN KEY(branch_id, conversation_id) REFERENCES branches(id, conversation_id),
  FOREIGN KEY(parent_id, conversation_id) REFERENCES context_entries(id, conversation_id)
);
CREATE INDEX ix_context_parent ON context_entries(conversation_id, parent_id);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL CHECK(seq > 0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('complete','partial')),
  visibility TEXT NOT NULL DEFAULT 'visible' CHECK(visibility IN ('visible','suppressed')),
  updated_revision INTEGER NOT NULL CHECK(updated_revision > 0),
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, seq),
  UNIQUE(id, conversation_id)
);
CREATE INDEX ix_messages_changes ON messages(conversation_id, updated_revision);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  origin TEXT NOT NULL CHECK(origin IN ('user','heartbeat')),
  request_key TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  user_message_id TEXT,
  reply_message_id TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  status TEXT NOT NULL CHECK(status IN ('accepted','running','completed','failed','cancelled')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  cancel_requested_at INTEGER,
  claim_owner TEXT,
  fence INTEGER,
  last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_event_seq >= 0),
  event_floor_seq INTEGER NOT NULL DEFAULT 1 CHECK(event_floor_seq > 0),
  context_head_at_start TEXT,
  context_user_entry_id TEXT,
  error_code TEXT,
  UNIQUE(conversation_id, request_key),
  FOREIGN KEY(user_message_id, conversation_id) REFERENCES messages(id, conversation_id),
  FOREIGN KEY(reply_message_id, conversation_id) REFERENCES messages(id, conversation_id),
  FOREIGN KEY(context_head_at_start, conversation_id) REFERENCES context_entries(id, conversation_id),
  FOREIGN KEY(context_user_entry_id, conversation_id) REFERENCES context_entries(id, conversation_id),
  CHECK((origin='user' AND user_message_id IS NOT NULL) OR (origin='heartbeat' AND user_message_id IS NULL)),
  CHECK(status <> 'running' OR origin <> 'user' OR context_user_entry_id IS NOT NULL),
  CHECK((status IN ('accepted','running') AND finished_at IS NULL) OR (status IN ('completed','failed','cancelled') AND finished_at IS NOT NULL))
);
-- 首版全局仅一个运行中的生成任务；扩并发前须另行迁移此约束。
CREATE UNIQUE INDEX uq_one_running ON runs((1)) WHERE status='running';
CREATE INDEX ix_runs_queue ON runs(status, created_at, id);
-- 首版没有重新生成，一条用户消息只属于一个运行。
CREATE UNIQUE INDEX uq_runs_user_message ON runs(user_message_id) WHERE user_message_id IS NOT NULL;
CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL CHECK(seq > 0),
  type TEXT NOT NULL CHECK(type IN ('run.accepted','run.started','reply.delta','run.completed','run.failed','run.cancelled')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, seq)
);
CREATE UNIQUE INDEX uq_run_terminal_event ON run_events(run_id) WHERE type IN ('run.completed','run.failed','run.cancelled');
CREATE TRIGGER tr_run_terminal_immutable BEFORE UPDATE OF status ON runs
WHEN OLD.status IN ('completed','failed','cancelled') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'terminal_run_immutable'); END;
CREATE TABLE context_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
  character_version_id TEXT NOT NULL REFERENCES character_versions(id),
  provider_profile_id TEXT NOT NULL REFERENCES provider_profiles(id),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  created_at INTEGER NOT NULL
);
CREATE TABLE provider_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  purpose TEXT NOT NULL DEFAULT 'reply' CHECK(purpose IN ('reply','compaction')),
  request_manifest_json TEXT NOT NULL CHECK(json_valid(request_manifest_json)),
  status TEXT NOT NULL CHECK(status IN ('started','completed','failed','unknown')),
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  finish_reason TEXT,
  usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(run_id, ordinal)
);
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  provider_call_id TEXT NOT NULL REFERENCES provider_calls(id),
  provider_tool_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','unknown')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE(provider_call_id, provider_tool_id)
);
CREATE TABLE memory_versions (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id),
  logical_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  parent_id TEXT REFERENCES memory_versions(id),
  content TEXT NOT NULL,
  provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
  source_tool_call_id TEXT UNIQUE REFERENCES tool_calls(id),
  created_at INTEGER NOT NULL,
  UNIQUE(character_id, logical_key, version),
  UNIQUE(id, character_id, logical_key)
);
CREATE TABLE memory_heads (
  character_id TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  version_id TEXT NOT NULL,
  PRIMARY KEY(character_id, logical_key),
  FOREIGN KEY(version_id, character_id, logical_key) REFERENCES memory_versions(id, character_id, logical_key)
);
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  interval_seconds INTEGER NOT NULL CHECK(interval_seconds >= 60),
  timezone TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
  next_due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE task_occurrences (
  task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
  due_at INTEGER NOT NULL,
  range_start_at INTEGER CHECK(range_start_at IS NULL OR range_start_at <= due_at),
  status TEXT NOT NULL CHECK(status IN ('enqueued','skipped_busy','skipped_catchup')),
  run_id TEXT UNIQUE REFERENCES runs(id),
  PRIMARY KEY(task_id, due_at),
  CHECK((status='enqueued' AND run_id IS NOT NULL) OR (status<>'enqueued' AND run_id IS NULL))
);
CREATE TABLE runtime_leases (
  name TEXT PRIMARY KEY,
  owner_instance TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK(fence > 0),
  expires_at INTEGER NOT NULL
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  owner_id TEXT REFERENCES owners(id),
  reference_id TEXT,
  safe_code TEXT,
  created_at INTEGER NOT NULL
);
