const esbuild = require("esbuild");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// The Shogo SDK pulls in optional react / mobx code paths we never execute
// (we only use the LLM gateway). Alias them to harmless stubs so the bundled
// require() calls resolve at runtime instead of crashing extension activation.
const stub = path.resolve(__dirname, "stubs/empty.js");
const stubPlugin = {
  name: "stub-unused",
  setup(build) {
    build.onResolve({ filter: /^(react|react-dom|react\/jsx-runtime|mobx)$/ }, () => ({
      path: stub,
    }));
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    plugins: [stubPlugin],
    logLevel: "info",
  });

  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
