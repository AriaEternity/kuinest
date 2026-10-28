import { KuiSenseService } from "./application/kuisense.js";
import { RuntimeBackups } from "./runtime/backups.js";
import { join } from "node:path";
import { DeepSeekProvider } from "./providers/deepseek.js";
import { thinkingPolicy } from "./providers/policy.js";
import { privatePath, privateDatabase, secretText } from "./runtime/files.js";
import { readBinding, digest } from "./runtime/binding.js";
import { CharacterRuntime } from "./context/runtime.js";
import { RunFailure } from "./conversations/types.js";
import { EventStreams } from "./http/routes/events.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { loadConfig, readConfigEnvironment } from "./config.js";
import type { BackendPorts } from "./ports.js";
import { SqliteStorage } from "./storage/storage.js";
import { RunService } from "./conversations/service.js";
import { mockProvider } from "./providers/mock.js";
import { restrictedTools } from "./tools/registry.js";
import type { SearchProvider } from "./tools/search.js";
import { Scheduler } from "./scheduler/tick.js";
import { ApiServices } from "./application/service.js";
import { loadSyntheticKey } from "./auth/secrets.js";
import { requireCondition } from "./storage/errors.js";

export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
export function foundationPorts(): BackendPorts {
  return {
    clock: { now: () => Date.now() }, ids: { next: () => randomUUID() },
    provider: { async *stream() { throw new Error("PROVIDER_UNAVAILABLE"); } },
    storage: {
      async getReadiness() { return { connected: false, schemaCompatible: false, sqliteVersion: null, lease: { held: false, expiresAt: 0 } }; },
      async close() {},
    },
  };
}
export async function startServer(env: Readonly<Record<string, string | undefined>> = process.env, services: { search?: SearchProvider; transport?: typeof fetch } = {}) {
  const search = services.search?.enabled === false ? undefined : services.search;
  const config = loadConfig(readConfigEnvironment(env), projectRoot);
  const binding = config.mode === "private" ? readBinding(config.dataRoot,config.runtimeBindingSha256) : undefined;
  if (binding) { requireCondition(config.allowLiveModel,"LIVE_MODEL_NOT_ENABLED"); privateDatabase(config.dataRoot); }
  const ports = foundationPorts();
  const storage = new SqliteStorage({ dataRoot: config.dataRoot, instanceId: ports.ids.next(), clock: ports.clock });
  let app: ReturnType<typeof createApp>;
  let runs: RunService;
  let scheduler: Scheduler | undefined;
  let backups: RuntimeBackups | undefined;
  let credential = "";
  try {
    const runtime = binding ? storage.runtimeAccess().verify(binding) : undefined;
    if(runtime) requireCondition(runtime.profile.options.allowedOrigin === config.allowedProviderOrigin && new URL(runtime.profile.endpoint!).origin === config.allowedProviderOrigin,"RUNTIME_ORIGIN_MISMATCH");
    const keyText = config.cursorHmacKeyFile ? secretText(config.cursorHmacKeyFile,1024) : config.cursorHmacKey;
    if(binding) requireCondition(!!keyText && /^[A-Za-z0-9+/]+={0,2}$/.test(keyText) && Buffer.from(keyText,"base64").length>=32 && Buffer.from(keyText,"base64").toString("base64")===keyText,"PRIVATE_SECRET_INVALID");
    if(binding) credential = secretText(config.providerApiKeyFile!);
    const api = new ApiServices(storage.apiAccess(), config, ports.clock, ports.ids, binding ? Buffer.from(keyText!,"base64") : loadSyntheticKey(config.dataRoot));
    const kuisense = config.kuisenseDeviceToken ? new KuiSenseService(storage.kuisenseContextAccess(), config.kuisenseDeviceToken, ports.clock) : undefined;
    const runStore = storage.runAccess({ context: true, webSearch: !!search });
    const context = new CharacterRuntime({ storage: storage.contextAccess(), protocol: storage.protocolAccess(), toolsForRun: (claim, input) => { if(binding) requireCondition(claim.ownerId===binding.owner&&input.versionId===binding.version&&digest(input.config)===binding.configSha256,"RUNTIME_BINDING_CHANGED"); return restrictedTools(claim, input, { control: runStore.control, memory: storage.memoryAccess(), review: storage.memoryReviewAccess(), clock: ports.clock, ids: ports.ids, ...(search ? { search } : {}) }); }, clock: ports.clock, ids: ports.ids,
      resolve(profile) {
        if(binding) {
          requireCondition(digest(profile)===binding.profileSha256,"RUNTIME_BINDING_CHANGED");
          return new DeepSeekProvider({mode:"private",endpoint:profile.endpoint!,allowedOrigin:config.allowedProviderOrigin!,model:profile.model,...(profile.options.wireFormat===undefined?{}:{wireFormat:profile.options.wireFormat as "deepseek"|"mimo"}),maxTokens:Number(profile.options.maxTokens??32768),...thinkingPolicy(profile.options),...(profile.options.imageInput===undefined?{}:{imageInput:profile.options.imageInput as boolean}),allowLive:true},()=>credential,services.transport);
        }
        if (profile.provider !== "mock" || profile.model !== "synthetic" || profile.status !== "synthetic") throw new RunFailure("PROFILE_INVALID"); return mockProvider;
      } });
    runs = new RunService(runStore, api.queries, ports.clock, ports.ids, config, mockProvider, { context, webSearch: !!search });
    if(config.enableScheduler) scheduler = new Scheduler(storage.schedulerAccess(), ports.clock, ports.ids, () => runs.worker.wake(), () => { void app?.close(); });
    const events = new EventStreams(storage.eventAccess(), wake => storage.subscribeCommits(wake), api.sessions, ports.clock);
    if(binding && config.enableBackups)backups=new RuntimeBackups(storage,config.dataRoot,binding,config.enableBackupRetention,ok=>{if(ok)app.log.info({code:"BACKUP_COMPLETED"},"私人备份已核验。");else app.log.error({code:"BACKUP_FAILED"},"私人备份未完成，请检查受控运行目录。");});
    const lifecycle = { async getReadiness() { return { ...await storage.getReadiness(), runtimeReady: runs.ready && (scheduler?.ready ?? true) && (backups?.ready ?? true) }; }, close: async () => { credential=""; await backups?.close(); await storage.close(); } };
    app = createApp(config, { ...ports, storage: lifecycle }, { api, runs, events, ...(scheduler?{scheduler}:{}), ...(kuisense?{kuisense}:{}), memoryReview: storage.memoryReviewAccess() });
  }
  catch (error) { credential=""; await storage.close(); throw error; }
  storage.startRenewal(() => { void app.close().catch(() => { process.exitCode = 1; }); });
  try { await app.listen({ host: config.host, port: config.port }); runs.start(); scheduler?.start(); backups?.start(); }
  catch { await app.close(); throw new Error("START_FAILED"); }
  return app;
}
async function main(): Promise<void> {
  try {
    const app = await startServer();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => { process.stderr.write('{"error":{"code":"SHUTDOWN_TIMEOUT"}}\n'); process.exit(1); }, 30000);
      deadline.unref();
      try { await app.close(); }
      catch { process.exitCode = 1; }
      finally { clearTimeout(deadline); }
    };
    process.once("SIGINT", () => { void stop(); });
    process.once("SIGTERM", () => { void stop(); });
    app.log.info({ code: process.env.APP_MODE === "private" ? "PRIVATE_RUN_API_STARTED" : "SYNTHETIC_RUN_API_STARTED" }, "后端服务已启动。");
  } catch {
    process.stderr.write('{"error":{"code":"START_FAILED","message":"启动失败，请检查配置和本地端口。"}}\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
