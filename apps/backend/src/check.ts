import { loadConfig, readConfigEnvironment } from "./config.js";
import { projectRoot } from "./server.js";
try {
  const config = loadConfig(readConfigEnvironment(process.env), projectRoot);
  process.stdout.write(JSON.stringify({ status: "ok", mode: config.mode, configurationOnly: true }) + "\n");
} catch {
  process.stderr.write('{"error":{"code":"CONFIG_INVALID","message":"启动配置无效，请检查工程配置说明。"}}\n');
  process.exitCode = 1;
}
