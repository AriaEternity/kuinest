import { readDeferredReplay } from "../../../apps/backend/dist/context/deferred-replay.js";
import { imagePreparer } from "./images.js";
import { readInterrupted } from "./interrupted.js";
import { resolve as resolveContext } from "../../../apps/backend/dist/context/branches.js";
import { validateHistory } from "../../../apps/backend/dist/providers/messages.js";
import { config, documents } from "../../../apps/backend/dist/context/profile.js";
import type { Analysis, Bundle, Mapped } from "./types.js";
import { check, hash, json, object, text, uid } from "./safe.js";
import { parse, chain } from "./parse.js";
import { mapSession } from "./map.js";
export function analyze(bundle: Bundle): Analysis {
  const { manifest: m, files } = bundle, sessions = new Map<string, Mapped>(), gaps = new Set<string>();
  const fresh = m.migrationMode === "fresh-start-v1";
  let records = 0;
  const prepare = imagePreparer();
  for (const f of m.files) {
    const bytes = files.get(f.path); check(bytes && bytes.length === f.bytes && hash(bytes) === f.sha256, "HASH_MISMATCH");
    if (f.kind === "session" && !fresh) {
      const s = parse(bytes); check(!sessions.has(s.id), "SESSION_ID_COLLISION");
      const mapped = mapSession(s, m, prepare(s, m)); sessions.set(s.id, mapped); records += s.entries.length;
      mapped.gaps.forEach(g => gaps.add(g));
    } else if (f.kind === "document" || f.kind === "addition" || f.kind === "memory") text(bytes);
    else if (f.kind === "tasks" && !fresh) { json(bytes); gaps.add("TASKS_REVIEW_REQUIRED"); }
  }
  if (!fresh) {
    const index = json(files.get("sessions/sessions.json")!); check(object(index), "INDEX_INVALID");
    const mappedSessions = new Set<string>();
    for (const c of m.conversations) {
      const current = c.history.at(-1)!; const source = index[c.key];
      check(object(source) && source.sessionId === current.sessionId, "INDEX_MAPPING_MISMATCH");
      for (const selected of c.history) {
        const s = sessions.get(selected.sessionId); check(s, "SESSION_MISSING"); mappedSessions.add(selected.sessionId);
        const selectedChain = chain(s.session, selected.leafId);
        const chosen = new Set(selectedChain.map(e => uid(m.sourceId, m.agentId, s.session.id, e.id)));
        try {
          const entryMap = new Map(s.entries.map(e => [e.id,e]));
          // 原档形状与排除后的请求分别验配对；不能借排除中断修复原本断开的工具窗口。
          validateHistory([...chosen].map(id => entryMap.get(id)!).flatMap(e => {
            const partial = readInterrupted(e) ?? readDeferredReplay(e); return partial ? [partial] : e.kind === "message" ? [e.payload] : [];
          }));
          if (selected.leafId) resolveContext(s.entries, uid(m.sourceId, m.agentId, selected.sessionId, selected.leafId));
        } catch { gaps.add("CONTEXT_OR_PROTOCOL_INVALID"); }
      }
    }
    if ([...sessions.keys()].some(id => !mappedSessions.has(id))) gaps.add("SESSION_MAPPING_REQUIRED");
  } else {
    const memories = m.files.filter(f => f.kind === "memory" || f.path === "workspace/MEMORY.md");
    if (memories.length > 200 || memories.reduce((n, f) => n + f.bytes, 0) > 1024 * 1024) gaps.add("MEMORY_INDEX_REQUIRED");
    if (memories.some(f => !config(m.config).memoryReadKeys.includes(f.path.slice(10)))) gaps.add("MEMORY_NOT_READABLE");
  }
  try {
    const selected = documents(m.files.filter(f => f.kind === "document" || f.kind === "addition").map(f => ({ name: f.path.slice("workspace/".length), bytes: files.get(f.path)!, sha256: f.sha256 })), config(m.config));
    if (selected.some(d => d.truncated)) gaps.add("BOOTSTRAP_TRUNCATION");
  } catch { gaps.add("PROFILE_DOCUMENT_INVALID"); }
  return { bundle, sessions, gaps: [...gaps].sort(), records };
}
export function summary(a: Analysis) {
  return { ok: true, batchId: a.bundle.manifest.batchId, revision: a.bundle.manifest.revision, files: a.bundle.files.size,
    bytes: [...a.bundle.files.values()].reduce((n,b) => n+b.length,0), sessions: a.sessions.size, records: a.records,
    manifestSha256: a.bundle.manifestHash, gaps: a.gaps,
    migrationMode: a.bundle.manifest.migrationMode ?? "continuity",
    archivedSessionFiles: a.bundle.manifest.migrationMode === "fresh-start-v1" ? a.bundle.manifest.files.filter(f => f.kind === "session").length : 0,
    ...(a.bundle.manifest.migrationMode === "fresh-start-v1" ? { historyRestored:false } : {}),
    applicable: a.gaps.length === 0, deferredReplayRecords: [...a.sessions.values()].reduce((n, s) => n + s.entries.filter(e => readDeferredReplay(e)).length, 0), activated: false,
    continuity: "user_acceptance_pending", consistency: a.bundle.manifest.consistency };
}
