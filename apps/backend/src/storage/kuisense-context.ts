import type Database from "better-sqlite3";
import { requireCondition } from "./errors.js";

export interface KuiSenseContextRecord {
  readonly schemaVersion: 1;
  readonly receivedAt: number;
  readonly payloadJson: string;
}

export interface KuiSenseContextAccess {
  replace(record: KuiSenseContextRecord): void;
  latest(): KuiSenseContextRecord | undefined;
}

export function kuisenseContextAccess(
  db: Database.Database,
  write: <T>(operation: () => T) => T,
  check: () => void,
): KuiSenseContextAccess {
  return {
    replace(record) {
      write(() => {
        db.prepare(`
          INSERT INTO kuisense_latest_context(slot,schema_version,received_at,payload_json)
          VALUES(1,?,?,?)
          ON CONFLICT(slot) DO UPDATE SET
            schema_version=excluded.schema_version,
            received_at=excluded.received_at,
            payload_json=excluded.payload_json
        `).run(record.schemaVersion, record.receivedAt, record.payloadJson);
      });
    },
    latest() {
      check();
      const row = db.prepare("SELECT schema_version,received_at,payload_json FROM kuisense_latest_context WHERE slot=1").get() as
        | { schema_version: number; received_at: number; payload_json: string }
        | undefined;
      if (!row) return undefined;
      requireCondition(row.schema_version === 1 && Number.isSafeInteger(row.received_at) && row.received_at >= 0 && typeof row.payload_json === "string", "KUISENSE_CONTEXT_INVALID");
      return { schemaVersion: 1, receivedAt: row.received_at, payloadJson: row.payload_json };
    },
  };
}
