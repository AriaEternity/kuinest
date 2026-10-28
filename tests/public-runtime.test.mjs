import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {initializeRuntime} from '../scripts/init-runtime.mjs';
import {SqliteStorage} from '../apps/backend/dist/storage/storage.js';
import {runtimeCommand} from '../apps/backend/dist/runtime/cli.js';
import {passwords} from '../apps/backend/dist/auth/password.js';
const project=fileURLToPath(new URL('../',import.meta.url));

test('公开初始化保持空聊天、禁用登录、未激活，原维护入口可完成账号及激活',async()=>{
 const parent=mkdtempSync(join(tmpdir(),'kuinest-public-test-')),output=join(parent,'data');
 try{
  const result=await initializeRuntime({output,documentsDirectory:join(project,'examples/character'),settingsFile:join(project,'examples/runtime-settings.json')});
  assert.equal(result.activated,false);assert.equal(result.accountReady,false);assert.equal(result.modelCalls,0);
  await assert.rejects(()=>initializeRuntime({output,documentsDirectory:join(project,'examples/character'),settingsFile:join(project,'examples/runtime-settings.json')}));
  const binding=JSON.parse(readFileSync(join(output,'runtime-binding.json'),'utf8'));
  let store=new SqliteStorage({dataRoot:output,instanceId:randomUUID(),clock:{now:Date.now}});
  try{
   assert.equal(store.runtimeAccess().verify(binding,false).accountReady,false);
   assert.throws(()=>store.runtimeAccess().verify(binding));
   assert.equal(store.apiAccess().conversations(binding.owner,undefined,10).length,0);
   store.runtimeAccess().setOwnerLogin(binding.owner,'synthetic-public-test',await passwords.hash('synthetic-private-test-password'),Date.now());
   store.characterAccess().activate(binding.owner,binding.character,binding.version,true);
   assert.equal(store.runtimeAccess().verify(binding).accountReady,true);
  }finally{await store.close();}
  const env={NODE_ENV:'production',APP_MODE:'private',DATA_ROOT:output,PUBLIC_ORIGIN:'https://chat.example.com',CURSOR_HMAC_KEY_FILE:join(output,'cursor.key'),RUNTIME_BINDING_SHA256:result.bindingSha256,ALLOW_LIVE_MODEL:'false'};
  assert.equal((await runtimeCommand(['check-runtime'],env)).ok,true);
 }finally{
  const target=resolve(parent),base=resolve(tmpdir()),part=relative(base,target);
  assert.ok(part&&!part.startsWith('..'+sep)&&!part.startsWith(sep)&&target.startsWith(base+sep)&&target.includes('kuinest-public-test-'));
  rmSync(target,{recursive:true});
 }
});

test('初始化拒绝把运行资料写入公开资源目录',async()=>{
 const output=join(project,'apps/frontend-pixel/assets','synthetic-invalid-'+randomUUID());
 await assert.rejects(()=>initializeRuntime({output,documentsDirectory:join(project,'examples/character'),settingsFile:join(project,'examples/runtime-settings.json')}));
});
