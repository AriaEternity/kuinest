import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreDatabase } from "../../../apps/backend/dist/storage/backup.js";
import { checkedFile, checkSidecars } from "../../../apps/backend/dist/storage/paths.js";
import { appliedMigrations, verifyIntegrity, type Migration } from "../../../apps/backend/dist/storage/migrations.js";
import { requireNoActiveLease } from "../../../apps/backend/dist/storage/lease.js";
import { compile } from "../../../apps/backend/dist/context/compiler.js";
import { memoryRows } from "../../../apps/backend/dist/storage/context-records.js";
import { policy } from "../../../apps/backend/dist/tools/policy.js";
import type { Document, Pinned } from "../../../apps/backend/dist/context/types.js";
import { secureNewOutput } from "./source-transport.js";
import { loadBundle } from "./capture.js";
import { analyze } from "./validate.js";
import { stateHash, verifyLedger } from "./ledger.js";
import { check, hash, hex, json, object, read, write } from "./safe.js";

const project = fileURLToPath(new URL("../../../", import.meta.url));
const normalize = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
function contained(parent: string, target: string): boolean {
  const r = relative(normalize(parent), normalize(target));
  return !!r && r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
}
function sealedRelative(input: string, absolute: unknown): string {
  check(typeof absolute === "string" && isAbsolute(absolute) && contained(input, absolute), "ACCEPTANCE_SEAL_PATH");
  return relative(resolve(input), resolve(absolute)).split(sep).join("/");
}
function readSealed(input: string, p: string): Buffer {
  // safe.read允许中文记忆名，但不把整个封存路径放宽成任意Unicode路径。
  const prefix = /^(bundle|preview)\/workspace\/memory\//.exec(p)?.[1];
  return prefix ? read(join(input,prefix),p.slice(prefix.length+1)) : read(input,p);
}
export type AcceptanceChoices = { model: "pending" | "captured"; memory: "pending" | "confirm-before-save" };
export function acceptancePreflight(input: string, expectedSeal: string) {
  check(isAbsolute(input) && hex(expectedSeal), "ACCEPTANCE_ARGUMENT_INVALID");
  check(contained(join(project,"runtime/private/imports"),input) || contained(join(project,".cache/stage09-tests"),input),"ACCEPTANCE_SOURCE_SCOPE");
  const sealBytes = read(input, "CANDIDATE-SEAL.json", 2 * 1024 * 1024);
  check(hash(sealBytes) === expectedSeal, "ACCEPTANCE_SEAL_MISMATCH");
  const seal = json(sealBytes);
  check(object(seal) && seal.format === "kuinest-offline-candidate-seal-v1" && hex(seal.manifestSha256)
    && Array.isArray(seal.files) && seal.files.length > 0 && seal.files.length <= 5000, "ACCEPTANCE_SEAL_INVALID");
  const paths = new Set<string>();
  const sealed = seal.files.map(f => {
    check(object(f) && hex(f.sha256), "ACCEPTANCE_SEAL_INVALID");
    const p = sealedRelative(input, f.path), normalized = normalize(join(input,p));
    check(!paths.has(normalized), "ACCEPTANCE_SEAL_DUPLICATE"); paths.add(normalized);
    const bytes = readSealed(input, p); check(hash(bytes) === f.sha256, "ACCEPTANCE_FILE_CHANGED");
    return { path:p, sha256:f.sha256 };
  });
  const bundle = loadBundle(join(input, "bundle")), m = bundle.manifest;
  check(bundle.manifestHash === seal.manifestSha256 && m.migrationMode === "fresh-start-v1" && analyze(bundle).gaps.length === 0, "ACCEPTANCE_BUNDLE_INVALID");
  const sourceArea = m.mode === "private" ? join(project,"runtime/private/imports") : join(project,".cache/stage09-tests");
  check(contained(sourceArea,input), "ACCEPTANCE_SOURCE_SCOPE");
  for (const p of ["bundle/manifest.json","preview/candidate/kuinest.sqlite",...m.files.map(f=>"bundle/"+f.path)])
    check(paths.has(normalize(join(input,p))), "ACCEPTANCE_SEAL_COVERAGE");
  check(m.config.memoryWriteKeys.length === 0 && m.config.memoryAppendKeys.length === 0 && !m.config.memoryReplaceEnabled, "ACCEPTANCE_READONLY_REQUIRED");
  const file = checkedFile(join(input,"preview/candidate/kuinest.sqlite")); checkSidecars(file);
  // 封存源不得有待提交的旁文件，避免只校验主库而忽略新的WAL内容。
  for (const suffix of ["-wal","-journal"]) if (existsSync(file+suffix)) check(read(dirname(file),"kuinest.sqlite"+suffix).length === 0, "ACCEPTANCE_SOURCE_JOURNAL");
  const db = new Database(file,{readonly:true,fileMustExist:true});
  let migrations: readonly Migration[];
  let logicalHash: string, probe: {documentCount:number;memoryHeads:number;budgetFits:boolean;tokenCounterVerified:boolean;tools:string[]};
  try {
    db.exec("BEGIN");
    requireNoActiveLease(db,Date.now());migrations=appliedMigrations(db);verifyIntegrity(db,appliedMigrations(db));verifyLedger(db);
    const binding=db.prepare("SELECT manifest_sha256 FROM import_sources").get() as {manifest_sha256:string};
    check(binding.manifest_sha256===bundle.manifestHash,"ACCEPTANCE_DATABASE_BINDING");
    check(!db.prepare("SELECT 1 FROM characters WHERE active_version_id IS NOT NULL LIMIT 1").get(),"ACCEPTANCE_ALREADY_ACTIVE");
    check((db.prepare("SELECT count(*) AS n FROM character_versions").get() as {n:number}).n===1,"ACCEPTANCE_VERSION_COUNT");
    const v=db.prepare("SELECT id,character_id AS character FROM character_versions").get() as {id:string;character:string};
    const documents=db.prepare("SELECT logical_name AS name,content AS bytes,sha256 FROM character_documents WHERE version_id=?").all(v.id) as Document[];
    const memories=memoryRows(db,v.character),entry={id:"acceptance-offline-probe",parentId:null,branchId:"acceptance-offline-branch",kind:"message",payload:{role:"user",content:"离线启动前检查"}};
    const pinned:Pinned={snapshotId:"acceptance-offline",characterId:v.character,versionId:v.id,profile:m.profile,config:m.config,documents,memories,entries:[entry],boundary:entry.id,branchId:entry.branchId,receivedAt:Date.now(),allowMemoryWrite:false,allowWebSearch:false};
    const compiled=compile(pinned,[]),allowed=policy(pinned,false).names;
    check(!compiled.manifest.documents.some(d=>d.truncated)&&compiled.budget.fits&&compiled.request.messages.length===1,"ACCEPTANCE_CONTEXT_INVALID");
    check(JSON.stringify(allowed)===JSON.stringify(["clock_now","memory_search","memory_get"]),"ACCEPTANCE_TOOL_POLICY");
    logicalHash=stateHash(db);probe={documentCount:documents.length,memoryHeads:memories.length,budgetFits:true,tokenCounterVerified:compiled.budget.verified,tools:allowed};
  } finally {if(db.inTransaction)db.exec("ROLLBACK");db.close();}
  for(const f of sealed)check(hash(readSealed(input,f.path))===f.sha256,"ACCEPTANCE_SOURCE_CHANGED");
  return {bundle,sealed,logicalHash,probe,expectedSeal,migrations};
}

export async function prepareAcceptance(input: string, output: string, expectedSeal: string, choices: AcceptanceChoices = {model:"pending",memory:"pending"}) {
  check(object(choices) && Object.keys(choices).every(k=>["model","memory"].includes(k)) && ["pending","captured"].includes(choices.model) && ["pending","confirm-before-save"].includes(choices.memory),"ACCEPTANCE_CHOICE_INVALID");
  const before=acceptancePreflight(input,expectedSeal),m=before.bundle.manifest;
  check(isAbsolute(output)&&!existsSync(output)&&!contained(input,output)&&!contained(output,input),"ACCEPTANCE_OUTPUT_INVALID");
  const area=m.mode==="private"?join(project,"runtime/private/acceptance"):join(project,".cache/stage09-tests");
  check(contained(area,output),"ACCEPTANCE_OUTPUT_SCOPE");
  if(m.mode==="private")check(normalize(dirname(output))===normalize(area)&&/^case-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(relative(area,output)),"ACCEPTANCE_OUTPUT_SCOPE");
  secureNewOutput(output);
  const sourceFile=join(input,"preview/candidate/kuinest.sqlite"),database=join(output,"database"),rollback=join(output,"rollback"),rehearsal=join(output,"restore-rehearsal");
  // 全部是新目录；不覆盖源、试用库或任何既有运行库，也不激活角色。
  await restoreDatabase(sourceFile,database,Date.now(),before.migrations);
  await restoreDatabase(join(database,"kuinest.sqlite"),rollback,Date.now(),before.migrations);
  await restoreDatabase(join(rollback,"kuinest.sqlite"),rehearsal,Date.now(),before.migrations);
  const databases=[database,rollback,rehearsal].map(directory=>{
    const db=new Database(checkedFile(join(directory,"kuinest.sqlite")),{readonly:true,fileMustExist:true});
    try {verifyIntegrity(db,appliedMigrations(db));verifyLedger(db);check(stateHash(db)===before.logicalHash,"ACCEPTANCE_RESTORE_MISMATCH");check(!db.prepare("SELECT 1 FROM characters WHERE active_version_id IS NOT NULL LIMIT 1").get(),"ACCEPTANCE_ALREADY_ACTIVE");}
    finally{db.close();}
    return {path:relative(output,join(directory,"kuinest.sqlite")).split(sep).join("/"),sha256:hash(read(directory,"kuinest.sqlite")),logicalSha256:before.logicalHash};
  });
  const after=acceptancePreflight(input,expectedSeal);check(after.logicalHash===before.logicalHash,"ACCEPTANCE_SOURCE_CHANGED");
  const plan={format:"kuinest-private-acceptance-plan-v1",createdAt:new Date().toISOString(),status:"prepared-not-activated",source:{directory:input,sealSha256:expectedSeal,manifestSha256:before.bundle.manifestHash},databases,
    profileReview:{candidate:m.profile,status:"unverified-offline-placeholder",userModelChoice:choices.model,thinkingChoice:"pending",outputLimitChoice:"pending",timezoneChoice:"pending",credentialsConfigured:false,credentialsIncluded:false},
    memoryPolicy:{baseline:"preserve-all-unchanged",frozenAdditions:"preserve-all-unchanged",currentWrites:"disabled",proposedPolicy:"user-confirmation-before-save",userChoice:choices.memory,reviewQueueImplemented:false},
    firstRun:{context:"empty",channel:"text",tools:before.probe.tools,webSearch:false,scheduledTasks:false,imageAcceptance:false,activate:false,allowLive:false},
    checks:{...before.probe,sourceUnchanged:true,databaseRestoreVerified:true,sourceContextEntries:0},
    remaining:["runtime-profile-choice","restricted-private-test-entry","credential-injection-without-logging","explicit-live-and-test-activation-authorization","private-M07-user-acceptance"],
    m07:["persona-and-tone","confirmed-long-term-facts","shared-memory-context","empty-chat-and-new-window-isolation","baseline-write-protection","new-memory-policy"].map(id=>({id,status:"not-run",evidence:"private-only"})),
    productionCutover:false,stage10Authorized:false};
  write(output,"ACCEPTANCE-PLAN.json",Buffer.from(JSON.stringify(plan,null,2)));
  const summary={ok:true,format:"kuinest-acceptance-preparation-summary-v1",sourceSealSha256:expectedSeal,sourceManifestSha256:before.bundle.manifestHash,testDatabases:1,rollbackDatabases:1,restoreRehearsals:1,logicalHashMatches:3,sourceUnchanged:true,documentCount:before.probe.documentCount,memoryHeads:before.probe.memoryHeads,budgetFits:before.probe.budgetFits,tokenCounterVerified:before.probe.tokenCounterVerified,contextEntries:0,m07Passed:0,m07Pending:6,modelChoice:choices.model,memoryChoice:choices.memory,profileVerified:false,credentialsRead:false,realModelCalls:0,activated:false,productionSwitched:false};
  write(output,"PREPARATION-REPORT.json",Buffer.from(JSON.stringify(summary,null,2)));
  return summary;
}
