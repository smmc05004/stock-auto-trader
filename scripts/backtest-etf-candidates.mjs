import { buildSync } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(path.join(tmpdir(), "etf-candidate-report-"));
try {
  const outfile = path.join(temp, "backtest.mjs");
  buildSync({
    absWorkingDir: root,
    entryPoints: ["scripts/backtest-etf-candidates.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    tsconfig: "tsconfig.json",
  });
  const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
    cwd: root, stdio: "inherit", env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
