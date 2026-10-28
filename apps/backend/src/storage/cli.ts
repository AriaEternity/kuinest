import { RuntimeBackups,restoreRuntimeBackup } from "../runtime/backups.js";
import { readBinding } from "../runtime/binding.js";
import { privatePath, privateDatabase } from "../runtime/files.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, readConfigEnvironment } from "../config.js";
import { StorageError, requireCondition } from "./errors.js";
import { SqliteStorage } from "./storage.js";
import { restoreDatabase } from "./backup.js";
import { checkedFile } from "./paths.js";

async function main(): Promise<void> {
  const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
  const config = loadConfig(readConfigEnvironment(process.env), projectRoot);
  if(config.mode==="private"){privateDatabase(config.dataRoot);}
  const [command, argument, ...extra] = process.argv.slice(2);
  requireCondition(extra.length === 0, "ARGUMENT_INVALID");
  if (command === "backup" && argument === undefined) {
    // 维护命令必须取得租约；已运行的服务不会被离线命令绕过。
    checkedFile(join(config.dataRoot, "kuinest.sqlite"));
    const storage = new SqliteStorage({ dataRoot: config.dataRoot, instanceId: randomUUID(), clock: { now: Date.now } });
    storage.startRenewal(() => {});
    const id = randomUUID();
    try {
      if(config.mode==="private"){const manager=new RuntimeBackups(storage,config.dataRoot,readBinding(config.dataRoot,config.runtimeBindingSha256));try{const result=await manager.create();process.stdout.write(JSON.stringify({status:"ok",backupId:result.id})+"\n");}finally{await manager.close();}}else{await storage.backup(join(config.dataRoot, "backups", id + ".sqlite"));process.stdout.write(JSON.stringify({ status: "ok", backupId: id }) + "\n");}
    } finally { await storage.close(); }
  } else if (command === "restore" && /^--backup=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(argument ?? "")) {
    const sourceId = argument!.slice("--backup=".length), id = randomUUID();
    if(config.mode==="private"){process.stdout.write(JSON.stringify({status:"ok",...await restoreRuntimeBackup(config.dataRoot,sourceId)})+"\n");}else{await restoreDatabase(join(config.dataRoot, "backups", sourceId + ".sqlite"), join(config.dataRoot, "restores", id), Date.now());process.stdout.write(JSON.stringify({ status: "ok", restoreId: id, activated: false }) + "\n");}
  } else throw new StorageError("ARGUMENT_INVALID");
}
try { await main(); }
catch (error) {
  const code = error instanceof StorageError ? error.code : "STORAGE_MAINTENANCE_FAILED";
  process.stderr.write(JSON.stringify({ error: { code, message: "存储维护未完成，请核对数据目录、租约和备份编号。" } }) + "\n");
  process.exitCode = 1;
}
