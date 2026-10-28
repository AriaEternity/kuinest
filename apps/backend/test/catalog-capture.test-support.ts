import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, linkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { fixture, put, key } from "./import-fixtures.js";
import { projectRoot } from "../dist/server.js";
import { hash } from "../../../tools/import-openclaw/dist/safe.js";
const moduleUrl=pathToFileURL(join(projectRoot,"tools/import-openclaw/catalog-capture.mjs")).href;
function setup() {
  const f=fixture(),root=join(f.directory,"catalog-source");
  const catalog={providers:{"synthetic-provider":{api:"openai-completions",baseUrl:"https://example.invalid/v1",apiKey:"SYNTHETIC_KEY",headers:{Authorization:"SYNTHETIC_HEADER"},
    models:[{id:"synthetic-model",reasoning:false,maxTokens:8192,contextWindow:100000,input:["text","image"],apiKey:"SYNTHETIC_MODEL_KEY"}]},
    unrelated:{apiKey:"SYNTHETIC_OTHER_PROVIDER",models:[{id:"unrelated"}]}}};
  put(root,"agents/main/agent/models.json",JSON.stringify(catalog));
  put(root,"agents/main/sessions/sessions.json",JSON.stringify({[key]:{sessionId:f.sessionId,modelProvider:"synthetic-provider",model:"synthetic-model",authProfile:"SYNTHETIC_AUTH"},
    unrelated:{body:"SYNTHETIC_OTHER_CHAT"}}));
  // 不创建openclaw.json或私有聊天正文：成功说明本工具没有依赖这些读取。
  return {...f,root,request:{mode:"synthetic",root,sourceId:randomUUID(),batchId:randomUUID()}};
}
function run(request:unknown,extra="") {
  return spawnSync(process.execPath,["--input-type=module"],{encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:32768,
    input:'import {catalogProgram,validateCatalogReview} from '+JSON.stringify(moduleUrl)+';import {spawnSync} from "node:child_process";const request='+JSON.stringify(request)+';const r=spawnSync(process.execPath,["--input-type=module"],{input:catalogProgram(request),encoding:"utf8",windowsHide:true});if(r.status!==0){process.stderr.write(r.stderr);process.exitCode=1;}else{const value=validateCatalogReview(Buffer.from(r.stdout),request);'+(extra||'process.stdout.write(JSON.stringify(value));')+'}'});
}
test("MC01：模型目录白名单真实子进程采集，无凭据/其他模型/聊天内容，源文件不变",()=>{
  const f=setup(),path=join(f.root,"agents/main/agent/models.json"),before=hash(readFileSync(path)),r=run(f.request);
  assert.equal(r.status,0,r.stderr);const value=JSON.parse(r.stdout);assert.equal(value.format,"kuinest-model-catalog-review-v1");
  assert.equal(value.sourceCatalogSha256,before);assert.equal(hash(readFileSync(path)),before);
  assert.equal(value.projection.declared.reasoning,false);assert.equal(value.projection.declared.maxTokens,8192);
  assert.deepEqual(value.projection.issues,[]);assert.equal(value.projection.effectiveRuntimeVerified,false);
  assert.doesNotMatch(r.stdout,/SYNTHETIC_KEY|SYNTHETIC_HEADER|SYNTHETIC_MODEL_KEY|SYNTHETIC_OTHER_PROVIDER|SYNTHETIC_AUTH|SYNTHETIC_OTHER_CHAT|unrelated/);
});
test("MC02：坏JSON及多硬链接拒绝，错误不含配置片段或路径",()=>{
  const a=setup();writeFileSync(join(a.root,"agents/main/agent/models.json"),"{SYNTHETIC_BROKEN_SECRET");
  const first=run(a.request);assert.equal(first.status,1);assert.equal(first.stdout,"");assert.doesNotMatch(first.stderr,/SYNTHETIC_BROKEN|catalog-source/);
  const b=setup();linkSync(join(b.root,"agents/main/agent/models.json"),join(b.directory,"catalog-alias"));
  const second=run(b.request);assert.equal(second.status,1);assert.match(second.stderr,/SOURCE_PATH_UNSAFE/);assert.equal(second.stdout,"");
});
test("MC03：接收闭集拒绝根字段/嵌套凭据/URL查询/来源错绑/错格式",()=>{
  const f=setup(),r=run(f.request,'let rejected=0;for(const kind of ["root","nested","url","binding","format"]){const v=structuredClone(value);if(kind==="root")v.extra="SYNTHETIC";if(kind==="nested")v.projection.declared.apiKey="SYNTHETIC";if(kind==="url")v.projection.declared.baseUrl="https://example.invalid/v1?key=SYNTHETIC";if(kind==="binding")v.sourceId="00000000-0000-0000-0000-000000000000";if(kind==="format")v.format="kuinest-config-review-v1";try{validateCatalogReview(Buffer.from(JSON.stringify(v)),request);}catch{rejected++;}}process.stdout.write(JSON.stringify({rejected}));');
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).rejected,5);
});
test("MC04：真实入口必须显式catalog范围参数，模块导入不自动读取远端",()=>{
  const r=spawnSync(process.execPath,[join(projectRoot,"tools/import-openclaw/catalog-capture.mjs"),"--config-scope=selected-model-config"],{encoding:"utf8",windowsHide:true});
  assert.equal(r.status,1);assert.equal(r.stdout,"");assert.match(r.stderr,/ARGUMENT_INVALID/);
});
