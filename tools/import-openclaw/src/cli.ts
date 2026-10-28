import { prepareAcceptance } from "./acceptance.js";
import { reviewReadiness } from "./source-readiness.js";
import { exportMetadata, verifyMetadata, compareMetadata } from "./source-metadata.js";
import { diffSource } from "./source-diff.js";
import { auditSource } from "./source-audit.js";
import { capture } from "./capture.js";
import { scope } from "./manifest.js";
import { inspect } from "./inspect.js";
import { apply, dryRun, verify } from "./apply.js";
import { randomUUID } from "node:crypto";
import { exportSource, runSource } from "./source-transport.js";
import { verifySource, safeProbe } from "./source-receive.js";
import { check, json, read, safeFailure } from "./safe.js";
import type { Scope } from "./types.js";
export async function main(args: string[]): Promise<unknown> {
  const [command,...rest] = args, values = new Map<string,string>();
  for (const arg of rest) { const at = arg.indexOf("="); check(at > 2 && arg.startsWith("--"), "ARGUMENT_INVALID"); const key = arg.slice(2,at); check(!values.has(key), "ARGUMENT_INVALID"); values.set(key,arg.slice(at+1)); }
  const allowed: Record<string,string[]> = { "acceptance-prepare":["input","output","seal-sha256","model-choice","memory-policy"], capture:["input","output"], inspect:["input"], validate:["batch"], "dry-run":["input","output"], apply:["batch","target","owner"], verify:["target"], "source-probe":["host","identity"], "source-export":["host","identity","output","source-id"], "source-verify":["input"], "source-audit":["input"], "source-diff":["before","after"], "source-metadata":["host","identity","output","source-id"], "metadata-verify":["input"], "metadata-compare":["metadata","source"], "source-readiness":["metadata","source"] };
  const keys = allowed[command ?? ""]; check(keys && values.size === keys.length && keys.every(k=>values.get(k)), "ARGUMENT_INVALID");
  const v = (key:string) => values.get(key)!;
  if (command === "acceptance-prepare") return prepareAcceptance(v("input"),v("output"),v("seal-sha256"),{model:v("model-choice") as "pending"|"captured",memory:v("memory-policy") as "pending"|"confirm-before-save"});
  if (command === "source-probe") {
    const output=await runSource({host:v("host"),identity:v("identity")},{mode:"private",sourceId:randomUUID(),batchId:randomUUID()},"probe");
    return safeProbe(json(output));
  }
  if (command === "source-export") return exportSource({host:v("host"),identity:v("identity")},v("output"),v("source-id"));
  if (command === "source-metadata") return exportMetadata({host:v("host"),identity:v("identity")},v("output"),v("source-id"));
  if (command === "metadata-verify") return verifyMetadata(v("input"));
  if (command === "source-readiness") return reviewReadiness(v("metadata"),v("source"));
  if (command === "metadata-compare") return compareMetadata(v("metadata"),v("source"));
  if (command === "source-diff") return diffSource(v("before"),v("after"));
  if (command === "source-audit") return auditSource(v("input"));
  if (command === "source-verify") return {...verifySource(v("input")),applied:false};
  if (command === "capture") {
    const input = v("input"), definition = scope(json(read(input,"scope.json",2*1024*1024))) as Scope;
    capture(input,v("output"),definition); return inspect(v("output"));
  }
  if (command === "inspect") return inspect(v("input"));
  if (command === "validate") return inspect(v("batch"));
  if (command === "dry-run") return dryRun(v("input"),v("output"));
  if (command === "apply") return apply(v("batch"),v("target"),v("owner"));
  return verify(v("target"));
}
try {
  const result = await main(process.argv.slice(2)); process.stdout.write(JSON.stringify(result)+"\n");
  if (typeof result === "object" && result && "applicable" in result && !result.applicable) process.exitCode = 2;
} catch(error) { process.stderr.write(JSON.stringify(safeFailure(error))+"\n"); process.exitCode = 1; }
