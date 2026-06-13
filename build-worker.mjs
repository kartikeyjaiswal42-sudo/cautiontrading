import esbuild from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["worker-boot.js"],
  outfile: "dist/worker.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external: ["cloudflare:node", "cloudflare:workers"],
  logLevel: "info",
});

console.log("Built dist/worker.mjs");
