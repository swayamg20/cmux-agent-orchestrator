import esbuild from "esbuild";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";
const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`)
];

const options = {
  banner: { js: "/* cmux Agent Orchestrator: generated bundle */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external,
  format: "cjs",
  target: "es2021",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  outfile: "main.js"
};

if (production) {
  await esbuild.build(options);
} else {
  const context = await esbuild.context(options);
  await context.watch();
}
