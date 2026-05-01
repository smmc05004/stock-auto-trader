import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  OrderRequest,
  OrderResult,
  OrderSafetyCheck,
  TradingSignal,
} from "@/lib/types/trading";

function getAuditLogPath() {
  return process.env.AUDIT_LOG_PATH ?? path.join(process.cwd(), "data", "audit-log.jsonl");
}

export type AuditLogEvent =
  | {
      type: "strategy_evaluated";
      strategyName: string;
      symbol: string;
      signal: TradingSignal;
    }
  | {
      type: "order_blocked";
      strategyName: string;
      symbol: string;
      order: OrderRequest;
      safetyCheck: OrderSafetyCheck;
    }
  | {
      type: "order_requested";
      strategyName: string;
      symbol: string;
      order: OrderRequest;
      safetyCheck: OrderSafetyCheck;
      result: OrderResult;
    };

export type StoredAuditLogEvent = AuditLogEvent & {
  id: string;
  timestamp: string;
};

function createEventId() {
  return `audit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function appendAuditLog(event: AuditLogEvent) {
  const storedEvent: StoredAuditLogEvent = {
    ...event,
    id: createEventId(),
    timestamp: new Date().toISOString(),
  };

  const auditLogPath = getAuditLogPath();

  await mkdir(path.dirname(auditLogPath), { recursive: true });
  await writeFile(auditLogPath, `${JSON.stringify(storedEvent)}\n`, {
    flag: "a",
    mode: 0o600,
  });

  return storedEvent;
}

export async function readAuditLog(limit = 100) {
  const auditLogPath = getAuditLogPath();
  const raw = await readFile(auditLogPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }

    throw error;
  });

  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line) as StoredAuditLogEvent);
}
