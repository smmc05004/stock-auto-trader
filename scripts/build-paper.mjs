import { build } from "esbuild";

await build({
  entryPoints: ["scripts/paper-probe.ts", "scripts/paper-status.ts", "scripts/paper-cycle.ts"],
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
});
