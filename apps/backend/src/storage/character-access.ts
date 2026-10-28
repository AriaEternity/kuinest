import type Database from "better-sqlite3";
import type { Document, Profile } from "../context/types.js";
import { config, profile, documents } from "../context/profile.js";
import { ensure } from "../application/errors.js";
import { activeVersion } from "./context-records.js";
export type PublishVersion = { characterId: string; versionId: string; profile: Profile; config: unknown; documents: Document[] };
export function characterAccess(db: Database.Database, write: <T>(fn: () => T) => T) {
  return Object.freeze({
    publish(owner: string, input: PublishVersion, now: number) {
      return write(() => {
        ensure(db.prepare("SELECT 1 FROM characters WHERE id=? AND owner_id=?").get(input.characterId, owner), "NOT_FOUND");
        const p = profile(input.profile), c = config(input.config, p.status === "synthetic"); documents(input.documents, c);
        const previous = db.prepare("SELECT owner_id AS owner,provider,model,endpoint,options_json AS options,compatibility_status AS status FROM provider_profiles WHERE id=?").get(p.id) as { owner: string; provider: string; model: string; endpoint: string | null; options: string; status: string } | undefined;
        if (previous) ensure(previous.owner === owner && previous.provider === p.provider && previous.model === p.model && previous.endpoint === p.endpoint && previous.options === JSON.stringify(p.options) && previous.status === p.status, "INPUT_INVALID");
        else db.prepare("INSERT INTO provider_profiles(id,owner_id,provider,model,endpoint,options_json,compatibility_status,created_at) VALUES(?,?,?,?,?,?,?,?)").run(p.id, owner, p.provider, p.model, p.endpoint, JSON.stringify(p.options), p.status, now);
        db.prepare("INSERT INTO character_versions(id,character_id,provider_profile_id,config_json,created_at) VALUES(?,?,?,?,?)").run(input.versionId, input.characterId, p.id, JSON.stringify(c), now);
        for (const d of input.documents) db.prepare("INSERT INTO character_documents(version_id,logical_name,content,sha256) VALUES(?,?,?,?)").run(input.versionId, d.name, Buffer.from(d.bytes), d.sha256);
        return input.versionId;
      });
    },
    activate(owner: string, character: string, version: string, acceptUnverified = false) {
      write(() => {
        const row = db.prepare("SELECT v.config_json AS config,p.id,p.provider,p.model,p.endpoint,p.options_json AS options,p.compatibility_status AS status FROM character_versions v JOIN characters c ON c.id=v.character_id JOIN provider_profiles p ON p.id=v.provider_profile_id WHERE v.id=? AND c.id=? AND c.owner_id=? AND p.owner_id=?").get(version, character, owner, owner) as { config: string; id: string; provider: Profile["provider"]; model: string; endpoint: string | null; options: string; status: string } | undefined;
        ensure(row, "NOT_FOUND"); const p = profile({ ...row, options: JSON.parse(row.options) });
        ensure(p.status === "synthetic" || acceptUnverified && p.status === "unverified", "INPUT_INVALID");
        config(JSON.parse(row.config), p.status === "synthetic");
        db.prepare("UPDATE characters SET active_version_id=? WHERE id=? AND owner_id=?").run(version, character, owner);
        activeVersion(db, owner, character);
      });
    },
  });
}
