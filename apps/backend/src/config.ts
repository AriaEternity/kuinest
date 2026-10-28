import { isAbsolute, relative, resolve, sep } from "node:path";
import { isIP } from "node:net";

export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
  constructor() { super("启动配置无效，请检查工程配置说明。"); this.name = "ConfigError"; }
}
const keys = ["NODE_ENV", "APP_MODE", "DATA_ROOT", "BIND_HOST", "PORT", "PUBLIC_ORIGIN", "CURSOR_HMAC_KEY", "ALLOW_LIVE_MODEL", "ALLOWED_PROVIDER_ORIGIN", "CURSOR_HMAC_KEY_FILE", "PROVIDER_API_KEY_FILE", "RUNTIME_BINDING_SHA256", "TRUST_PROXY", "ENABLE_SCHEDULER", "ENABLE_BACKUPS", "ENABLE_BACKUP_RETENTION", "KUISENSE_DEVICE_TOKEN", "KUISENSE_MCP_READ_TOKEN"] as const;
type ConfigKey = typeof keys[number];
type Input = Readonly<Record<string, string | undefined>>;
export interface AppConfig {
  readonly environment: "development" | "test" | "production";
  readonly mode: "synthetic" | "private";
  readonly dataRoot: string;
  readonly host: string;
  readonly port: number;
  readonly publicOrigin: string;
  readonly allowLiveModel: boolean;
  readonly cursorHmacKeyFile?: string;
  readonly providerApiKeyFile?: string;
  readonly runtimeBindingSha256?: string;
  readonly trustProxy: boolean;
  readonly enableScheduler: boolean;
  readonly enableBackups: boolean;
  readonly enableBackupRetention: boolean;
  readonly cursorHmacKey?: string;
  readonly allowedProviderOrigin?: string;
  readonly kuisenseDeviceToken?: string;
  readonly kuisenseMcpReadToken?: string;
  readonly limits: typeof limits;
}
const limits = Object.freeze({
  bodyBytes: 192 * 1024, messageCharacters: 32000, messageBytes: 128 * 1024,
  apiPerMinute: 120, perConversationQueue: 4, globalQueue: 16, activeRuns: 1,
  leaseRenewMs: 5000, leaseLifetimeMs: 30000, sqliteBusyMs: 5000,
  historyPage: 50, changesPage: 100, maxPage: 100,
  eventConnections: 4, eventBufferBytes: 256 * 1024, eventHeartbeatMs: 15000, eventBackpressureMs: 30000,
  eventRetentionMs: 7 * 86400000, providerHeadersMs: 30000, providerIdleMs: 180000, runTimeoutMs: 900000,
  providerRetries: 0, providerEventBytes: 2 * 1024 * 1024, providerArchiveBytes: 16 * 1024 * 1024,
  providerCalls: 8, compactionCalls: 1, toolsPerCall: 8, toolsPerRun: 16,
  toolReadMs: 5000, toolSearchMs: 15000, toolResultBytes: 32 * 1024,
  sessionMaxMs: 7 * 86400000, sessionIdleMs: 86400000, loginPerIpMinute: 5,
  loginGlobalFailures: 10, loginGlobalWindowMs: 600000, loginCooldownMs: 600000,
  passwordConcurrency: 1, schedulerTickMs: 15000, shutdownMs: 30000,
});
function invalid(): never { throw new ConfigError(); }
function origin(value: string, https: boolean): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || value !== url.origin) invalid();
    if (https ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol)) invalid();
    return url.origin;
  } catch { return invalid(); }
}
function contained(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === "" || (!part.startsWith(".." + sep) && part !== ".." && !isAbsolute(part));
}
// 系统环境不是应用配置对象；仅选择声明过的键，拒绝本应用前缀的拼写错误。
// 合成模式不读取模型密钥及游标签名密钥。
export function readConfigEnvironment(env: Input): Input {
  for (const key of Object.keys(env))
    if (/^(APP_|DATA_|BIND_|PUBLIC_|CURSOR_|ALLOW_|ALLOWED_PROVIDER_|DEEPSEEK_|PROVIDER_|RUNTIME_|TRUST_|ENABLE_|KUISENSE_)/.test(key)
      && !keys.includes(key as ConfigKey) && key !== "DEEPSEEK_API_KEY") invalid();
  const result: Record<string, string | undefined> = {};
  for (const key of keys) {
    if (["CURSOR_HMAC_KEY", "CURSOR_HMAC_KEY_FILE", "PROVIDER_API_KEY_FILE"].includes(key) && env.APP_MODE !== "private") continue;
    result[key] = env[key];
  }
  return result;
}
export function loadConfig(input: Input, projectRoot: string): AppConfig {
  if (Object.keys(input).some(key => !keys.includes(key as ConfigKey))) invalid();
  const environment = input.NODE_ENV ?? "development";
  const mode = input.APP_MODE ?? (environment === "production" ? invalid() : "synthetic");
  if (!["development", "test", "production"].includes(environment) || !["synthetic", "private"].includes(mode)) invalid();
  if (environment === "production" && mode !== "private") invalid();
  const host = input.BIND_HOST ?? "127.0.0.1";
  if (!isIP(host) || !["127.0.0.1", "::1"].includes(host)) invalid();
  const portValue = input.PORT ?? "4317";
  if (!/^[1-9][0-9]{0,4}$/.test(portValue)) invalid();
  const port = Number(portValue);
  if (port > 65535) invalid();
  const syntheticRoot = resolve(projectRoot, "runtime/dev-synthetic");
  const dataRoot = mode === "synthetic" ? (input.DATA_ROOT ?? syntheticRoot) : input.DATA_ROOT;
  if (!dataRoot || !isAbsolute(dataRoot) || dataRoot.includes("\0")) invalid();
  if (mode === "synthetic" && !contained(syntheticRoot, resolve(dataRoot))) invalid();
  const normalizedRoot = resolve(dataRoot);
  if (mode === "private") {
    const forbidden = [resolve(projectRoot, "apps/frontend"), resolve(projectRoot, "public"), resolve(projectRoot, "dist"), resolve(projectRoot, "runtime/dev-synthetic")];
    if (forbidden.some(dir => contained(dir, normalizedRoot) || contained(normalizedRoot, dir))) invalid();
  }
  const publicOrigin = origin(input.PUBLIC_ORIGIN ?? (mode === "private" ? invalid() : "http://127.0.0.1:4317"), mode === "private");
  if (mode === "synthetic" && !["127.0.0.1", "[::1]"].includes(new URL(publicOrigin).hostname)) invalid();
  if (input.ALLOW_LIVE_MODEL !== undefined && !["true", "false"].includes(input.ALLOW_LIVE_MODEL)) invalid();
  const allowLiveModel = input.ALLOW_LIVE_MODEL === "true";
  if (allowLiveModel && mode !== "private") invalid();
  const providerOrigin = input.ALLOWED_PROVIDER_ORIGIN === undefined ? undefined : origin(input.ALLOWED_PROVIDER_ORIGIN, mode === "private");
  if (providerOrigin && mode === "synthetic" && !["127.0.0.1", "[::1]"].includes(new URL(providerOrigin).hostname)) invalid();
  const key = mode === "private" ? input.CURSOR_HMAC_KEY : undefined;
  const cursorFile = mode === "private" ? input.CURSOR_HMAC_KEY_FILE : undefined;
  const providerFile = mode === "private" ? input.PROVIDER_API_KEY_FILE : undefined;
  for (const file of [cursorFile, providerFile]) if (file !== undefined && (!isAbsolute(file) || file.includes("\0"))) invalid();
  if (key && cursorFile) invalid();
  if (input.RUNTIME_BINDING_SHA256 !== undefined && !/^[0-9a-f]{64}$/.test(input.RUNTIME_BINDING_SHA256)) invalid();
  if (input.TRUST_PROXY !== undefined && !["false", "loopback"].includes(input.TRUST_PROXY)) invalid();
  for(const k of ["ENABLE_BACKUPS","ENABLE_BACKUP_RETENTION"]) if(input[k]!==undefined && !["true","false"].includes(input[k]!)) invalid();
  if(mode!=="private" && (input.ENABLE_BACKUPS==="true" || input.ENABLE_BACKUP_RETENTION==="true")) invalid();
  if(input.ENABLE_BACKUPS==="false" && input.ENABLE_BACKUP_RETENTION==="true") invalid();
  if (input.ENABLE_SCHEDULER !== undefined && !["true", "false"].includes(input.ENABLE_SCHEDULER)) invalid();
  if (mode === "synthetic" && (input.TRUST_PROXY === "loopback" || input.RUNTIME_BINDING_SHA256 !== undefined)) invalid();
  if (allowLiveModel && (!providerOrigin || !providerFile || !input.RUNTIME_BINDING_SHA256)) invalid();
  if (mode === "private" && !cursorFile && (!key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key) || Buffer.from(key, "base64").length < 32 || Buffer.from(key, "base64").toString("base64") !== key)) invalid();
  const kuisenseDeviceToken = input.KUISENSE_DEVICE_TOKEN;
  if (kuisenseDeviceToken !== undefined && (Buffer.byteLength(kuisenseDeviceToken, "utf8") < 32 || Buffer.byteLength(kuisenseDeviceToken, "utf8") > 512 || /\s/.test(kuisenseDeviceToken))) invalid();
  const kuisenseMcpReadToken = input.KUISENSE_MCP_READ_TOKEN;
  if (kuisenseMcpReadToken !== undefined && (Buffer.byteLength(kuisenseMcpReadToken, "utf8") < 32 || Buffer.byteLength(kuisenseMcpReadToken, "utf8") > 512 || /\s/.test(kuisenseMcpReadToken)
    || kuisenseMcpReadToken === kuisenseDeviceToken || kuisenseMcpReadToken === key)) invalid();
  return Object.freeze({
    environment: environment as AppConfig["environment"], mode: mode as AppConfig["mode"],
    dataRoot: normalizedRoot, host, port, publicOrigin, allowLiveModel,
    enableBackups: mode==="private" && input.ENABLE_BACKUPS!=="false", enableBackupRetention: input.ENABLE_BACKUP_RETENTION==="true",
    trustProxy: input.TRUST_PROXY === "loopback", enableScheduler: input.ENABLE_SCHEDULER === "true" || mode === "synthetic" && input.ENABLE_SCHEDULER !== "false",
    ...(cursorFile ? {cursorHmacKeyFile:cursorFile} : {}), ...(providerFile ? {providerApiKeyFile:providerFile} : {}),
    ...(input.RUNTIME_BINDING_SHA256 ? {runtimeBindingSha256:input.RUNTIME_BINDING_SHA256} : {}),
    ...(key === undefined ? {} : { cursorHmacKey: key }),
    ...(providerOrigin === undefined ? {} : { allowedProviderOrigin: providerOrigin }),
    ...(kuisenseDeviceToken === undefined ? {} : { kuisenseDeviceToken }),
    ...(kuisenseMcpReadToken === undefined ? {} : { kuisenseMcpReadToken }), limits,
  });
}
