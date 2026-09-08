import { build, context } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
const watch = process.argv.includes("--watch");
mkdirSync("dist/renderer", { recursive: true }); mkdirSync("dist/cli", { recursive: true });
const common = { bundle: true, sourcemap: true, logLevel: "info", target: "es2022" };
const jobs = [
  { ...common, entryPoints: ["src/main/index.ts"], platform: "node", format: "cjs", outfile: "dist/main/index.js", external: ["electron"] },
  { ...common, entryPoints: ["src/main/preload.ts"], platform: "node", format: "cjs", outfile: "dist/main/preload.js", external: ["electron"] },
  { ...common, entryPoints: ["src/renderer/index.tsx"], platform: "browser", format: "iife", outfile: "dist/renderer/index.js", jsx: "automatic", jsxImportSource: "preact" },
  { ...common, entryPoints: ["src/renderer/glitch-page.ts"], platform: "browser", format: "iife", outfile: "dist/renderer/glitch-page.js" },
  { ...common, entryPoints: ["src/cli/mscript.ts"], platform: "node", format: "cjs", outfile: "dist/cli/mscript.js", banner: { js: "#!/usr/bin/env node" } },
  { ...common, entryPoints: ["src/renderer/outro-page.ts"], platform: "browser", format: "iife", outfile: "dist/renderer/outro-page.js" },
];
cpSync("src/renderer/static", "dist/renderer", { recursive: true });
if (watch) { for (const j of jobs) (await context(j)).watch(); }
else { await Promise.all(jobs.map(build)); }
