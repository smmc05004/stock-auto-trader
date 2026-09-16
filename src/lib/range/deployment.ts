import { readFileSync } from "node:fs";

export type DeploymentGate = { allowed: boolean; reason: string; requestId?: string };
// Host-owned, read-only bind mount. A previous boot/version can never authorize buys.
export function readDeploymentGate(file: string | undefined, commit: string, bootId: string, now = Date.now()): DeploymentGate {
  if (!file) return { allowed: true, reason: "unmanaged" };
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    const allowed = value.allow === true && value.commit === commit && value.bootId === bootId &&
      Number.isFinite(value.expires) && value.expires > now && value.expires <= now + 300_000;
    return { allowed, reason: allowed ? "authorized" : "deployment_paused", requestId: typeof value.requestId === "string" ? value.requestId : undefined };
  } catch { return { allowed: false, reason: "deployment_gate_unavailable" }; }
}
