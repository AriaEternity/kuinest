// 创建全新空白运行环境；不读取凭据、不激活角色、不调用模型、不覆盖原目录。
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {SqliteStorage} from '../apps/backend/dist/storage/storage.js';
import {config,profile,documentNames,hash,documents} from '../apps/backend/dist/context/profile.js';
import {secureNewOutput} from '../tools/import-openclaw/dist/source-transport.js';
import {privatePath} from '../apps/backend/dist/runtime/files.js';

const project=fileURLToPath(new URL('../',import.meta.url));
function ensure(value){if(!value)throw Error('INITIALIZATION_INVALID');}
function read(file,max){const info=lstatSync(file);ensure(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=max);return readFileSync(file);}
export async function initializeRuntime({output,documentsDirectory,settingsFile}){
 ensure([output,documentsDirectory,settingsFile].every(p=>typeof p==='string'&&isAbsolute(p)));
 const destination=resolve(output),inside=relative(project,destination);
 // 工程内仅允许独立runtime/private子目录，防止私有资料落入静态根或源码。
 if(!inside.startsWith('..')&&!isAbsolute(inside))ensure(destination.startsWith(resolve(project,'runtime/private')+ (process.platform==='win32'?'\\':'/')));
 ensure(destination!==resolve(documentsDirectory)&&!resolve(documentsDirectory).startsWith(destination+(process.platform==='win32'?'\\':'/')));
 const settings=JSON.parse(read(settingsFile,65536).toString('utf8'));
 ensure(settings&&typeof settings==='object'&&!Array.isArray(settings)&&Object.keys(settings).every(k=>['model','endpoint','options','config'].includes(k)));
 const owner=randomUUID(),character=randomUUID(),version=randomUUID(),now=Date.now();
 const p=profile({id:randomUUID(),provider:'deepseek',status:'unverified',model:settings.model,endpoint:settings.endpoint,options:settings.options});
 const c=config({...settings.config,memoryReviewEnabled:true,memoryWriteKeys:[],memoryAppendKeys:[],memoryReplaceEnabled:false});
 const docs=documentNames.map(name=>{const bytes=read(join(documentsDirectory,name),4*1024*1024);return {name,bytes,sha256:hash(bytes)};});
 ensure(documents(docs,c).length===documentNames.length&&documents(docs,c).every(d=>!d.truncated));
 secureNewOutput(destination);privatePath(destination,true);
 const store=new SqliteStorage({dataRoot:destination,instanceId:randomUUID(),clock:{now:Date.now}});
 try{
  store.apiAccess().initializeOwner({id:owner,username:'setup-pending-'+randomUUID(),passwordHash:'!',characterId:character,versionId:randomUUID(),profileId:randomUUID(),createdAt:now});
  store.characterAccess().publish(owner,{characterId:character,versionId:version,profile:p,config:c,documents:docs},now);
  const binding=store.runtimeAccess().inspect(owner,character,version).binding;
  const bytes=Buffer.from(JSON.stringify(binding,null,2)+'\n');
  writeFileSync(join(destination,'runtime-binding.json'),bytes,{flag:'wx',mode:0o600});
  writeFileSync(join(destination,'cursor.key'),randomBytes(32).toString('base64')+'\n',{flag:'wx',mode:0o600});
  privatePath(join(destination,'runtime-binding.json'));privatePath(join(destination,'cursor.key'));
  return {ok:true,bindingSha256:hash(bytes),activated:false,accountReady:false,modelCalls:0};
 }finally{await store.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const options={};for(const arg of process.argv.slice(2)){const match=/^--(output|documents|settings)=(.+)$/.exec(arg);ensure(match&&!Object.hasOwn(options,match[1]));options[match[1]]=match[2];}
  ensure(Object.keys(options).length===3);
  console.log(JSON.stringify(await initializeRuntime({output:options.output,documentsDirectory:options.documents,settingsFile:options.settings})));
 }catch{console.error(JSON.stringify({ok:false,code:'RUNTIME_INITIALIZATION_FAILED',modelCalls:0}));process.exitCode=1;}
}
