export class StorageError extends Error {
  constructor(readonly code: string) { super("存储操作未完成，请检查安全状态码。"); this.name = "StorageError"; }
}
export function requireCondition(ok: unknown, code: string): asserts ok {
  if (!ok) throw new StorageError(code);
}
