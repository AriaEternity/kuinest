import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, put, key } from "./import-fixtures.js";
import { capture } from "../../../tools/import-openclaw/dist/capture.js";
import { dryRun } from "../../../tools/import-openclaw/dist/apply.js";
import { hash } from "../../../tools/import-openclaw/dist/safe.js";
import { acceptancePreflight, prepareAcceptance } from "../../../tools/import-openclaw/dist/acceptance.js";
const code=(name:string)=>(e:unknown)=>(e as {code?:string}).code===name;
export function sealed() {
  const f=fixture(),source=join(f.directory,"sealed-source");f.definition.migrationMode="fresh-start-v1";f.definition.requireReasoning=false;f.definition.conversations=[{key,history:[]}];f.definition.config.memoryWriteKeys=[];
  const chinese="workspace/memory/合成主题.md";put(f.input,chinese,"虚构合成测试：月亮积木。");f.definition.files.push({path:chinese,kind:"memory"});f.definition.config.memoryReadKeys.push(chinese.slice(10));
  const bundle=capture(f.input,join(source,"bundle"),f.definition);dryRun(join(source,"bundle"),join(source,"preview"));
  const paths=["bundle/manifest.json","preview/candidate/kuinest.sqlite",...bundle.manifest.files.map(f=>"bundle/"+f.path)];
  const seal={format:"kuinest-offline-candidate-seal-v1",manifestSha256:bundle.manifestHash,files:paths.map(p=>({path:join(source,p),sha256:hash(readFileSync(join(source,p)))}))};
  const save=()=>{const b=Buffer.from(JSON.stringify(seal));writeFileSync(join(source,"CANDIDATE-SEAL.json"),b);return hash(b);};
  return {...f,source,seal,save,sealHash:save(),output:join(f.directory,"acceptance-output")};
}
test("AP01：封存候选生成隔离试用库、整库备份及恢复演练，保持空上下文且未激活",async()=>{
  const f=sealed(),sourceHash=hash(readFileSync(join(f.source,"preview/candidate/kuinest.sqlite")));const r=await prepareAcceptance(f.source,f.output,f.sealHash,{model:"captured",memory:"confirm-before-save"});
  assert.equal(r.logicalHashMatches,3);assert.equal(r.contextEntries,0);assert.equal(r.activated,false);assert.equal(r.realModelCalls,0);assert.equal(r.m07Passed,0);assert.equal(r.m07Pending,6);
  assert.equal(hash(readFileSync(join(f.source,"preview/candidate/kuinest.sqlite"))),sourceHash);
  const plan=JSON.parse(readFileSync(join(f.output,"ACCEPTANCE-PLAN.json"),"utf8"));assert.equal(plan.profileReview.userModelChoice,"captured");assert.equal(plan.memoryPolicy.userChoice,"confirm-before-save");assert.equal(plan.memoryPolicy.reviewQueueImplemented,false);assert.equal(plan.firstRun.allowLive,false);assert.equal(plan.firstRun.activate,false);assert.deepEqual(plan.firstRun.tools,["clock_now","memory_search","memory_get"]);
});
test("AP02：错误封存哈希在创建任何输出前被拒绝",async()=>{const f=sealed();await assert.rejects(()=>prepareAcceptance(f.source,f.output,"0".repeat(64)),code("ACCEPTANCE_SEAL_MISMATCH"));assert.equal(existsSync(f.output),false);});
test("AP03：候选文件改变或遗漏封存覆盖时拒绝",()=>{const f=sealed();put(join(f.source,"bundle"),"workspace/SOUL.md","CHANGED_SYNTHETIC");assert.throws(()=>acceptancePreflight(f.source,f.sealHash),code("ACCEPTANCE_FILE_CHANGED"));const g=sealed();g.seal.files=g.seal.files.filter(f=>!f.path.endsWith("kuinest.sqlite"));assert.throws(()=>acceptancePreflight(g.source,g.save()),code("ACCEPTANCE_SEAL_COVERAGE"));});
test("AP04：封存清单中的越界路径与重复路径拒绝",()=>{const f=sealed();f.seal.files[0]!.path=join(f.directory,"outside.json");assert.throws(()=>acceptancePreflight(f.source,f.save()),code("ACCEPTANCE_SEAL_PATH"));const g=sealed();g.seal.files.push(g.seal.files[0]!);assert.throws(()=>acceptancePreflight(g.source,g.save()),code("ACCEPTANCE_SEAL_DUPLICATE"));});
test("AP05：输出不得覆盖现有目录或进入封存源内部",async()=>{const f=sealed();await assert.rejects(()=>prepareAcceptance(f.source,f.source,f.sealHash),code("ACCEPTANCE_OUTPUT_INVALID"));await assert.rejects(()=>prepareAcceptance(f.source,join(f.source,"new-output"),f.sealHash),code("ACCEPTANCE_OUTPUT_INVALID"));});
test("AP06：存在非空日志旁文件的封存库拒绝",()=>{const f=sealed();writeFileSync(join(f.source,"preview/candidate/kuinest.sqlite-wal"),"SYNTHETIC_NONEMPTY_WAL");assert.throws(()=>acceptancePreflight(f.source,f.sealHash),code("ACCEPTANCE_SOURCE_JOURNAL"));});
test("AP07：模式选项不能冒充真实调用或自动写入授权",async()=>{const f=sealed();await assert.rejects(()=>prepareAcceptance(f.source,f.output,f.sealHash,{model:"live",memory:"auto"} as never),code("ACCEPTANCE_CHOICE_INVALID"));assert.equal(existsSync(f.output),false);});
test("AP08：完整库恢复校验后，重复准备不覆盖已有试用库",async()=>{const f=sealed();await prepareAcceptance(f.source,f.output,f.sealHash);const before=hash(readFileSync(join(f.output,"database/kuinest.sqlite")));await assert.rejects(()=>prepareAcceptance(f.source,f.output,f.sealHash),code("ACCEPTANCE_OUTPUT_INVALID"));assert.equal(hash(readFileSync(join(f.output,"database/kuinest.sqlite"))),before);});
