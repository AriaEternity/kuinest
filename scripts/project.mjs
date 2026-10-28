import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const [command, ...args] = process.argv.slice(2);
function fail(message) { process.stderr.write(message + "\n"); process.exit(1); }
if (Number(process.versions.node.split(".")[0]) !== 24 || Number(process.versions.node.split(".")[1]) < 20)
  fail("需要 Node.js 24.20.0 或同一主版本中更高的补丁版本。");
const stages = new Map([["01", "apps/backend/dist-test/stage01.test.js"], ["02", "apps/backend/dist-test/stage02.test.js"], ["03", "apps/backend/dist-test/stage03.test.js"], ["04", "apps/backend/dist-test/stage04.test.js"], ["05", "apps/backend/dist-test/stage05.test.js"], ["06", "apps/backend/dist-test/stage06.test.js"], ["07", "apps/backend/dist-test/stage07.test.js"], ["08", "apps/backend/dist-test/stage08.test.js"], ["09", "apps/backend/dist-test/stage09.test.js"], ["10", "apps/backend/dist-test/stage10.test.js"], ["kuisense", "apps/backend/dist-test/kuisense.test.js"], ["kuisense-mcp", "apps/backend/dist-test/kuisense-mcp.test.js"], ["luckin-mcp", "apps/backend/dist-test/luckin-mcp.test.js"]]);
const privateCommands=["private-owner-setup","private-activate","private-check-runtime","private-backup","private-restore","private-owner-password","private-auth-unlock"];
if (!["build", "typecheck", "test", "dev", "start", "check", "backup", "restore", "owner-init", "owner-password", "auth-unlock",...privateCommands].includes(command))
  fail("未知工程命令。");
if (command === "test" && (args.length !== 1 || !/^--stage=(01|02|03|04|05|06|07|08|09|10|kuisense|kuisense-mcp|luckin-mcp|all)$/.test(args[0])))
  fail("参数无效；测试当前只支持 --stage=01、--stage=02 、--stage=03、--stage=04、--stage=05、--stage=06、--stage=07、--stage=08、--stage=09、--stage=10、--stage=kuisense 、--stage=kuisense-mcp 、--stage=luckin-mcp 或 --stage=all。");
if (["restore","private-restore"].includes(command) && (args.length !== 1 || !/^--backup=[0-9a-f-]{36}$/.test(args[0])))
  fail("恢复须指定 --backup=<备份 UUID>。");
if (!["test", "restore", "private-restore"].includes(command) && args.length !== 0) fail("参数无效。");

function run(script, argv = [], env = process.env) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...argv], { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (result.error) fail("无法启动工程子进程。");
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (["build", "typecheck", "test", "dev", "backup", "restore", "owner-init", "owner-password", "auth-unlock"].includes(command))
  run("node_modules/typescript/bin/tsc", ["-b", "tsconfig.json", "apps/backend/tsconfig.test.json", ...(command === "typecheck" ? ["--force"] : [])]);
if (command === "test") {
  const stage = args[0].slice("--stage=".length);
  const files = stage === "all" ? [...stages.values(), "apps/backend/dist-test/conversation-management.test.js"] : [stages.get(stage)];
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files.map(file => resolve(root, file))], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) fail("无法运行测试。");
  process.exit(result.status ?? 1);
}
if (["dev", "backup", "restore", "owner-init", "owner-password", "auth-unlock"].includes(command)) {
  // 合成启动只透传可校验的合成目录与 KuiSense 本地联调 token；不携带模型密钥或其他生产配置。
  const env = { NODE_ENV: "development", APP_MODE: "synthetic" };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "DATA_ROOT", "KUISENSE_DEVICE_TOKEN", "KUISENSE_MCP_READ_TOKEN"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  if (command === "dev") run("apps/backend/dist/server.js", [], env);
  else if (["owner-init", "owner-password", "auth-unlock"].includes(command)) run("apps/backend/dist/auth/cli.js", [command], env);
  else run("apps/backend/dist/storage/cli.js", [command, ...args], env);
}
if (command === "start") run("apps/backend/dist/server.js", [], { ...process.env, NODE_ENV: "production" });
if (command === "check") run("apps/backend/dist/check.js");

if(privateCommands.includes(command)){
  if(process.env.APP_MODE!=="private") fail("私人维护必须显式设置APP_MODE=private。");
  const operation=command.slice("private-".length);
  if(["owner-setup","activate","check-runtime"].includes(operation)) run("apps/backend/dist/runtime/cli.js",[operation]);
  else if(["owner-password","auth-unlock"].includes(operation)) run("apps/backend/dist/auth/cli.js",[operation]);
  else run("apps/backend/dist/storage/cli.js",[operation,...args]);
}
