-- 图片原件与公开用户附件分别关联；不改写前两份已执行迁移。
CREATE TABLE image_assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('upload','import-user','import-tool')),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg')),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 10485760),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 16384),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 16384),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  decoder TEXT NOT NULL CHECK(decoder='sharp-0.35.4'),
  content BLOB NOT NULL CHECK(typeof(content)='blob' AND length(content)=byte_length),
  source_uid TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(id,conversation_id),
  UNIQUE(source_uid),
  CHECK(width*height <= 64000000),
  CHECK((origin='upload' AND source_uid IS NULL) OR (origin<>'upload' AND source_uid IS NOT NULL)),
  FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX ix_image_assets_owner ON image_assets(owner_id);
CREATE TABLE message_images (
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),
  PRIMARY KEY(message_id,position),
  UNIQUE(message_id,image_id),
  FOREIGN KEY(message_id,conversation_id) REFERENCES messages(id,conversation_id),
  FOREIGN KEY(image_id,conversation_id) REFERENCES image_assets(id,conversation_id)
);
CREATE TRIGGER image_assets_immutable BEFORE UPDATE ON image_assets BEGIN
  SELECT RAISE(ABORT,'IMAGE_IMMUTABLE'); END;
CREATE TRIGGER message_images_public_user BEFORE INSERT ON message_images BEGIN
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM messages m JOIN image_assets a ON a.id=NEW.image_id AND a.conversation_id=m.conversation_id
    WHERE m.id=NEW.message_id AND m.conversation_id=NEW.conversation_id
      AND m.role='user' AND m.visibility='visible' AND a.origin IN ('upload','import-user')
  ) THEN RAISE(ABORT,'IMAGE_BINDING_INVALID') END; END;
CREATE TRIGGER message_images_immutable BEFORE UPDATE ON message_images BEGIN
  SELECT RAISE(ABORT,'IMAGE_BINDING_IMMUTABLE'); END;
