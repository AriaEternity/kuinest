import { join } from "node:path";
import { privatePath, privateDatabase } from "../runtime/files.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, readConfigEnvironment } from "../config.js";
import { ApplicationError, ensure } from "../application/errors.js";
import { SqliteStorage } from "../storage/storage.js";
import { requireCondition, StorageError } from "../storage/errors.js";
import { passwords } from "./password.js";
import { readTerminal } from "./terminal.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  requireCondition(args.length === 0 && ["owner-init", "owner-password", "auth-unlock"].includes(command ?? ""), "ARGUMENT_INVALID");
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const config = loadConfig(readConfigEnvironment(process.env), root);
  if(config.mode==="private"){requireCondition(command!=="owner-init","USE_PRIVATE_OWNER_SETUP");privateDatabase(config.dataRoot);}
  const storage = new SqliteStorage({ dataRoot: config.dataRoot, instanceId: randomUUID(), clock: { now: Date.now } });
  storage.startRenewal(() => {});
  try {
    const store = storage.apiAccess();
    if (command === "auth-unlock") store.unlockLogin();
    else {
      process.stdout.write("账号维护仅作用于明确选择的当前数据库。\n");
      const username = await readTerminal("账号名：", false, 128);
      ensure(username.length > 0 && Buffer.byteLength(username) <= 512, "INPUT_INVALID");
      const old = store.owner(username);
      if (command === "owner-password") ensure(old, "NOT_FOUND");
      const password = await readTerminal("新口令（至少12字符，输入不回显）：", true, 256);
      const confirmation = await readTerminal("再次输入新口令：", true, 256);
      ensure(password === confirmation, "INPUT_INVALID");
      const passwordHash = await passwords.hash(password);
      if (command === "owner-init") store.initializeOwner({ id: randomUUID(), username, passwordHash, createdAt: Date.now(), characterId: randomUUID(), versionId: randomUUID(), profileId: randomUUID() });
      else store.changePassword(old!.id, old!.passwordHash, passwordHash, Date.now());
    }
    process.stdout.write(JSON.stringify({ status: "ok", mode: config.mode, operation: command, ...(command === "owner-init" ? { demoCharacter: true } : {}) }) + "\n");
  } finally { await storage.close(); }
}
try { await main(); }
catch (error) {
  const code = error instanceof StorageError || error instanceof ApplicationError ? error.code : "OWNER_MAINTENANCE_FAILED";
  process.stderr.write(JSON.stringify({ error: { code, message: "账号维护未完成，请检查数据目录、服务租约和交互输入。" } }) + "\n");
  process.exitCode = 1;
}
