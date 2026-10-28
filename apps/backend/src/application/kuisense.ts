import { createHash, timingSafeEqual } from "node:crypto";
import type { Clock } from "../ports.js";
import type { KuiSenseContextAccess } from "../storage/kuisense-context.js";
import type { KuiSenseContextPacket, KuiSenseUploadReceipt } from "@kuinest/contracts";
import { ApplicationError, ensure } from "./errors.js";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class KuiSenseService {
  readonly #access: KuiSenseContextAccess;
  readonly #tokenDigest: Buffer;
  readonly #clock: Clock;

  constructor(access: KuiSenseContextAccess, token: string, clock: Clock) {
    this.#access = access;
    this.#tokenDigest = digest(token);
    this.#clock = clock;
  }

  authorize(authorization: string | undefined): void {
    const candidate = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? "";
    const validShape = candidate.length > 0 && candidate.length <= 512;
    const same = validShape && timingSafeEqual(digest(candidate), this.#tokenDigest);
    ensure(same, "DEVICE_AUTH_INVALID");
  }

  upload(packet: KuiSenseContextPacket): KuiSenseUploadReceipt {
    const payloadJson = JSON.stringify(packet);
    ensure(typeof payloadJson === "string" && packet.schema_version === 1, "INPUT_INVALID");
    const receivedAt = this.#clock.now();
    this.#access.replace({ schemaVersion: 1, receivedAt, payloadJson });
    return { status: "ok", received_at: new Date(receivedAt).toISOString() };
  }

  latest(): KuiSenseContextPacket {
    const record = this.#access.latest();
    ensure(record, "NOT_FOUND");
    try {
      const parsed = JSON.parse(record.payloadJson) as unknown;
      ensure(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { schema_version?: unknown }).schema_version === 1, "SERVICE_NOT_READY");
      return parsed as KuiSenseContextPacket;
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      ensure(false, "SERVICE_NOT_READY");
    }
  }
}
