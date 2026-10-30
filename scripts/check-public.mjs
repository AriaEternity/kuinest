// 仅检查本公开仓库；索引白名单和已知敏感格式是辅助检查，不能代替人工审阅。
import {readdirSync,readFileSync,lstatSync,existsSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const roots=['apps/backend/','apps/frontend-pixel/','packages/contracts/','packages/chat-client/','tools/import-openclaw/','fixtures/','scripts/','tests/','examples/','docs/','deploy/','.github/workflows/','.githooks/'];
const top=new Set(['.editorconfig','.gitattributes','.gitignore','.node-version','.npmrc','package.json','package-lock.json','tsconfig.json','tsconfig.base.json','README.md','README.en.md','LICENSE','SECURITY.md','CONTRIBUTING.md','THIRD-PARTY-NOTICES.md']);
const ignored=new Set(['node_modules','dist','dist-test','.git','.cache','coverage']);
const privateRoots=new Set(['runtime','backup','logs']);
function walk(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(e=>ignored.has(e.name)||(resolve(directory)===resolve(root)&&privateRoots.has(e.name))?[]:e.isDirectory()?walk(join(directory,e.name)):[relative(root,join(directory,e.name)).replaceAll('\\','/')]);}
const files=existsSync(join(root,'.git'))?execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean):walk(root);
if(!files.length)throw Error('PUBLIC_INDEX_EMPTY');
for(const name of ['backups','binding','cli','files'])if(!files.includes('apps/backend/src/runtime/'+name+'.ts'))throw Error('RUNTIME_SOURCE_MISSING');
const rules=[
 ['原生产标识',/8\.163\.23\.36|xn--yet035g\.com|loveneko\.(?:com|cn)|v\.douyin\.com\/94Mu|space\.bilibili\.com\/370703/],
 ['个人文件路径',/[CD]:[\\/](?:Neko|Users[\\/]ASUS)(?:[\\/]|\b)/i],
 ['私钥或令牌',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}/],
 ['npm认证配置',/(?:_authToken|_password)\s*=/],
];
const problems=[];let bytes=0;
// 已授权公开的网站入口只允许作为根 README 中的完整 Markdown 链接。
const publicWebsiteReference=']('+new URL('https://小葵.com/').href+')';
for(const file of files){
 const parts=file.split('/');
 if(!(top.has(file)||roots.some(p=>file.startsWith(p)))||parts.some(p=>ignored.has(p))||privateRoots.has(parts[0])||/\.(?:sqlite(?:3)?(?:-.*)?|db|key|pem|pfx|p12|log|zip|tar|tgz)$/i.test(file)||(/(?:^|\/)\.env(?:\.|$)/.test(file)&&!file.endsWith('.example')))problems.push([file,'发布路径']);
 const full=resolve(root,file),info=lstatSync(full);if(info.isSymbolicLink()||!info.isFile()){problems.push([file,'非普通文件']);continue;}
 if(info.size>12*1024*1024)problems.push([file,'文件过大']);
 const data=readFileSync(full);bytes+=data.length;
 const text=data.toString('utf8');
 const domainScanText=(file==='README.md'||file==='README.en.md')?text.replaceAll(publicWebsiteReference,'](https://example.com/)'):text;
 for(const [label,pattern]of rules)if(pattern.test(label==='原生产标识'?domainScanText:text))problems.push([file,label]);
 if(file.endsWith('.md'))for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
  const link=match[1].split('#')[0];if(!link||/^[a-z]+:/i.test(link))continue;
  if(!existsSync(resolve(full,'..',decodeURIComponent(link))))problems.push([file,'本地链接不存在']);
 }
}
if(problems.length){for(const [file,rule]of problems)console.error(JSON.stringify({file,rule}));process.exitCode=1;}
else console.log(JSON.stringify({ok:true,files:files.length,bytes,restrictedPaths:0,knownSensitivePatterns:0}));
