import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAuditLog, readAuditLog } from "@/lib/storage/auditLog";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "stock-auto-trader-audit-"));
  process.env.AUDIT_LOG_PATH = path.join(tempDir, "audit-log.jsonl");
});

afterEach(async () => {
  delete process.env.AUDIT_LOG_PATH;
  await rm(tempDir, { recursive: true, force: true });
});

describe("auditLog", () => {
  it("appends and reads audit log events", async () => {
    await appendAuditLog({
      type: "strategy_evaluated",
      strategyName: "sample-momentum",
      symbol: "005930",
      signal: {
        symbol: "005930",
        action: "hold",
        confidence: 0.2,
        reason: "No threshold was met.",
      },
    });

    const events = await readAuditLog();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "strategy_evaluated",
      strategyName: "sample-momentum",
      symbol: "005930",
    });
    expect(events[0].id).toMatch(/^audit-/);
  });

  it("returns only the requested number of recent events", async () => {
    await appendAuditLog({
      type: "strategy_evaluated",
      strategyName: "first",
      symbol: "005930",
      signal: {
        symbol: "005930",
        action: "hold",
        confidence: 0.2,
        reason: "First",
      },
    });
    await appendAuditLog({
      type: "strategy_evaluated",
      strategyName: "second",
      symbol: "005930",
      signal: {
        symbol: "005930",
        action: "hold",
        confidence: 0.2,
        reason: "Second",
      },
    });

    const events = await readAuditLog(1);

    expect(events).toHaveLength(1);
    expect(events[0].strategyName).toBe("second");
  });
});
