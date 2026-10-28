-- 保留协议档案与独立长期记忆；删除标记只影响会话访问和后续调度。
ALTER TABLE conversations ADD COLUMN deleted_at INTEGER CHECK(deleted_at IS NULL OR deleted_at >= 0);
CREATE INDEX conversations_visible_page ON conversations(owner_id, deleted_at, created_at DESC, id DESC);
