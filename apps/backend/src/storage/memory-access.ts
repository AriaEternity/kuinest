import { readableKeys } from "../memory/readable.js";
import type { Claim } from "../conversations/types.js";
import type Database from "better-sqlite3";
import { writeMemory, type MemoryWrite } from "../memory/write.js";
import { read } from "../memory/read.js";
import { search } from "../memory/search.js";
import { config } from "../context/profile.js";
import { activeVersion, memoryRows, snapshot } from "./context-records.js";
export function memoryAccess(db: Database.Database, write: <T>(fn: () => T) => T, guard: () => void) {
  const view = <T>(fn: () => T): T => { guard(); return db.transaction(() => { guard(); return fn(); })(); };
  return Object.freeze({
    toolMemories(claim: Claim) { return view(() => { const s = snapshot(db, claim); return memoryRows(db, String(s.manifest.characterId)); }); },
    write(owner: string, input: MemoryWrite, id: string, now: number) { return write(() => writeMemory(db, owner, input, id, now)); },
    read(owner: string, character: string, key: string) {
      return view(() => { const v = activeVersion(db, owner, character), c = config(JSON.parse(v.config), v.status === "synthetic"); const rows=memoryRows(db, character); return readableKeys(c,rows).includes(key) ? read(rows, key) : undefined; });
    },
    search(owner: string, character: string, query: string) {
      return view(() => { const v = activeVersion(db, owner, character), c = config(JSON.parse(v.config), v.status === "synthetic"); const rows=memoryRows(db,character); return search(rows, query, readableKeys(c,rows)); });
    },
  });
}
