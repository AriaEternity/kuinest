-- 待确认候选与有效记忆分离；旧角色、旧记忆和旧迁移均不改写。
CREATE TABLE memory_proposals (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 character_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('user','tool')),
 source_id TEXT NOT NULL,
 source_run_id TEXT REFERENCES runs(id),
 source_tool_call_id TEXT UNIQUE REFERENCES tool_calls(id),
 initial_sha256 TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 20),
 status TEXT NOT NULL CHECK(status IN ('pending','confirmed','rejected')),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 decided_at INTEGER,
 confirmed_memory_id TEXT UNIQUE REFERENCES memory_versions(id),
 FOREIGN KEY(character_id,owner_id) REFERENCES characters(id,owner_id),
 UNIQUE(owner_id,character_id,source_id),
 CHECK((status='pending' AND decided_at IS NULL AND confirmed_memory_id IS NULL) OR
       (status='rejected' AND decided_at IS NOT NULL AND confirmed_memory_id IS NULL) OR
       (status='confirmed' AND decided_at IS NOT NULL AND confirmed_memory_id IS NOT NULL))
);
CREATE TABLE memory_proposal_revisions (
 proposal_id TEXT NOT NULL REFERENCES memory_proposals(id),
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 20),
 content TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 actor_owner_id TEXT NOT NULL REFERENCES owners(id),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(proposal_id,revision)
);
CREATE INDEX ix_memory_proposals_queue ON memory_proposals(owner_id,character_id,created_at,id);
CREATE TRIGGER tr_memory_proposal_revision_immutable BEFORE UPDATE ON memory_proposal_revisions
BEGIN SELECT RAISE(ABORT,'memory_proposal_revision_immutable'); END;
CREATE TRIGGER tr_memory_proposal_decision_immutable BEFORE UPDATE ON memory_proposals
WHEN OLD.status <> 'pending'
BEGIN SELECT RAISE(ABORT,'memory_proposal_decision_immutable'); END;
