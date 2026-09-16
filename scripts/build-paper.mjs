import { build } from "esbuild";

await build({
  entryPoints: ["scripts/paper-probe.ts", "scripts/paper-status.ts", "scripts/paper-cycle.ts", "scripts/range-runner.ts", "scripts/range-feed-check.ts", "scripts/range-repair-preflight.ts"],
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
});
