import type { RunEvent, RunStatus } from "@kuinest/contracts";
export interface EventPage { lastSequence: number; status: RunStatus; event?: RunEvent; }
export interface EventStorage {
  // 一次只取一条，限制读取和输出占用；元数据与事件处于同一数据库快照。
  read(ownerId: string, runId: string, cursor: number): EventPage;
  prune(now: number): number;
}
export const terminal = (status: RunStatus): boolean => !["accepted", "running"].includes(status);
