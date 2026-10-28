-- KuiSense 只保存最近一包手机 ContextPacket；原始手机历史仍由 Android 本地 Room 负责。
CREATE TABLE kuisense_latest_context (
 slot INTEGER PRIMARY KEY CHECK(slot = 1),
 schema_version INTEGER NOT NULL CHECK(schema_version = 1),
 received_at INTEGER NOT NULL,
 payload_json TEXT NOT NULL
);
