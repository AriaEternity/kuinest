import { projectFreshConversation } from "./fresh-start.js";
import { readDeferredReplay } from "../../../apps/backend/dist/context/deferred-replay.js";
import { insertImage } from "../../../apps/backend/dist/storage/image-assets.js";
import { bindImages } from "../../../apps/backend/dist/storage/image-bindings.js";
import { contentImages, type ImageReference } from "../../../apps/backend/dist/images/content.js";
import { readMessage } from "../../../apps/backend/dist/providers/messages.js";
import { readInterrupted } from "./interrupted.js";
import type Database from "better-sqlite3";
import type { Analysis } from "./types.js";
import { chain } from "./parse.js";
import { check, hash, text, uid, object } from "./safe.js";
export function projectCharacter(db: Database.Database, a: Analysis, owner: string, character: string): void {
  const m = a.bundle.manifest, now = m.capturedAt;
  const provider = uid(m.sourceId, "profile", hash(JSON.stringify(m.profile)));
  db.prepare("INSERT OR IGNORE INTO provider_profiles VALUES (?,?,?,?,?,?,?,?)").run(provider, owner, m.profile.provider, m.profile.model, m.profile.endpoint, JSON.stringify(m.profile.options), m.profile.status, now);
  const docs = m.files.filter(f => f.kind === "document" || f.kind === "addition");
  const version = uid(m.sourceId, "character-version", hash(JSON.stringify([provider, m.config, docs.map(d => [d.path,d.sha256])])));
  db.prepare("INSERT OR IGNORE INTO character_versions VALUES (?,?,?,?,?)").run(version, character, provider, JSON.stringify(m.config), now);
  for (const f of docs) db.prepare("INSERT OR IGNORE INTO character_documents VALUES (?,?,?,?)").run(version, f.path.slice(10), a.bundle.files.get(f.path)!, f.sha256);
  // 所有版本保持非激活；验收和后续装配不得由导入器代签。
  for (const f of m.files.filter(f => f.kind === "memory" || f.path === "workspace/MEMORY.md")) {
    const key = f.path.slice(10), content = text(a.bundle.files.get(f.path)!);
    const old = db.prepare("SELECT v.id,v.version,v.content FROM memory_heads h JOIN memory_versions v ON v.id=h.version_id WHERE h.character_id=? AND h.logical_key=?").get(character,key) as {id:string;version:number;content:string} | undefined;
    if (old?.content === content) continue;
    const last = old ?? (m.migrationMode === "fresh-start-v1" ? db.prepare("SELECT version FROM memory_versions WHERE character_id=? AND logical_key=? ORDER BY version DESC LIMIT 1").get(character,key) as {version:number} | undefined : undefined);
    const nextVersion = (last?.version ?? 0)+1;
    const memory = uid(m.sourceId, "memory", key, String(nextVersion));
    db.prepare("INSERT INTO memory_versions VALUES (?,?,?,?,?,?,?,?,?)").run(memory,character,key,nextVersion,old?.id ?? null,content,JSON.stringify({ kind:m.reviewedAdditions?.files.some(item => item.path === f.path) ? "confirmed-review-addition" : "openclaw-import", batchId:m.batchId, sourceSha256:f.sha256, ...(m.reviewedAdditions?.files.some(item => item.path === f.path) ? { reviewSha256:m.reviewedAdditions.reviewSha256 } : {}) }),null,now);
    db.prepare("INSERT INTO memory_heads VALUES (?,?,?) ON CONFLICT(character_id,logical_key) DO UPDATE SET version_id=excluded.version_id").run(character,key,memory);
  }
  if (m.migrationMode === "fresh-start-v1") for (const path of m.removedMemories ?? [])
    db.prepare("DELETE FROM memory_heads WHERE character_id=? AND logical_key=?").run(character,path.slice(10));
}
export function projectConversations(db: Database.Database, a: Analysis, owner: string, character: string): void {
  const m = a.bundle.manifest, now = m.capturedAt;
  if (m.migrationMode === "fresh-start-v1") { projectFreshConversation(db,m,owner,character); return; }
  for (const c of m.conversations) {
    const conversation = uid(m.sourceId, c.key), active = c.history.at(-1)!;
    db.prepare("INSERT OR IGNORE INTO conversations(id,owner_id,character_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(conversation,owner,character,"导入会话",now,now);
    const visible: {id:string;role:string;content:string;images:ImageReference[];status:"complete"|"partial";at:number}[] = [];
    for (const selection of c.history) {
      const mapped = a.sessions.get(selection.sessionId)!;
      for (const image of mapped.images) insertImage(db, { id:image.reference.id, ownerId:owner, conversationId:conversation, content:image.content, inspection:image.inspection, createdAt:image.createdAt }, image.origin, image.sourceUid);
      const branch = uid(m.sourceId,m.agentId,selection.sessionId,"branch");
      db.prepare("INSERT OR IGNORE INTO branches(id,conversation_id,reason,created_at) VALUES (?,?,?,?)").run(branch,conversation,"openclaw-import",now);
      // 全树保留，先父后子，不依赖原文件恰好按拓扑排序。
      const pending = new Map(mapped.entries.map(e => [e.id,e]));
      const rawByTarget = new Map(mapped.session.entries.map(e => [uid(m.sourceId,m.agentId,selection.sessionId,e.id),e]));
      while (pending.size) {
        let added = 0;
        for (const [target,e] of pending) {
          if (e.parentId && pending.has(e.parentId)) continue;
          const raw = rawByTarget.get(target)!, rawHash = mapped.session.rawHashes.get(raw.id)!;
          const prior = db.prepare("SELECT raw_sha256,target_id FROM import_record_map WHERE source_id=? AND session_id=? AND entry_id=?").get(m.sourceId,selection.sessionId,raw.id) as {raw_sha256:string;target_id:string} | undefined;
          if (prior) check(prior.raw_sha256 === rawHash && prior.target_id === target, "ENTRY_CONFLICT");
          else {
            db.prepare("INSERT INTO context_entries VALUES (?,?,?,?,?,?,?,?,?)").run(target,conversation,branch,e.parentId,e.kind,JSON.stringify(e.payload),target,m.batchId,Date.parse(raw.timestamp));
            db.prepare("INSERT INTO import_record_map VALUES (?,?,?,?,?)").run(m.sourceId,selection.sessionId,raw.id,rawHash,target);
          }
          pending.delete(target); added++;
        }
        check(added, "PARENT_CYCLE");
      }
      db.prepare("UPDATE branches SET head_entry_id=? WHERE id=?").run(selection.leafId ? uid(m.sourceId,m.agentId,selection.sessionId,selection.leafId) : null,branch);
      const map = new Map(mapped.entries.map(e => [e.id,e]));
      for (const raw of chain(mapped.session, selection.leafId)) {
        const target = uid(m.sourceId,m.agentId,selection.sessionId,raw.id), e = map.get(target)!;
        const partial = readInterrupted(e), payload = partial ?? readDeferredReplay(e) ?? (e.kind === "message" ? e.payload : undefined);
        if (object(payload) && ["user","assistant"].includes(String(payload.role))) {
          const message = readMessage(payload);
          if (message.role === "tool") continue;
          // 公开文字沿用旧导入器的无额外分隔拼接；后台保留每个原始文字/图片块的位置。
          const content = typeof message.content === "string" ? message.content : message.content?.filter(part => part.type === "text").map(part => part.text).join("") ?? "";
          const images = message.role === "user" ? contentImages(message.content) : [];
          if (content.length || images.length) visible.push({id:uid(target,"public"),role:message.role,content,images,status:partial ? "partial" : "complete",at:Date.parse(raw.timestamp)});
        }
      }
    }
    const previous = db.prepare("SELECT change_revision FROM conversations WHERE id=?").get(conversation) as {change_revision:number};
    const revision = previous.change_revision + 1;
    const oldRows = db.prepare("SELECT id,seq FROM messages WHERE conversation_id=? ORDER BY seq").all(conversation) as {id:string;seq:number}[];
    const oldIds = new Set(oldRows.map(row => row.id));
    const offset = Math.max(0,...oldRows.map(r=>r.seq))+visible.length+1;
    db.prepare("UPDATE messages SET seq=seq+?,visibility='suppressed',updated_revision=? WHERE conversation_id=?").run(offset,revision,conversation);
    let seq = 0; const selected = new Set(visible.map(v=>v.id));
    for (const v of visible) {
      db.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,'visible',?,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,status=excluded.status,visibility='visible',updated_revision=excluded.updated_revision").run(v.id,conversation,++seq,v.role,v.content,v.status,revision,v.at);
      const previousImages = db.prepare("SELECT image_id AS id,position FROM message_images WHERE message_id=? ORDER BY position").all(v.id) as {id:string;position:number}[];
      if (oldIds.has(v.id)) check(previousImages.length === v.images.length && previousImages.every((image,index) => image.position === index && image.id === v.images[index]!.id), "IMAGE_BINDING_CONFLICT");
      else bindImages(db,v.id,conversation,v.images);
    }
    for (const old of oldRows.filter(r=>!selected.has(r.id))) db.prepare("UPDATE messages SET seq=? WHERE id=?").run(++seq,old.id);
    db.prepare("UPDATE conversations SET updated_at=?,next_public_seq=?,change_revision=?,active_branch_id=?,last_context_user_at=? WHERE id=?")
      .run(now,seq+1,revision,uid(m.sourceId,m.agentId,active.sessionId,"branch"),visible.filter(v=>v.role==="user").at(-1)?.at ?? null,conversation);
  }
}
