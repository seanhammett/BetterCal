import * as esbuild from "esbuild";

const options = {
  entryPoints: ["src/main.ts", "src/background.ts"],
  bundle: true,
  outdir: "dist",
  format: "esm",
  target: "chrome116",
  sourcemap: false,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching for changes…");
} else {
  await esbuild.build(options);
}
