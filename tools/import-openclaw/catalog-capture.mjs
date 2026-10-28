// 仅准备限定模型目录的只读采集；真实执行需要该新增文件范围的用户授权。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sourceProgram, runProgram, privatePath, secureNewOutput } from "./dist/source-transport.js";
import { validateConfigurationReview } from "./profile-capture.mjs";
import { check, json, object, uuid, hex, hash, write, safeFailure } from "./dist/safe.js";

export function catalogProgram(request) {
  const base = sourceProgram(request, "metadata").split("\nawait sourceMain(")[0];
  const projector = readFileSync(new URL("./config-projection.mjs", import.meta.url), "utf8");
  return base + "\nconst projector=await import(" + JSON.stringify("data:text/javascript;base64," + Buffer.from(projector).toString("base64")) + ");\n" +
    'try{const request=' + JSON.stringify(request) + ';const root=requestRoot(request),indexPath=path.join(root,"agents","main","sessions","sessions.json"),catalogPath=path.join(root,"agents","main","agent","models.json");' +
    'const indexBytes=read(indexPath,16*1024*1024),catalogBytes=read(catalogPath,4*1024*1024),index=parsed(indexBytes),catalog=parsed(catalogBytes);' +
    'need(object(index)&&object(index[KEY])&&identifier(index[KEY].sessionId),"WEB_SESSION_INVALID");need(object(catalog)&&object(catalog.providers),"SOURCE_JSON_INVALID");const selected=index[KEY];' +
    'const projection=projector.projectLegacyConfiguration({models:{providers:catalog.providers}},selected);' +
    'need(digest(read(indexPath,16*1024*1024))===digest(indexBytes)&&digest(read(catalogPath,4*1024*1024))===digest(catalogBytes),"SOURCE_CHANGED");' +
    'process.stdout.write(JSON.stringify({format:"kuinest-model-catalog-review-v1",sourceId:request.sourceId,batchId:request.batchId,sessionId:selected.sessionId,sourceVersion:version(request.mode),capturedAt:Date.now(),sourceIndexSha256:digest(indexBytes),sourceCatalogSha256:digest(catalogBytes),projection})+"\\n");' +
    '}catch(e){process.stderr.write(JSON.stringify({ok:false,code:e instanceof SourceError?e.code:"SOURCE_READ_FAILED"})+"\\n");process.exitCode=1;}';
}
export function validateCatalogReview(bytes, request) {
  check(bytes.length <= 16384, "CATALOG_REVIEW_LIMIT");
  const value = json(bytes);
  check(object(value) && value.format === "kuinest-model-catalog-review-v1" && hex(value.sourceCatalogSha256)
    && Object.keys(value).every(k => ["format","sourceId","batchId","sessionId","sourceVersion","capturedAt","sourceIndexSha256","sourceCatalogSha256","projection"].includes(k)), "CATALOG_REVIEW_INVALID");
  // 复用非秘密字段闭集；仅在验证器内换名，输出仍明确标为模型目录快照。
  const {sourceCatalogSha256, ...rest} = value;
  validateConfigurationReview(Buffer.from(JSON.stringify({...rest,format:"kuinest-config-review-v1",sourceConfigSha256:sourceCatalogSha256})),request);
  return value;
}
export async function captureCatalog(options, output, sourceId) {
  check(uuid(sourceId), "SOURCE_IDENTITY");
  const target=privatePath(output),request={mode:"private",sourceId,batchId:randomUUID()};
  secureNewOutput(target);
  const bytes=await runProgram(options,catalogProgram(request)),v=validateCatalogReview(bytes,request);
  write(target,"source-catalog.json",bytes);
  write(target,"catalog-receipt.json",Buffer.from(JSON.stringify({format:"kuinest-model-catalog-receipt-v1",sourceId,batchId:request.batchId,sha256:hash(bytes)})));
  return {ok:true,format:"kuinest-model-catalog-summary-v1",privateAcl:"verified",issues:v.projection.issues,
    configurationResolved:false,effectiveRuntimeVerified:false,credentialsPreserved:false,applied:false};
}
if(process.argv[1] && resolve(fileURLToPath(import.meta.url))===resolve(process.argv[1])) {
  try {
    const values=new Map(process.argv.slice(2).map(a=>{const at=a.indexOf("=");check(at>2&&a.startsWith("--"),"ARGUMENT_INVALID");return [a.slice(2,at),a.slice(at+1)];}));
    const keys=["host","identity","output","source-id","catalog-scope"];
    check(values.size===5&&process.argv.length===7&&keys.every(k=>values.get(k))&&values.get("catalog-scope")==="selected-model-catalog","ARGUMENT_INVALID");
    process.stdout.write(JSON.stringify(await captureCatalog({host:values.get("host"),identity:values.get("identity")},values.get("output"),values.get("source-id")))+"\n");
  } catch(e) {process.stderr.write(JSON.stringify(safeFailure(e))+"\n");process.exitCode=1;}
}
